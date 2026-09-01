/**
 * Live block changes, read out of the save files.
 *
 * The bridge asks the server to `save-all flush` on a guarded timer and then says
 * `reload`. This module works out what actually changed and hands back only that — the
 * whole point being that re-reading a 12 MB region and re-meshing 1,360 sections every
 * few seconds is not a live view, it is a stutter.
 *
 * Two levels of narrowing, both free:
 *
 * 1. THE REGION HEADER ALREADY KNOWS. An Anvil region's first 8 KB is a location table
 *    and a timestamp table, one entry per chunk. Minecraft rewrites the timestamp of
 *    every chunk it saves. So an HTTP Range request for bytes 0-8191 — 8 KB against
 *    12 MB — says exactly which of the 1024 chunks moved, and a second Range request
 *    fetches just those chunks' sectors.
 *
 * 2. A SAVED CHUNK IS MOSTLY UNCHANGED. A turtle stepping one block rewrites its whole
 *    chunk column, but only one or two of its ~24 sections differ. `diffSections`
 *    compares the decoded section arrays against what is already loaded, so a turtle
 *    moving re-meshes 1-2 sections, not 24 and not 1,360.
 *
 * Range support is not assumed. A server that ignores `Range` and returns the whole file
 * with 200 still works — the response is sliced client-side — it is just not as cheap.
 */

import {
  SECTOR, decodeChunkPayload, parseRegionHeader, type ChunkEntry,
} from '../core/region.js';
import type { NbtCompound } from '../core/nbt.js';
import type { ChunkColumn } from '../render/world.js';

/** Fetch `[start, end]` inclusive of a region file, or null if it is unavailable. */
export type RangeFetch = (
  name: string,
  start: number,
  end: number,
) => Promise<Uint8Array | null>;

export interface ChangedChunk {
  region: string;
  /** world chunk coordinates */
  cx: number;
  cz: number;
  root: NbtCompound;
}

interface Slot {
  timestamp: number;
  sectorOffset: number;
  sectorCount: number;
}

const HEADER_BYTES = SECTOR * 2;

function slotIndex(e: ChunkEntry): number {
  return e.localX + e.localZ * 32;
}

function sameSlot(a: Slot | undefined, b: Slot): boolean {
  return !!a
    && a.timestamp === b.timestamp
    && a.sectorOffset === b.sectorOffset
    && a.sectorCount === b.sectorCount;
}

/**
 * Tracks the header of each watched region and reports chunks whose stored bytes moved.
 *
 * `prime()` records the current state without reporting anything; it exists so the
 * initial full load and the first poll do not race — without it, a change landing between
 * the two would be baked into the first snapshot and never reported.
 */
export class RegionWatcher {
  private slots = new Map<string, Map<number, Slot>>();

  /** Chunks whose sectors could not be fetched or decoded, by `region:cx,cz`. */
  readonly failures = new Set<string>();

  constructor(
    private fetchRange: RangeFetch,
    readonly names: readonly string[],
  ) {}

  get primed(): boolean {
    return this.slots.size > 0;
  }

  async prime(): Promise<void> {
    for (const name of this.names) await this.readHeader(name);
  }

