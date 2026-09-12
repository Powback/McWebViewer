/**
 * What a block's collision actually looks like.
 *
 * `nav-world.ts` answers "can a body occupy this cell" with a hand-written list of ~60
 * vanilla block names and the rule "everything else is a solid 1×1×1 cube". That is fine
 * for a path planner — it only has to be wrong in the safe direction — and it is not fine
 * for a character controller, where it means every slab is waist-high, every stair is a
 * wall, every fence is a full cube and every carpet is a step you cannot climb.
 *
 * So this prefers the REAL shapes, extracted from the game by the harness
 * (`harness/src/mcextract/ExtractPhysics.java`, see src/app/physics.ts). Three tiers, in
 * this order, and the order is the whole design:
 *
 *   1. the extracted table, keyed by the same canonical state string the region files
 *      decode to — exact, for all 26,684 vanilla states
 *   2. the block's own baked model bounds — DERIVED from the mod's own assets, which is
 *      how every other modded thing in this project works
 *   3. the old nav-world name heuristic — a guess, and the last resort
 *
 * Tier 2 is what carries modded blocks. The harness boots vanilla, not NeoForge, so mod
 * blocks are never registered and tier 1 has nothing for them (stated in the harness's own
 * class comment). But a mod ships its own models, this project already parses them for
 * rendering, and a block's rendered box is very often exactly its collision box — a Create
 * shaft, a chain conveyor, a pipe. It is not always (a stair's model is its collision; a
 * torch's model is not), which is why it sits below the exact table and above the guess.
 *
 * Everything is cached by the world's numeric state id, the same trick nav-world uses: a
 * search or a physics step touches thousands of cells but a chunk holds a few hundred
 * distinct states, so after the first touch every lookup is an array index.
 */

import { AIR_ID, type World } from '../render/world.js';
import { classifyName, nameOf } from './nav-world.js';
import type { NavWorld } from './pathfind.js';
import type { Box, PhysicsData } from './physics.js';

/** The whole cube, which is what "solid" meant before this file existed. */
export const FULL_CUBE: readonly Box[] = [[0, 0, 0, 1, 1, 1]];
/** No collision at all. */
export const EMPTY: readonly Box[] = [];

/** Where a cell's shape came from, so the HUD can report coverage honestly. */
export type ShapeSource = 'extracted' | 'model' | 'heuristic';

export interface BlockShapes {
  /**
   * Collision boxes for the block at this cell, in WORLD coordinates.
   *
   * Returns an empty array for anything a body may pass through, including cells that are
   * not loaded — see the note in predict.ts about why unknown must not be a wall.
   */
  boxesAt(x: number, y: number, z: number): readonly Box[];
  /** Destroy time for the block at this cell; -1 unbreakable, null when not known. */
  hardnessAt(x: number, y: number, z: number): number | null;
  /**
   * Has this column streamed in yet?
   *
   * ASKED SEPARATELY BECAUSE "no collision here" AND "nothing known about here" MUST NOT
   * LOOK THE SAME to a falling body, and they did. `World.getState` answers AIR outside the
   * loaded chunks, so `boxesAt` returns nothing there — correct for walking INTO the
   * streaming edge, where guessing "wall" would freeze the player against thin air, and
   * catastrophic for standing ON it: the floor of a chunk that has not arrived yet is not a
   * hole, but the body fell through it as though it were, and the teleport that drives the
   * server's bot took the bot down with it. Reported from the live server as "it keeps
   * falling into holes and getting stuck".
   */
  known(x: number, y: number, z: number): boolean;
  /** How the last few thousand lookups were resolved — for the HUD, not for logic. */
  coverage(): Record<ShapeSource, number>;
}

interface Entry {
  boxes: readonly Box[];
  hardness: number | null;
  source: ShapeSource;
}

/**
 * Bounds of a block's baked geometry, as a single box, or null when it has none.
 *
 * Deliberately ONE box rather than one per element: a multi-element model's element boxes
 * are a rendering decomposition, not a collision decomposition, and a body that can slip
 * between a lantern's chain and its body is worse than one that cannot. The union is the
 * conservative read and the conservative read is the right failure direction here.
 *
 * Model coordinates are 0..16; collision is 0..1.
 */
