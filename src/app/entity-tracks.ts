/**
 * Save-file entities, decoded and interpolated for the live view.
 *
 * Mobs, animals, villagers, dropped items and falling blocks all live in a PARALLEL region
 * set at `world/entities/r.X.Z.mca` — the same Anvil format as the block regions, but each
 * chunk holds an `Entities` list rather than block sections. `decodeEntities` turns that
 * list into flat samples; `EntityTracks` turns a stream of those samples (one per flush)
 * into a per-frame pose stream so nothing teleports.
 *
 * WHY NOT `PlayerTracks`. The player/turtle tracker is built for a 1 Hz poll: it renders on
 * a fixed ~1 s delay and INTERPOLATES between the two samples either side of the render
 * clock, and flags a pose STALE the moment its newest sample is older than that delay. Both
 * assumptions break for save-file entities, which refresh only when the server flushes —
 * every 5 s at best on this server, and the guard walks the cadence out to 20-40 s under
 * load (see ARCHITECTURE.md §7). Interpolating a random-walking mob across a 20 s gap draws
 * a straight glide along a path it never took, and the age-based STALE flag would light up
 * ~70% of every cycle for a mob that is simply standing between flushes.
 *
 * So this tracker is tuned for a sparse, irregular refresh instead: it CHASES the latest
 * known position at a bounded speed (a quick reposition, then still) rather than gliding a
 * whole gap, and STALENESS means "dropped out of the latest refresh", not "sample is old".
 * A thing that leaves the entity regions has despawned, been picked up, or wandered into a
 * chunk we do not load — indistinguishable from here, so it is HELD where it was last seen
 * (items briefly, then removed; everything else marked STALE and held longer). The
 * bounded-chase and shortest-arc turning are the ideas `PlayerTracks` proved; this shares
 * `shortestArc` with it and re-tunes the rest.
 */

import { shortestArc } from './player-tracks.js';
import { canonicalStateKey } from '../core/chunk.js';
import type { NbtCompound, NbtList, NbtValue } from '../core/nbt.js';

/** One entity as the renderer wants it, decoded out of an `entities/` chunk. */
export interface EntitySample {
  /** stable identity across refreshes, from the entity's 128-bit `UUID` int array */
  uuid: string;
  /** e.g. `minecraft:cow`, `minecraft:item`, `minecraft:falling_block` */
  type: string;
  pos: readonly [number, number, number];
  /** raw `Rotation[0]` body yaw in degrees; the caller applies `entityYawDeg` for mobs */
  yawDeg: number;
  /** `CustomName` as plain text, or null */
  name: string | null;
  /** the stack a `minecraft:item` (or an item frame) carries, or null */
  item: { id: string; count: number } | null;
  /** canonical block state a `falling_block` / `block_display` carries, or null */
  block: string | null;
}

/** What to draw this frame: a sample whose position/yaw are the eased ones. */
export type EntityPose = Omit<EntitySample, 'pos' | 'yawDeg'> & {
  pos: [number, number, number];
  yawDeg: number;
  /** dropped out of the latest refresh and being held in place — callers must show it */
  stale: boolean;
};

// ---------------------------------------------------------------------------
// Decoding

function asCompound(v: NbtValue | undefined): NbtCompound | null {
  return v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)
    ? (v as NbtCompound)
    : null;
}

function readVec3(v: NbtValue | undefined): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const xyz: [number, number, number] = [Number(v[0]), Number(v[1]), Number(v[2])];
  return xyz.every(Number.isFinite) ? xyz : null;
}

/** The 128-bit UUID is stored as four signed ints; join them into one stable key. */
function readUuid(v: NbtValue | undefined): string | null {
  if (v instanceof Int32Array && v.length === 4) return `${v[0]}_${v[1]}_${v[2]}_${v[3]}`;
  return null;
}

/**
 * `CustomName` is a JSON text component (`{"text":"Bessie"}`) on 1.21, or bare text on
 * older data. Pull the plain string out either way, and never let a parse throw.
 */
function readName(v: NbtValue | undefined): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (v[0] !== '{' && v[0] !== '[' && v[0] !== '"') return v;
  return parseTextComponent(v);
}

