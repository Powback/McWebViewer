/**
 * Chunk streaming: fetch the chunks around the camera, nearest first, instead of the
 * whole world up front.
 *
 * The reference world is four regions, ~15 MB and ~2,500 chunks, and the previous load
 * path downloaded, decompressed and NBT-parsed all of it before the first frame — most of
 * it 300+ blocks from where the camera opens, where the renderer hides it anyway.
 *
 * THERE IS NO NEW SERVER FORMAT. An Anvil region already IS an indexed per-chunk store:
 * its first 8 KB is a table of (sector offset, sector count, timestamp) for each of its
 * 1024 chunks, and nginx honours HTTP Range requests on the file. So the "per-chunk API"
 * is `Range: bytes=0-8191` for the index, then one Range per chunk (or per run of
 * chunks) for the bytes the index points at — the same two reads the live sync has used
 * since it stopped re-downloading regions on every flush (region-sync.ts). Nothing is
 * re-encoded, and a chunk's (timestamp, offset, count) triple is its ETag: if any of the
 * three moved, the server rewrote it.
 *
 * Batching: chunks generated together are usually stored together, so wanted chunks whose
 * sectors are within `coalesceGap` bytes of each other in the same file are fetched with
 * one request and cut apart client-side — a few hundred chunks costs tens of requests,
 * not hundreds, without any server help.
 *
 * Priority is re-derived from the camera on a debounce: chunks inside `loadRadius` (in
 * chunks) that are not loaded are queued nearest-first; loaded chunks beyond
 * `unloadRadius` are handed back to the caller to drop.
 */

import {
  SECTOR, decodeChunkPayload, parseRegionHeader,
} from '../core/region.js';
import type { NbtCompound } from '../core/nbt.js';
import { regionCoords, type RangeFetch } from './region-sync.js';

export interface StreamOptions {
  /** chunks within this many chunks (horizontally) of the camera are fetched */
  loadRadius: number;
  /** loaded chunks further than this are unloaded; must exceed loadRadius */
  unloadRadius: number;
  /** parallel Range requests */
  concurrency: number;
  /** wanted chunks this close (bytes) in the same file share one request */
  coalesceGap: number;
  /** cap on one coalesced request */
  maxBatchBytes: number;
  /** the camera must move this far (blocks) before priorities are recomputed... */
  moveThreshold: number;
  /** ...and at most this often */
  debounceMs: number;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  loadRadius: 16,
  unloadRadius: 24,
  concurrency: 6,
  coalesceGap: 16 * 1024,
  maxBatchBytes: 768 * 1024,
  moveThreshold: 24,
  debounceMs: 250,
};

export interface StreamHooks {
  fetchRange: RangeFetch;
  /** A chunk arrived. `root` is the parsed chunk NBT; `cx,cz` are world chunk coords. */
  onChunk: (root: NbtCompound, cx: number, cz: number) => void;
  /** A loaded chunk left the unload radius. */
  onUnload: (cx: number, cz: number) => void;
  /** Progress, for the status line. Optional. */
  onProgress?: (s: StreamStats) => void;
  now?: () => number;
}

export interface StreamStats {
  /** chunks the region indices know about */
  indexed: number;
  loaded: number;
  queued: number;
  inFlight: number;
  /** chunks fetched and decoded since start */
  fetched: number;
  requests: number;
  bytes: number;
  failures: number;
  unloaded: number;
}

interface Slot {
  region: string;
  cx: number;
  cz: number;
  sectorOffset: number;
  sectorCount: number;
  timestamp: number;
}

interface Wanted {
  slot: Slot;
  d2: number;
}

const HEADER_BYTES = SECTOR * 2;

export function chunkId(cx: number, cz: number): number {
  return (cx + 0x2000000) * 0x4000000 + (cz + 0x2000000);
}

export class ChunkStreamer {
  private readonly opts: StreamOptions;
  /** every chunk any region header lists, by chunkId */
  private index = new Map<number, Slot>();
  private loaded = new Set<number>();
  /** chunks whose read failed since the last index refresh; not retried until then */
  private failed = new Set<number>();
  private inFlightIds = new Set<number>();
  private queue: Wanted[] = [];
  private inFlight = 0;
  private cam = { x: 0, z: 0 };
  private prioritisedAt = { x: Infinity, z: Infinity, t: -Infinity };
  private dirty = true;
  private refreshing: Promise<void> | null = null;
  private disposed = false;
  readonly stats: StreamStats = {
    indexed: 0, loaded: 0, queued: 0, inFlight: 0, fetched: 0, requests: 0, bytes: 0,
    failures: 0, unloaded: 0,
  };

  constructor(
    readonly regions: readonly string[],
    private hooks: StreamHooks,
    opts: Partial<StreamOptions> = {},
  ) {
    this.opts = { ...DEFAULT_STREAM_OPTIONS, ...opts };
    if (this.opts.unloadRadius <= this.opts.loadRadius) {
      this.opts.unloadRadius = this.opts.loadRadius + 4;
    }
  }

