/**
 * Walkable-cell A*, planned in the browser over the chunks it is already rendering.
 *
 * WHY THIS EXISTS. Click-to-move used to be steering: face the point, hold forward, jump
 * every 600 ms if nothing was happening, abandon the walk after four seconds of no
 * progress. That is honest about what the bridge offers — its vocabulary is
 * `move forward|back|left|right` plus `turn`, and there is no goto in it — but it means the
 * character walks into the first tree it meets and stands there shoving until the timer
 * runs out. Watching it snag on terrain is what prompted this.
 *
 * WHY IT IS PLANNED HERE AND NOT ON THE BRIDGE. The viewer already holds the data: it
 * renders the chunks, so it knows what is solid, what is air and where the ground is. A
 * `goto` verb on the bridge would need the server's own pathfinder (which the fake-player
 * mod does not expose), a new protocol message, and a second place that can be wrong about
 * where the character is. The plan is made here and fed to the SAME steering that already
 * worked — one waypoint at a time — so nothing downstream changes.
 *
 * WHAT IT MODELS. A player, not a point:
 *
 *   - the body is 2 blocks tall, so a cell needs air at the feet AND at head height
 *   - it can step UP one block, and only if there is headroom above where it is standing
 *   - it can drop `maxFall` blocks, and only down a column that is actually clear
 *   - it cannot jump a gap. A one-block hole in a walkway is a wall to this planner
 *   - it will not stand in water, lava, fire or a cactus, and will not walk into them
 *
 * A move that is not generated is a route that cannot be planned, which is how "refuse a
 * route needing a jump the bot cannot make" is expressed: there is no such edge.
 *
 * WHAT IT COSTS. This runs on a phone, so the search is bounded twice — a node budget and
 * a radius — and it is RESUMABLE. `step(n)` expands at most n nodes and returns; the
 * caller spends a millisecond of each frame on it rather than stalling the render loop for
 * the whole search. When the budget runs out with the goal still unreached, the best node
 * found so far is returned as a partial path IF it makes real progress, and the walk
 * re-plans when it gets there. That is the "cap the radius and re-plan as it advances"
 * trade, taken deliberately: a bounded search that makes progress beats an unbounded one
 * that drops a frame.
 */

/**
 * How a block behaves for something walking on it.
 *
 * Three values rather than two because "you cannot walk through it" and "you can stand on
 * top of it" are different questions, and water is the block that proves it: a body cannot
 * occupy it and must not be routed onto it either.
 */
export type NavClass =
  /** a body may occupy this; nothing can stand on it */
  | 'air'
  /** a body may not occupy this; it may stand on top of it */
  | 'solid'
  /** a body may not occupy this AND may not stand on it — water, lava, fire, cactus */
  | 'avoid';

export interface NavWorld {
  classify(x: number, y: number, z: number): NavClass;
  /**
   * Is this column loaded at all?
   *
   * Load-bearing, because `World.getState` returns AIR outside loaded chunks and a planner
   * that believed it would happily route through the edge of the render distance and out
   * into nothing. Unknown is not walkable, which also bounds the search to terrain the
   * viewer can actually see.
   */
  known(x: number, y: number, z: number): boolean;
}

export type Cell = [number, number, number];

export interface PathLimits {
  /** total node expansions before the search gives up */
  maxNodes: number;
  /** blocks from the start beyond which cells are not expanded */
  maxRadius: number;
  /** how far the character may drop in one move */
  maxFall: number;
}

export const DEFAULT_LIMITS: PathLimits = {
  // ~6000 expansions is about 8 ms on a desktop and under 40 ms on a phone, spread over
  // frames it is never felt. It covers a 60-block detour around a building comfortably.
  maxNodes: 6000,
  maxRadius: 64,
  // Vanilla starts hurting past three. The character is not ours to damage on a walk it
  // was not asked to make, and a four-block drop is usually a route that should have
  // gone round.
  maxFall: 3,
};

export type PlanState = 'searching' | 'found' | 'unreachable';

/** Cost of a straight step. Diagonals and height changes are priced against this. */
const STEP = 1;
const DIAGONAL = Math.SQRT2;
/**
 * Height changes are not free, so a level route is preferred to a staircase of the same
 * length. Small enough that it never refuses the only way up.
 */