function parseTextComponent(v: string): string | null {
  try {
    const parsed = JSON.parse(v) as unknown;
    if (typeof parsed === 'string') return parsed || null;
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}

function readItem(v: NbtValue | undefined): { id: string; count: number } | null {
  const c = asCompound(v);
  if (!c || typeof c.id !== 'string') return null;
  return { id: c.id, count: typeof c.count === 'number' ? c.count : 1 };
}

/** `BlockState` is `{Name, Properties}` — the same shape a chunk palette entry has. */
function readBlockState(v: NbtValue | undefined): string | null {
  const c = asCompound(v);
  if (!c || typeof c.Name !== 'string') return null;
  const props = asCompound(c.Properties);
  let p: Record<string, string> | undefined;
  if (props) {
    p = {};
    for (const k in props) p[k] = String(props[k]);
  }
  return canonicalStateKey(c.Name, p);
}

function decodeEntity(ent: NbtCompound): EntitySample | null {
  const type = typeof ent.id === 'string' ? ent.id : null;
  const pos = readVec3(ent.Pos);
  const uuid = readUuid(ent.UUID);
  if (!type || !pos || !uuid) return null;
  const rot = ent.Rotation;
  const yaw = Array.isArray(rot) ? Number(rot[0]) : 0;
  return {
    uuid,
    type,
    pos,
    yawDeg: Number.isFinite(yaw) ? yaw : 0,
    name: readName(ent.CustomName),
    item: readItem(ent.Item),
    block: readBlockState(ent.BlockState),
  };
}

/** Every drawable entity in one decoded `entities/` chunk root. */
export function decodeEntities(root: NbtCompound): EntitySample[] {
  const list = root.Entities as NbtList | undefined;
  if (!Array.isArray(list)) return [];
  const out: EntitySample[] = [];
  for (const raw of list) {
    const c = asCompound(raw);
    const s = c ? decodeEntity(c) : null;
    if (s) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interpolation

/** How fast the drawn position slides toward a fresh sample, blocks/second. */
const CHASE_SPEED = 8;
/** Beyond this the drawn position SNAPS: a body that moved this far between two sparse
 *  flushes was not walked there smoothly, and gliding it would invent the journey. */
const SNAP_BLOCKS = 8;
/** A body may turn quickly; it may not spin. Degrees/second. */
const MAX_YAW_RATE = 360;

export interface EntityTrackOptions {
  /** how long a track absent from the roster is held before it is forgotten */
  holdMs: number;
}

interface Track {
  sample: EntitySample;
  drawn: [number, number, number];
  drawnYaw: number;
  /** local clock at which the roster stopped listing it, or null while present */
  lostAt: number | null;
}

/**
 * Sample stream in, pose stream out. One instance per expiry policy: items are dropped
 * almost as soon as they vanish (they were picked up or despawned), everything else is
 * held far longer and flagged STALE (it may only have wandered out of a loaded chunk).
 */
export class EntityTracks {
  private tracks = new Map<string, Track>();
  private lastPoseAt: number | null = null;

  constructor(private opts: EntityTrackOptions) {}

  get size(): number {
    return this.tracks.size;
  }

  clear(): void {
    this.tracks.clear();
    this.lastPoseAt = null;
  }

  /** Fold one refresh in. `now` is the local clock. */
  ingest(roster: readonly EntitySample[], now: number): void {
    const seen = new Set<string>();
    for (const s of roster) {
      seen.add(s.uuid);
      const tr = this.tracks.get(s.uuid);
      if (tr) {
        tr.sample = s;
        tr.lostAt = null;
      } else {
        this.tracks.set(s.uuid, {
          sample: s,
          drawn: [...s.pos] as [number, number, number],
          drawnYaw: s.yawDeg,
          lostAt: null,
        });
      }
    }
    for (const tr of this.tracks.values()) {
      if (seen.has(tr.sample.uuid) || tr.lostAt !== null) continue;
      // Snap the drawn position to the true last reading before holding it, so a track lost
      // mid-slide holds where the server last put it, not part-way through a chase.
      tr.lostAt = now;
      tr.drawn = [...tr.sample.pos] as [number, number, number];
      tr.drawnYaw = tr.sample.yawDeg;
    }
  }

  /** Every pose to draw this frame. Call once per frame; the easing reads the gap. */
  poses(now: number): EntityPose[] {
    const dt = this.lastPoseAt === null ? 0 : Math.min(0.1, (now - this.lastPoseAt) / 1000);
    this.lastPoseAt = now;
    const out: EntityPose[] = [];
    for (const [uuid, tr] of this.tracks) {
      if (tr.lostAt !== null && now - tr.lostAt > this.opts.holdMs) {
        this.tracks.delete(uuid);
        continue;
      }
      if (tr.lostAt === null) chase(tr, dt);
      out.push({
        uuid,
        type: tr.sample.type,
        name: tr.sample.name,
        item: tr.sample.item,
        block: tr.sample.block,
        pos: [...tr.drawn] as [number, number, number],
        yawDeg: tr.drawnYaw,
        stale: tr.lostAt !== null,
      });
    }
    return out;
  }
}

/** Move the drawn pose toward the latest sample without exceeding the per-frame budget. */
function chase(tr: Track, dt: number): void {
  const target = tr.sample.pos;
  const gap = Math.hypot(
    tr.drawn[0] - target[0],
    tr.drawn[1] - target[1],
    tr.drawn[2] - target[2],
  );
  if (gap > SNAP_BLOCKS || dt <= 0 || gap === 0) {
    tr.drawn = [...target] as [number, number, number];
    tr.drawnYaw = tr.sample.yawDeg;
    return;
  }
  const budget = CHASE_SPEED * dt;
  const t = gap <= budget ? 1 : budget / gap;
  for (let i = 0; i < 3; i++) tr.drawn[i] += (target[i] - tr.drawn[i]) * t;
  const turn = shortestArc(tr.drawnYaw, tr.sample.yawDeg);
  const maxTurn = MAX_YAW_RATE * dt;
  tr.drawnYaw += Math.abs(turn) <= maxTurn ? turn : Math.sign(turn) * maxTurn;
}