  /** Read every region's index, then start fetching around `(x, z)` (block coords). */
  async start(x: number, z: number): Promise<void> {
    this.cam = { x, z };
    await this.refreshIndex();
    this.prioritise(true);
  }

  /**
   * Re-read the 8 KB headers. Called after every live flush: a rewritten chunk moves in
   * the file, and a fetch through a stale index reads someone else's bytes. Chunks that
   * failed earlier become eligible again. Concurrent callers share one refresh.
   */
  refreshIndex(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const results = await Promise.all(this.regions.map(async (name) => {
        const bytes = await this.hooks.fetchRange(name, 0, HEADER_BYTES - 1).catch(() => null);
        if (!bytes || bytes.byteLength < HEADER_BYTES) return { name, entries: null };
        return { name, entries: parseRegionHeader(bytes) };
      }));
      if (this.disposed) return;
      const next = new Map<number, Slot>();
      for (const { name, entries } of results) {
        if (!entries) {
          // Keep what we knew of an unreadable region rather than forgetting it exists.
          for (const [id, slot] of this.index) if (slot.region === name) next.set(id, slot);
          continue;
        }
        const [rx, rz] = regionCoords(name);
        for (const e of entries) {
          const cx = rx * 32 + e.localX;
          const cz = rz * 32 + e.localZ;
          next.set(chunkId(cx, cz), {
            region: name, cx, cz,
            sectorOffset: e.sectorOffset, sectorCount: e.sectorCount, timestamp: e.timestamp,
          });
        }
      }
      this.index = next;
      this.failed.clear();
      this.dirty = true;
      this.stats.indexed = next.size;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Where the camera is now, in blocks. Call every frame; the work happens only when it
   * has moved `moveThreshold` since the last prioritisation and `debounceMs` have passed,
   * or when something (a refresh, an unload, a finished fetch) marked the queue dirty.
   */
  setCamera(x: number, z: number): void {
    this.cam = { x, z };
    const now = this.now();
    const moved = Math.hypot(x - this.prioritisedAt.x, z - this.prioritisedAt.z);
    if (moved > this.opts.moveThreshold && now - this.prioritisedAt.t > this.opts.debounceMs) {
      this.prioritise(true);
    } else if (this.dirty) {
      this.prioritise(false);
    }
  }

  /**
   * True when meshing a section of `(cx, cz)` should not wait on this column: it is loaded,
   * or the world has no such chunk, or it is outside the load radius (so it will not
   * arrive), or it could not be read. Neighbour sections are meshed only once all four
   * neighbours are settled, because face culling and smooth lighting read across the
   * column boundary and a mesh built against a not-yet-loaded neighbour lights that edge
   * as open sky.
   */
  isSettled(cx: number, cz: number): boolean {
    const id = chunkId(cx, cz);
    if (this.loaded.has(id) || this.failed.has(id)) return true;
    const slot = this.index.get(id);
    if (!slot) return true;
    return !this.within(slot, this.opts.loadRadius);
  }

  isLoaded(cx: number, cz: number): boolean {
    return this.loaded.has(chunkId(cx, cz));
  }

  /** A chunk this streamer did not fetch has been loaded by someone else (the live sync). */
  noteLoaded(cx: number, cz: number): void {
    const id = chunkId(cx, cz);
    if (!this.loaded.has(id)) {
      this.loaded.add(id);
      this.stats.loaded = this.loaded.size;
    }
  }

  /** The caller dropped a chunk (a re-bake, a manual clear); it becomes fetchable again. */
  noteUnloaded(cx: number, cz: number): void {
    if (this.loaded.delete(chunkId(cx, cz))) {
      this.stats.loaded = this.loaded.size;
      this.dirty = true;
    }
  }

  get idle(): boolean {
    return this.queue.length === 0 && this.inFlight === 0 && !this.refreshing;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  // -------------------------------------------------------------------------

  private now(): number {
    return this.hooks.now ? this.hooks.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  private within(slot: Slot, radiusChunks: number): boolean {
    const dx = slot.cx + 0.5 - this.cam.x / 16;
    const dz = slot.cz + 0.5 - this.cam.z / 16;
    return dx * dx + dz * dz <= radiusChunks * radiusChunks;
  }

  /** Rebuild the wanted queue and unload what is too far. */
  private prioritise(cameraMoved: boolean): void {
    if (this.disposed) return;
    this.dirty = false;
    if (cameraMoved) this.prioritisedAt = { ...this.cam, t: this.now() };
    const cx0 = this.cam.x / 16;
    const cz0 = this.cam.z / 16;
    const r2 = this.opts.loadRadius * this.opts.loadRadius;
    const u2 = this.opts.unloadRadius * this.opts.unloadRadius;
    this.queue.length = 0;
    for (const [id, slot] of this.index) {
      const dx = slot.cx + 0.5 - cx0;
      const dz = slot.cz + 0.5 - cz0;
      const d2 = dx * dx + dz * dz;
      if (this.loaded.has(id)) {
        if (d2 > u2) this.unload(id, slot);
        continue;
      }
      if (d2 > r2 || this.inFlightIds.has(id) || this.failed.has(id)) continue;
      this.queue.push({ slot, d2 });
    }
    // Farthest first so pop() hands out the nearest.
    this.queue.sort((a, b) => b.d2 - a.d2);
    this.stats.queued = this.queue.length;
    this.pump();
  }

  private unload(id: number, slot: Slot): void {
    this.loaded.delete(id);
    this.stats.loaded = this.loaded.size;
    this.stats.unloaded++;
    this.hooks.onUnload(slot.cx, slot.cz);
  }

  private pump(): void {
    while (!this.disposed && this.inFlight < this.opts.concurrency && this.queue.length) {
      const batch = this.takeBatch();
      this.inFlight++;
      this.stats.inFlight = this.inFlight;
      void this.fetchBatch(batch).finally(() => {
        this.inFlight--;
        this.stats.inFlight = this.inFlight;
        this.stats.queued = this.queue.length;
        this.hooks.onProgress?.(this.stats);
        if (this.queue.length) this.pump();
      });
    }
    this.stats.queued = this.queue.length;
  }

  /**
   * The nearest wanted chunk plus every other wanted chunk of the same region stored
   * close enough to it in the file to be worth one request. Greedy and linear: the queue
   * is at most a few hundred entries.
   */
  private takeBatch(): Slot[] {
    const head = this.queue.pop()!.slot;
    const batch = [head];
    let start = head.sectorOffset * SECTOR;
    let end = (head.sectorOffset + head.sectorCount) * SECTOR;
    const { coalesceGap, maxBatchBytes } = this.opts;
    // Two passes so a chunk that only becomes adjacent after another joined is still taken.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const s = this.queue[i].slot;
        if (s.region !== head.region) continue;
        const s0 = s.sectorOffset * SECTOR;
        const s1 = (s.sectorOffset + s.sectorCount) * SECTOR;
        if (s1 + coalesceGap < start || s0 - coalesceGap > end) continue;
        const nStart = Math.min(start, s0);
        const nEnd = Math.max(end, s1);
        if (nEnd - nStart > maxBatchBytes) continue;
        start = nStart;
        end = nEnd;
        batch.push(s);
        this.queue.splice(i, 1);
      }
    }
    for (const s of batch) this.inFlightIds.add(chunkId(s.cx, s.cz));
    return batch;
  }

  private async fetchBatch(batch: Slot[]): Promise<void> {
    let start = Infinity;
    let end = 0;
    for (const s of batch) {
      start = Math.min(start, s.sectorOffset * SECTOR);
      end = Math.max(end, (s.sectorOffset + s.sectorCount) * SECTOR);
    }
    const bytes = await this.hooks.fetchRange(batch[0].region, start, end - 1).catch(() => null);
    this.stats.requests++;
    if (this.disposed) return;
    let stale = false;
    for (const s of batch) {
      const id = chunkId(s.cx, s.cz);
      this.inFlightIds.delete(id);
      if (!bytes) { this.fail(id); continue; }
      const off = s.sectorOffset * SECTOR - start;
      if (this.deliver(s, id, bytes.subarray(off, off + s.sectorCount * SECTOR)) === 'stale') stale = true;
    }
    if (bytes) this.stats.bytes += bytes.byteLength;
    this.stats.loaded = this.loaded.size;
    if (stale) void this.refreshIndex().then(() => this.prioritise(false));
  }

  /** Decode one chunk's sectors and hand it over; 'stale' means the index lied about them. */
  private deliver(s: Slot, id: number, chunkBytes: Uint8Array): 'ok' | 'stale' | 'failed' {
    let root: NbtCompound | null;
    try {
      root = decodeChunkPayload(chunkBytes, s.cx, s.cz);
    } catch {
      // Half-written at the instant it was read, or an external .mcc chunk. The next
      // index refresh (every flush) makes it eligible again.
      this.fail(id);
      return 'failed';
    }
    // The bytes at this offset now belong to a different chunk: the file was rewritten
    // under us. Re-read the index and let prioritise() queue this chunk again.
    if (!root || (root.xPos !== undefined && (root.xPos !== s.cx || root.zPos !== s.cz))) return 'stale';
    if (this.loaded.has(id)) return 'ok'; // the live sync got there first
    this.loaded.add(id);
    this.stats.fetched++;
    this.hooks.onChunk(root, s.cx, s.cz);
    return 'ok';
  }

  private fail(id: number): void {
    this.failed.add(id);
    this.stats.failures++;
  }
}

/** `?stream=` parsing: default on; `0`/`off`/`false` disables; a number is the load radius. */
export function parseStreamParam(value: string | null): { enabled: boolean; loadRadius?: number } {
  if (value === null || value === '' || value === '1' || value === 'on') return { enabled: true };
  if (value === '0' || value === 'off' || value === 'false') return { enabled: false };
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? { enabled: true, loadRadius: n } : { enabled: true };
}