const STEP_UP_COST = 0.6;
const FALL_COST = 0.4;
/** A partial path is only worth walking if it gets this much closer to the goal. */
const PARTIAL_MIN_GAIN = 3;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, boolean]> = [
  [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
  [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
];

/**
 * One bounded, resumable A* search.
 *
 * Created per walk. `step` may be called until it stops returning `'searching'`; after
 * that the answer is in `path` (possibly empty) and `partial` says whether it reaches the
 * goal or merely gets closer to it.
 */
export class PathPlanner {
  readonly limits: PathLimits;
  /** Cells from the start (exclusive) to the destination. Empty until the search ends. */
  path: Cell[] = [];
  /** True when `path` ends short of the goal because the budget ran out. */
  partial = false;
  /** Node expansions used so far, for the HUD and the tests. */
  expanded = 0;

  private open = new Heap();
  private came = new Map<number, number>();
  private gScore = new Map<number, number>();
  private cells = new Map<number, Cell>();
  private best = { key: -1, h: Infinity };
  private state: PlanState = 'searching';

  constructor(
    private world: NavWorld,
    private start: Cell,
    private goal: Cell,
    limits: Partial<PathLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    const key = this.key(start);
    this.cells.set(key, start);
    this.gScore.set(key, 0);
    this.best = { key, h: heuristic(start, goal) };
    this.open.push(key, this.best.h);
  }

  get status(): PlanState {
    return this.state;
  }

  /**
   * Expand at most `budget` nodes.
   *
   * The budget is the whole point: called with 600 or so from the frame loop, a 6000-node
   * search finishes inside ten frames and no single frame pays for more than a fraction of
   * a millisecond.
   */
  step(budget: number): PlanState {
    if (this.state !== 'searching') return this.state;
    for (let i = 0; i < budget; i++) {
      const key = this.open.pop();
      if (key === undefined) return this.finish(false);
      const cell = this.cells.get(key)!;
      if (cell[0] === this.goal[0] && cell[1] === this.goal[1] && cell[2] === this.goal[2]) {
        this.path = this.rebuild(key);
        this.partial = false;
        this.state = 'found';
        return this.state;
      }
      this.expanded++;
      if (this.expanded > this.limits.maxNodes) return this.finish(true);
      this.expand(key, cell);
    }
    return 'searching';
  }

  /** Run to completion. Convenience for tests and for a search small enough not to matter. */
  run(): PlanState {
    let s = this.step(this.limits.maxNodes + 2);
    while (s === 'searching') s = this.step(this.limits.maxNodes + 2);
    return s;
  }

  /**
   * Out of budget, or out of frontier.
   *
   * Either way the goal was not reached. A partial path is offered only when the nearest
   * node found is meaningfully closer than the start — otherwise this reports failure, and
   * the caller must NOT move. "Give up honestly" is the requirement; a bot that walks
   * three blocks in the wrong direction because the search fizzled is the old behaviour
   * wearing a new coat.
   */
  private finish(_budgetRanOut: boolean): PlanState {
    const gain = heuristic(this.start, this.goal) - this.best.h;
    if (this.best.key >= 0 && gain >= PARTIAL_MIN_GAIN) {
      this.path = this.rebuild(this.best.key);
      this.partial = true;
      this.state = 'found';
    } else {
      this.path = [];
      this.state = 'unreachable';
    }
    return this.state;
  }

  private expand(key: number, cell: Cell): void {
    const g = this.gScore.get(key)!;
    for (const [dx, dz, diagonal] of NEIGHBOURS) {
      const move = this.move(cell, dx, dz, diagonal);
      if (!move) continue;
      const [next, cost] = move;
      const nk = this.key(next);
      const ng = g + cost;
      const known = this.gScore.get(nk);
      if (known !== undefined && known <= ng) continue;
      this.cells.set(nk, next);
      this.gScore.set(nk, ng);
      this.came.set(nk, key);
      const h = heuristic(next, this.goal);
      if (h < this.best.h) this.best = { key: nk, h };
      this.open.push(nk, ng + h);
    }
  }

  /**
   * One move, or null if a player could not make it.
   *
   * The height search runs downwards from a step up, so the FIRST landing found is the
   * highest one — which is what walking off a ledge does. Searching upwards would let a
   * route drop three blocks into a pit that has a floor at the bottom when it could have
   * walked across the top.
   */
  private move(from: Cell, dx: number, dz: number, diagonal: boolean): [Cell, number] | null {
    const [x, y, z] = from;
    const nx = x + dx;
    const nz = z + dz;
    if (this.outOfRange(nx, nz)) return null;
    // A diagonal may not cut a corner: both orthogonal neighbours have to be open at body
    // height, or the character clips through the corner of a wall it should walk around.
    if (diagonal && !this.cornerOpen(x, y, z, nx, nz)) return null;

    const ny = this.landing(x, y, z, nx, nz);
    // Diagonals stay level. A diagonal step up or down is a corner case with no agreed-on
    // physics, and getting it wrong is a route the character cannot walk.
    if (ny === null || (diagonal && ny !== y)) return null;
    return [[nx, ny, nz], stepCost(diagonal, y, ny)];
  }

  private outOfRange(nx: number, nz: number): boolean {
    return Math.abs(nx - this.start[0]) > this.limits.maxRadius
      || Math.abs(nz - this.start[2]) > this.limits.maxRadius;
  }

  private cornerOpen(x: number, y: number, z: number, nx: number, nz: number): boolean {
    return this.bodyClear(nx, y, z) && this.bodyClear(x, y, nz);
  }

  /**
   * The height the character ends up at after stepping to (nx, nz), or null if it cannot.
   *
   * Searched DOWNWARDS from a step up, so the first landing found is the highest one —
   * which is what walking off a ledge does. Searching upwards would let a route drop into
   * a pit that has a floor at the bottom when it could have walked across the top.
   */
  private landing(x: number, y: number, z: number, nx: number, nz: number): number | null {
    return landingHeight(this.world, [x, y, z], nx, nz, this.limits.maxFall);
  }

  private standable(x: number, y: number, z: number): boolean {
    return standable(this.world, x, y, z);
  }

  private bodyClear(x: number, y: number, z: number): boolean {
    return bodyClear(this.world, x, y, z);
  }

  private rebuild(key: number): Cell[] {
    const out: Cell[] = [];
    let k: number | undefined = key;
    while (k !== undefined && k !== this.key(this.start)) {
      out.push(this.cells.get(k)!);
      k = this.came.get(k);
    }
    return out.reverse();
  }

  /**
   * Cells are keyed by their offset from the start, packed into one integer.
   *
   * A string key costs a hash of a string per neighbour and this is the hottest line in
   * the search. The search is bounded to 512 blocks in every direction, which is far more
   * than `maxRadius` allows, so the packing cannot collide.
   */
  private key(c: Cell): number {
    const dx = c[0] - this.start[0] + 512;
    const dy = c[1] - this.start[1] + 512;
    const dz = c[2] - this.start[2] + 512;
    return (dx * 1024 + dy) * 1024 + dz;
  }
}

/** What one step costs: distance, plus a nudge away from routes that go up and down. */
function stepCost(diagonal: boolean, from: number, to: number): number {
  return (diagonal ? DIAGONAL : STEP)
    + (to > from ? STEP_UP_COST : 0)
    + (to < from ? FALL_COST * (from - to) : 0);
}

/**
 * Could the character walk STRAIGHT from `from` to `to` without the grid's help?
 *
 * Simulates the walk one cell at a time, carrying the ground height along — a rise of one
 * is a step, a drop of up to `maxFall` is a step down, anything else stops it. Diagonal
 * transitions need both orthogonal neighbours open, exactly as the search does, so a line
 * cannot squeeze through a corner the route was not allowed through.
 */
export function walkableLine(
  world: NavWorld,
  from: Cell,
  to: Cell,
  maxFall = DEFAULT_LIMITS.maxFall,
): boolean {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) * 2));
  let at: Cell = [from[0], from[1], from[2]];
  for (let i = 1; i <= steps; i++) {
    const nx = Math.floor(from[0] + 0.5 + (dx * i) / steps);
    const nz = Math.floor(from[2] + 0.5 + (dz * i) / steps);
    const next = lineStep(world, at, nx, nz, maxFall);
    if (next === null) return false;
    at = next;
  }
  return at[0] === to[0] && at[2] === to[2] && at[1] === to[1];
}

