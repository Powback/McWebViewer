/**
 * What the save files know about each computer, by computer id — and the arithmetic that
 * puts a live turtle on screen exactly once.
 *
 * `computercraft dump` (see bridge/src/computers.mjs) says WHERE every loaded computer is,
 * about once a second, and nothing else: no label, no kind, no facing. The region files
 * say everything else and nothing current: a turtle's block entity carries its
 * `ComputerId`, its `Label` (D4, D37 …), whether it is on, and the block it was saved in,
 * which is where the last flush left it — up to five seconds and twenty-four blocks ago.
 * This module joins the two by id.
 *
 * Two consequences matter for drawing:
 *
 *  - a STATIONARY computer is already drawn by the region and never moves, so it must NOT
 *    get a live marker (that would be a second, floating copy of a block that is there);
 *  - a TURTLE with a live position must have its region-drawn block HIDDEN, or it is drawn
 *    twice — once where it is and once where the last flush left it. The hidden set is
 *    handed to the mesher by section key and block index, the units the mesher iterates in.
 *
 * Pure: no three.js, no DOM, so every rule here has a test.
 */

import type { ChunkColumn } from '../render/world.js';
import type { NbtCompound } from '../core/nbt.js';

export type ComputerKind = 'turtle' | 'computer';

export interface KnownComputer {
  id: number;
  kind: ComputerKind;
  /** the block entity's id, e.g. `computercraft:turtle_advanced` — the block to draw the marker as */
  blockId: string;
  label: string | null;
  on: boolean;
  /** the block its entity was saved at — where the region draws it */
  pos: [number, number, number];
  /** yaw of the saved block's `facing`, in the marker's convention; null when there is none */
  facingYawDeg: number | null;
}

/** The turtle drawn for an id the save files have not described yet. */
export const DEFAULT_TURTLE_BLOCK = 'computercraft:turtle_normal';

/**
 * Which computers have a computer id at all. Modems, cables, monitors, printers and disk
 * drives are `computercraft:` block entities too and have none; a pocket computer is an
 * item and never a block entity.
 */
export function classifyBlockEntity(blockEntityId: string): ComputerKind | null {
  if (!blockEntityId.startsWith('computercraft:')) return null;
  const path = blockEntityId.slice('computercraft:'.length);
  if (path.startsWith('turtle')) return 'turtle';
  if (path.startsWith('computer')) return 'computer';
  return null;
}

/** The tracker's key for a computer id — stable across label changes, unlike the label. */
export function turtleKey(id: number): string {
  return `#${id}`;
}

export function turtleIdOf(key: string): number {
  return Number(key.slice(1));
}

/** Section key as the mesher and the dirty set spell it. */
export function sectionKeyOf(x: number, y: number, z: number): string {
  return `${x >> 4},${y >> 4},${z >> 4}`;
}

/** Index of a block within its section, in the order `meshSection` iterates. */
export function blockIndexOf(x: number, y: number, z: number): number {
  return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
}

/**
 * The marker's rotation about +Y, in degrees, for a block that faces `dir`.
 *
 * The turtle model faces north (−Z) unrotated. Rotating by θ about +Y turns (0,0,−1) into
 * (−sin θ, 0, −cos θ), so west is 90, south 180, east 270. Same convention as
 * `headingYawDeg`, so a turtle at rest and a turtle in motion agree about which way is
 * forward.
 */
export function facingYawDeg(stateKey: string | undefined): number | null {
  const m = stateKey ? /\bfacing=(north|south|east|west)\b/.exec(stateKey) : null;
  if (!m) return null;
  return { north: 0, west: 90, south: 180, east: 270 }[m[1] as 'north' | 'south' | 'east' | 'west'];
}

/**
 * Heading implied by a step from `from` to `to`, or null when the step has no horizontal
 * component (a turtle going up or down keeps facing the way it was).
 *
 * The dump has no facing, but a turtle only ever moves along one axis at a time, so the
 * last horizontal step IS the facing — with one honest exception: a turtle can move
 * backwards. It will be drawn facing its direction of travel. Stated, not hidden.
 */