  /** Every chunk that changed since the last call. Empty on the first call. */
  async poll(): Promise<ChangedChunk[]> {
    const out: ChangedChunk[] = [];
    for (const name of this.names) {
      const known = this.slots.get(name);
      const current = await this.readHeader(name);
      if (!current || !known) continue;
      for (const [idx, slot] of current) {
        if (sameSlot(known.get(idx), slot)) continue;
        const chunk = await this.readChunk(name, idx, slot);
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  private async readHeader(name: string): Promise<Map<number, Slot> | null> {
    const bytes = await this.fetchRange(name, 0, HEADER_BYTES - 1);
    if (!bytes || bytes.byteLength < HEADER_BYTES) return null;
    const map = new Map<number, Slot>();
    for (const e of parseRegionHeader(bytes)) {
      map.set(slotIndex(e), {
        timestamp: e.timestamp,
        sectorOffset: e.sectorOffset,
        sectorCount: e.sectorCount,
      });
    }
    this.slots.set(name, map);
    return map;
  }

  private async readChunk(name: string, idx: number, slot: Slot): Promise<ChangedChunk | null> {
    const [rx, rz] = regionCoords(name);
    const cx = rx * 32 + (idx & 31);
    const cz = rz * 32 + (idx >> 5);
    const start = slot.sectorOffset * SECTOR;
    const bytes = await this.fetchRange(name, start, start + slot.sectorCount * SECTOR - 1);
    if (!bytes) return this.fail(name, cx, cz);
    try {
      const root = decodeChunkPayload(bytes, cx, cz);
      if (!root) return this.fail(name, cx, cz);
      this.failures.delete(`${name}:${cx},${cz}`);
      return { region: name, cx, cz, root };
    } catch {
      // A chunk half-written at the instant we read it, or stored externally as .mcc.
      // Both must skip rather than abort the whole sync; the next flush re-reports it.
      return this.fail(name, cx, cz);
    }
  }

  private fail(name: string, cx: number, cz: number): null {
    this.failures.add(`${name}:${cx},${cz}`);
    return null;
  }
}

/** `r.-1.0.mca` -> [-1, 0]. */
export function regionCoords(name: string): [number, number] {
  const m = /r\.(-?\d+)\.(-?\d+)\.mc[ar]$/.exec(name);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
}

/**
 * A `RangeFetch` over HTTP.
 *
 * `cache: 'no-store'` matters: region files are rewritten every few seconds, and a cached
 * header would report "nothing changed" forever. A 200 response means the server ignored
 * the range, so the slice is done here instead.
 */
export function httpRangeFetch(base: string): RangeFetch {
  return async (name, start, end) => {
    const r = await fetch(`${base}/${encodeURIComponent(name)}`, {
      cache: 'no-store',
      headers: { Range: `bytes=${start}-${end}` },
    }).catch(() => null);
    if (!r?.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return r.status === 206 ? buf : buf.subarray(start, end + 1);
  };
}

/**
 * Which section heights actually differ between two versions of a chunk column.
 *
 * Both columns index into the same interned global palette, so comparing the id arrays
 * is a comparison of block states, not of encoding. A section present on one side only
 * counts as changed — that is a chunk gaining or losing a section, which alters the
 * geometry either way.
 */
export function diffSections(before: ChunkColumn | undefined, after: ChunkColumn): number[] {
  if (!before) return [...after.sections.keys()].sort((a, b) => a - b);
  const ys = new Set<number>([...before.sections.keys(), ...after.sections.keys()]);
  const out: number[] = [];
  for (const y of ys) {
    const a = before.sections.get(y);
    const b = after.sections.get(y);
    if (!a || !b) out.push(y);
    else if (!sameStates(a.ids, a.uniform, b.ids, b.uniform)) out.push(y);
  }
  return out.sort((a, b) => a - b);
}

function sameStates(
  aIds: Uint16Array | null,
  aUniform: number,
  bIds: Uint16Array | null,
  bUniform: number,
): boolean {
  if (!aIds && !bIds) return aUniform === bUniform;
  if (!aIds || !bIds) return false;
  if (aIds.length !== bIds.length) return false;
  for (let i = 0; i < aIds.length; i++) if (aIds[i] !== bIds[i]) return false;
  return true;
}

/**
 * The sections whose MESH is invalidated by a change at `(cx, y, cz)` — the section
 * itself plus its six neighbours.
 *
 * The neighbours are not optional. Face culling is decided by looking at the block on the
 * other side of a face, so a turtle stepping out of a section un-culls a face belonging to
 * the section it left, and re-meshing only the changed section leaves a hole.
 */
export function invalidatedSections(cx: number, y: number, cz: number): string[] {
  return [
    `${cx},${y},${cz}`,
    `${cx + 1},${y},${cz}`, `${cx - 1},${y},${cz}`,
    `${cx},${y},${cz + 1}`, `${cx},${y},${cz - 1}`,
    `${cx},${y + 1},${cz}`, `${cx},${y - 1},${cz}`,
  ];
}