/** One cell of a straight walk: the same rules the search uses, or null if it stops here. */
function lineStep(
  world: NavWorld,
  at: Cell,
  nx: number,
  nz: number,
  maxFall: number,
): Cell | null {
  const [x, y, z] = at;
  if (nx === x && nz === z) return at;
  if (nx !== x && nz !== z
    && (!bodyClear(world, nx, y, z) || !bodyClear(world, x, y, nz))) return null;
  const ny = landingHeight(world, at, nx, nz, maxFall);
  return ny === null ? null : [nx, ny, nz];
}

/**
 * Straighten a grid route into the few turns a player would actually make.
 *
 * A* on a cell grid produces a staircase — every diagonal is a run of alternating steps —
 * and a follower that aims at each cell in turn spends its time turning rather than
 * walking. Measured against the live server before this was added: a ten-cell route moved
 * the character 4 blocks in 60 seconds, because the body was re-aimed every waypoint and
 * overshot each one. Collapsing the route to the furthest cell still reachable in a
 * straight walk turns that into two or three long legs.
 *
 * The lookahead is capped so this stays linear-ish: the search can return a hundred cells
 * and checking every pair would cost more than the search did.
 */
export function smoothPath(
  world: NavWorld,
  start: Cell,
  path: readonly Cell[],
  maxFall = DEFAULT_LIMITS.maxFall,
): Cell[] {
  const out: Cell[] = [];
  let anchor = start;
  let i = 0;
  while (i < path.length) {
    let best = i;
    const limit = Math.min(path.length - 1, i + SMOOTH_LOOKAHEAD);
    for (let j = limit; j > i; j--) {
      if (walkableLine(world, anchor, path[j], maxFall)) { best = j; break; }
    }
    out.push(path[best]);
    anchor = path[best];
    i = best + 1;
  }
  return out;
}