export function headingYawDeg(
  from: readonly [number, number, number] | undefined,
  to: readonly [number, number, number],
): number | null {
  if (!from) return null;
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (dx === 0 && dz === 0) return null;
  const deg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Longest activity line drawn on a tag; the rest is an ellipsis. Fleet lines are short, but "searching 6 chest(s) for stone_bricks" is not. */
export const MAX_ACTIVITY = 28;

/**
 * The one line a turtle's tag shows: who it is, then what it is doing.
 *
 * `D37 · fetching wood` when both are known; `D37` when HQ has a name but no activity;
 * `#57 · depositing` when the activity is known but the name is not (a drone HQ lists that
 * the save files have not); `#57` when nothing but the dump knows about it. The id is shown
 * only in the absence of a name, because a fleet of `#57`s is unreadable and a fleet of
 * `D37`s is the whole point — the id lives in the STALE/HUD paths for debugging instead.
 */
export function turtleTagText(
  name: string | null,
  id: number,
  activity: string | null,
  max = MAX_ACTIVITY,
): string {
  const head = name ?? `#${id}`;
  const act = activity?.trim();
  return act ? `${head} · ${truncate(act, max)}` : head;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export class ComputerRegistry {
  readonly known = new Map<number, KnownComputer>();

  /**
   * Fold one chunk column's block entities in. Returns the ids whose record changed, so the
   * caller can re-plan what is hidden — a turtle whose saved block moved between two chunk
   * reads must have the OLD block un-hidden and the new one hidden.
   *
   * `stateKeyAt` looks up the saved block state, for its `facing`.
   */
  absorb(col: ChunkColumn, stateKeyAt: StateAt): number[] {
    const changed: number[] = [];
    for (const be of col.blockEntities.values()) {
      const next = recordOf(be, stateKeyAt);
      if (!next) continue;
      const prev = this.known.get(next.id);
      if (prev && sameRecord(prev, next)) continue;
      this.known.set(next.id, next);
      changed.push(next.id);
    }
    return changed;
  }

  get(id: number): KnownComputer | undefined {
    return this.known.get(id);
  }

  /** `'unknown'` is an id the dump lists but no loaded chunk has described — treated as a turtle, because computers do not move into chunks we have not read. */
  kindOf(id: number): ComputerKind | 'unknown' {
    return this.known.get(id)?.kind ?? 'unknown';
  }

  /** What to write on the tag: the label when the save files have one, always the id. */
  labelFor(id: number): string {
    const label = this.known.get(id)?.label;
    return label ? `${label} #${id}` : `#${id}`;
  }

  /** The block state the live marker is meshed from — the turtle's own block, facing north. */
  markerState(id: number): string {
    const k = this.known.get(id);
    const block = k && k.kind === 'turtle' ? k.blockId : DEFAULT_TURTLE_BLOCK;
    return `${block}[facing=north,waterlogged=false]`;
  }

  /**
   * The region-drawn blocks to hide: the saved block of every TURTLE among `ids`.
   *
   * Keyed for the mesher — section key, then block index within the section. A stationary
   * computer is never hidden (it gets no marker), and an unknown id has no saved block to
   * hide yet; when its chunk is next re-read `absorb` reports it and the caller re-plans.
   */
  hiddenBlocks(ids: Iterable<number>): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    for (const id of ids) {
      const k = this.known.get(id);
      if (!k || k.kind !== 'turtle') continue;
      const [x, y, z] = k.pos;
      const key = sectionKeyOf(x, y, z);
      let set = out.get(key);
      if (!set) out.set(key, (set = new Set()));
      set.add(blockIndexOf(x, y, z));
    }
    return out;
  }
}

type StateAt = (x: number, y: number, z: number) => string | undefined;

/** One block entity as a record, or null when it is not a computer or lacks the fields. */
function recordOf(be: NbtCompound, stateKeyAt: StateAt): KnownComputer | null {
  const blockId = String(be.id ?? '');
  const kind = classifyBlockEntity(blockId);
  if (!kind) return null;
  const { ComputerId: id, x, y, z } = be;
  if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return null;
  }
  return {
    id,
    kind,
    blockId,
    label: typeof be.Label === 'string' && be.Label ? be.Label : null,
    // NBT has no boolean; CC:T stores `On` as a byte.
    on: be.On === 1,
    pos: [x, y, z],
    facingYawDeg: facingYawDeg(stateKeyAt(x, y, z)),
  };
}

function sameRecord(a: KnownComputer, b: KnownComputer): boolean {
  return a.kind === b.kind
    && a.blockId === b.blockId
    && a.label === b.label
    && a.on === b.on
    && a.pos[0] === b.pos[0] && a.pos[1] === b.pos[1] && a.pos[2] === b.pos[2]
    && a.facingYawDeg === b.facingYawDeg;
}

/**
 * Section keys whose hidden set differs between two plans — the sections to re-mesh.
 * A key present on one side only counts; a key on both sides counts if the sets differ.
 */
export function changedSections(
  before: ReadonlyMap<string, ReadonlySet<number>>,
  after: ReadonlyMap<string, ReadonlySet<number>>,
): string[] {
  const out = new Set<string>();
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b || !sameSet(a, b)) out.add(key);
  }
  for (const key of after.keys()) if (!before.has(key)) out.add(key);
  return [...out].sort();
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