export function modelBounds(quads: Float32Array | null | undefined): Box | null {
  if (!quads || quads.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < quads.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = quads[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  if (!degenerate(lo, hi)) return null;
  // A model that pokes outside its own cell (a fence gate's post, a chest's lid) is clamped
  // rather than allowed to collide into the neighbour, whose shape is its own business.
  return [
    Math.max(0, lo[0]), Math.max(0, lo[1]), Math.max(0, lo[2]),
    Math.min(1, hi[0]), Math.min(1, hi[1]), Math.min(1, hi[2]),
  ];
}

/** True when the bounds are a real, non-flat volume worth colliding against. */
function degenerate(lo: number[], hi: number[]): boolean {
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(lo[a]) || !Number.isFinite(hi[a])) return false;
    if (hi[a] <= lo[a]) return false;
  }
  return true;
}

/**
 * Build the shape oracle for a world.
 *
 * `physics` may be null (the table has not been baked) and `modelQuadsFor` may be omitted
 * (the caller has no cheap access to baked geometry); each missing input just drops that
 * tier, and `coverage()` then shows the work falling through to the heuristic.
 */
export function blockShapes(
  world: World,
  nav: NavWorld,
  physics: PhysicsData | null,
  modelQuadsFor?: (stateKey: string) => Float32Array | null,
): BlockShapes {
  const cache: Entry[] = [];
  const counts: Record<ShapeSource, number> = { extracted: 0, model: 0, heuristic: 0 };

  function resolve(id: number): Entry {
    const cached = cache[id];
    if (cached) return cached;
    const entry = classify(world.palette[id] ?? '', physics, modelQuadsFor);
    cache[id] = entry;
    return entry;
  }

  function entryAt(x: number, y: number, z: number): Entry | null {
    const id = world.getState(x, y, z);
    if (id === AIR_ID) return null;
    // An unloaded cell is NOT a wall. See predict.ts — guessing "wall" at the streaming
    // edge freezes the player against thin air with nothing on screen to explain it.
    if (!nav.known(x, y, z)) return null;
    const e = resolve(id);
    counts[e.source]++;
    return e;
  }

  return {
    boxesAt(x, y, z) {
      const e = entryAt(x, y, z);
      if (!e || e.boxes.length === 0) return EMPTY;
      return e.boxes.map((b) => [
        b[0] + x, b[1] + y, b[2] + z, b[3] + x, b[4] + y, b[5] + z,
      ] as Box);
    },
    hardnessAt(x, y, z) {
      const e = entryAt(x, y, z);
      return e ? e.hardness : null;
    },
    known: (x, y, z) => nav.known(x, y, z),
    coverage: () => ({ ...counts }),
  };
}

/** The three-tier resolution, in order. Split out so each tier is readable on its own. */
function classify(
  stateKey: string,
  physics: PhysicsData | null,
  modelQuadsFor?: (stateKey: string) => Float32Array | null,
): Entry {
  const exact = physics ? fromTable(stateKey, physics) : null;
  if (exact) return exact;
  const derived = modelQuadsFor ? fromModel(stateKey, modelQuadsFor) : null;
  if (derived) return derived;
  return fromHeuristic(stateKey);
}

/** Tier 1: the extracted table. Exact for every vanilla state. */
function fromTable(stateKey: string, physics: PhysicsData): Entry | null {
  const info = physics.blocks[stateKey] ?? physics.blocks[nameOf(stateKey)];
  if (!info) return null;
  const boxes = physics.shapes[info.s];
  if (!boxes) return null;
  return { boxes, hardness: info.h, source: 'extracted' };
}

/**
 * Tier 2: the mod's own model.
 *
 * Only applied to blocks the heuristic would otherwise call SOLID. A block the heuristic
 * already knows is walk-through (a flower, a torch) must stay walk-through — deriving a
 * collision box from a flower's crossed quads would put a wall around every plant, which is
 * a much more annoying failure than a flower you can walk through.
 */
function fromModel(
  stateKey: string,
  modelQuadsFor: (stateKey: string) => Float32Array | null,
): Entry | null {
  if (heuristicClass(stateKey) !== 'solid') return null;
  const box = modelBounds(modelQuadsFor(stateKey));
  if (!box) return null;
  return { boxes: [box], hardness: null, source: 'model' };
}

/** Tier 3: the old name table. A guess, and labelled as one. */
function fromHeuristic(stateKey: string): Entry {
  const solid = heuristicClass(stateKey) === 'solid';
  return { boxes: solid ? FULL_CUBE : EMPTY, hardness: null, source: 'heuristic' };
}

/**
 * nav-world's own answer, reached without a world lookup.
 *
 * The same `classifyName` nav-world itself uses, imported rather than re-typed, so the
 * heuristic tier cannot drift away from the planner's idea of what is walk-through.
 */
function heuristicClass(stateKey: string): string {
  return classifyName(nameOf(stateKey));
}