/** How far ahead `smoothPath` will try to jump in one leg. */
const SMOOTH_LOOKAHEAD = 24;

/** Shared by the search and the straight-line check, so the two cannot disagree. */
function landingHeight(world: NavWorld, from: Cell, nx: number, nz: number, maxFall: number)
  : number | null {
  const [x, y, z] = from;
  const top = y + (world.classify(x, y + 2, z) === 'air' ? 1 : 0);
  for (let ny = top; ny >= y - maxFall; ny--) {
    if (!standable(world, nx, ny, nz)) continue;
    // Falling means walking off the edge, so everything the body passes through on the way
    // down has to be clear — not just where it lands.
    if (ny < y && !columnClear(world, nx, ny + 1, y + 1, nz)) return null;
    return ny;
  }
  return null;
}

function columnClear(world: NavWorld, x: number, from: number, to: number, z: number): boolean {
  for (let y = from; y <= to; y++) if (world.classify(x, y, z) !== 'air') return false;
  return true;
}

/** Can a 2-block body stand here, with ground under it? */
export function standable(world: NavWorld, x: number, y: number, z: number): boolean {
  if (!world.known(x, y, z)) return false;
  if (world.classify(x, y - 1, z) !== 'solid') return false;
  return bodyClear(world, x, y, z);
}

/** Is the 2-block body volume free at this cell? */
export function bodyClear(world: NavWorld, x: number, y: number, z: number): boolean {
  return world.classify(x, y, z) === 'air' && world.classify(x, y + 1, z) === 'air';
}

/**
 * Octile distance on the horizontal plane.
 *
 * Height is deliberately NOT in the heuristic. Every move costs at least one horizontal
 * unit, so this never over-estimates, which is what keeps A* from returning a route that
 * is merely plausible. Adding the vertical term would break admissibility as soon as a
 * ladder of steps covers more height than horizontal distance.
 */
function heuristic(a: Cell, b: Cell): number {
  const dx = Math.abs(a[0] - b[0]);
  const dz = Math.abs(a[2] - b[2]);
  return Math.max(dx, dz) + (DIAGONAL - 1) * Math.min(dx, dz);
}

/**
 * The nearest cell to `goal` that a body can actually stand in.
 *
 * A tap lands on a block face, and the cell above it is very often not standable — you
 * tapped the side of a wall, or a slab, or the underside of an overhang. Refusing those
 * would make click-to-move feel broken on exactly the geometry it is most useful for, so
 * the goal is snapped to the closest legal cell within a small box. Small on purpose:
 * snapping far means walking somewhere the player did not point at.
 */
export function nearestStandable(
  world: NavWorld,
  goal: Cell,
  radius = 3,
): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const c: Cell = [goal[0] + dx, goal[1] + dy, goal[2] + dz];
        // Vertical distance counts double: a cell one block over is a better answer than
        // one a floor below, which is a different place entirely.
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 2;
        if (d >= bestD) continue;
        if (!standable(world, c[0], c[1], c[2])) continue;
        best = c;
        bestD = d;
      }
    }
  }
  return best;
}


/**
 * Binary min-heap of (key, priority).
 *
 * A sorted array or a linear scan of the open set is what makes a naive A* feel slow, and
 * this one has to finish inside a frame budget on a phone. Two flat arrays rather than
 * objects so there is nothing to allocate per push.
 */
class Heap {
  private keys: number[] = [];
  private cost: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, cost: number): void {
    this.keys.push(key);
    this.cost.push(cost);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number | undefined {
    if (!this.keys.length) return undefined;
    const top = this.keys[0];
    const key = this.keys.pop()!;
    const cost = this.cost.pop()!;
    if (this.keys.length) {
      this.keys[0] = key;
      this.cost[0] = cost;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < this.keys.length && this.cost[l] < this.cost[small]) small = l;
        if (r < this.keys.length && this.cost[r] < this.cost[small]) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.cost[a], this.cost[b]] = [this.cost[b], this.cost[a]];
  }
}
