/**
 * Walkable-cell A*, planned in the browser over the chunks it is already rendering.
 *
 * WHY THIS EXISTS. Click-to-move used to be steering: face the point, hold forward, jump
 * every 600 ms if nothing was happening, abandon the walk after four seconds of no
 * progress. That meant the character walked into the first tree it met and stood there
 * shoving until the timer ran out. Watching it snag on terrain is what prompted this.
 *
 * WHY IT IS PLANNED HERE AND NOT ON THE SERVER. Asked directly, on 2026-09-11: the live
 * server's full `/help` dump has no path, goto or navigate verb in it, from vanilla or
 * from any of its 130 mods, and the one bot mod installed (SiliconeDolls) offers exactly
 * `spawn|kill|<action>|sneak|unsneak|sprint|unsprint|mount|dismount|look|turn|dropStack|
 * move|hotbar|shadow|stop`. There is nothing to call. Deeper than the command list:
 * `PathNavigation` in Minecraft belongs to `Mob`, and a `ServerPlayer` is not a `Mob` and
 * has no navigator at all — so there is no server-side player pathfinder to expose even
 * with a new mod, only one that could be built. See the note at the head of iso-view.ts.
 *
 * WHAT IS NATIVE IS THE MOVEMENT. The route is executed by `PredictedBody`, which runs the
 * game's own extracted constants against the game's own per-state `VoxelShape` collision
 * (see predict.ts and physics.ts). So this file does not decide how far a jump goes or how
 * fast a body falls — it ASKS, via `jumpSpan` below, and refuses to plan any move the
 * simulation could not actually perform. Planner and executor cannot disagree, because
 * they read the same numbers.
 *
 * WHAT IT MODELS. A player, not a point:
 *
 *   - the body is 2 blocks tall, so a cell needs air at the feet AND at head height
 *   - it can step UP one block, and only if there is headroom above where it is standing
 *   - it can drop `maxFall` blocks, and only down a column that is actually clear
 *   - it can JUMP a gap, and SPRINT-jump a wider one, as far as the game's constants say
 *     the body really travels and not one block further
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

import { FALLBACK_MOTION, SEED_SPEED, type MotionConstants } from './physics.js';

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

/**
 * How the body gets from the previous waypoint to this one.
 *
 * The follower needs this and cannot re-derive it: `smoothPath` collapses a run of walking
 * cells into one long leg, so "is there a gap in the middle of this leg" is a question the
 * straightened route no longer answers. A jump is never collapsed into a leg (see
 * `walkableLine`, which has no jump in it), so a waypoint that says `jump` is a waypoint
 * whose ENTIRE leg is that one jump — which is what makes the take-off point knowable.
 */
export type MoveKind = 'walk' | 'jump' | 'sprint';

export interface Step {
  readonly cell: Cell;
  readonly move: MoveKind;
}

export interface PathLimits {
  /** total node expansions before the search gives up */
  maxNodes: number;
  /** blocks from the start beyond which cells are not expanded */
  maxRadius: number;
  /** how far the character may drop in one move */
  maxFall: number;
  /**
   * The game's own motion constants. Jump reach is DERIVED from these — see `jumpSpan`.
   *
   * Defaulted to the fallbacks so a planner built before physics.json lands still works;
   * the fallbacks are the same pre-extraction guesses the predictor uses, so the two are
   * never modelling different bodies.
   */
  motion: MotionConstants;
  /** Base walking speed, blocks/s, as the predictor measures it. */
  walkSpeed: number;
  /**
   * Furthest a jump edge may reach, in cells, measured centre to centre.
   *
   * A bound on the SEARCH, not on the physics: every candidate is still checked against
   * `jumpSpan`, so raising this cannot produce a jump the body could not make — it only
   * costs node expansions. 0 disables jumping entirely.
   */
  maxJumpCells: number;
  /** May a sprint run-up be planned? Off means only standing-speed jumps are considered. */
  sprint: boolean;
}

export const DEFAULT_LIMITS: PathLimits = {
  // ~6000 expansions is about 8 ms on a desktop and under 40 ms on a phone, spread over
  // frames it is never felt. It covers a 60-block detour around a building comfortably.
  maxNodes: 6000,
  maxRadius: 64,
  // Vanilla starts hurting past three — fall damage is (distance - 3) hearts — so three is
  // exactly the largest drop that costs the character nothing. The character is not ours to
  // damage on a walk it was not asked to make.
  maxFall: 3,
  motion: FALLBACK_MOTION,
  walkSpeed: SEED_SPEED,
  // A sprint jump carries about 3 blocks on these constants, so 4 is one cell past anything
  // that can ever be accepted: enough head-room that the physics is what refuses a jump,
  // never this number.
  maxJumpCells: 4,
  sprint: true,
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
/**
 * What a jump costs ON TOP of the ground it covers.
 *
 * Jumping is the riskiest thing this planner will order — it is the one move where being
 * slightly wrong puts the character in a hole rather than against a wall — so a route that
 * walks round is preferred to one that hops across whenever walking round is not absurdly
 * longer. The sprint surcharge is on top again: a standing jump is the more controlled of
 * the two, so it wins ties.
 *
 * These must stay non-negative for A* to keep returning the cheapest route: every edge
 * already costs at least the horizontal distance the heuristic credits it with, and a
 * surcharge only ever adds.
 */
const JUMP_COST = 3;
const SPRINT_JUMP_COST = 5;
/**
 * How far short of the landing cell's CENTRE the body may come down and still count.
 *
 * The body is 0.6 wide, so it is still supported while its centre is within 0.8 of the cell
 * centre — 0.5 of cell plus 0.3 of half-width. Anything under 0.8 therefore LANDS; the
 * question this number really answers is how much of that 0.8 is kept back as margin.
 *
 * It was 0.4, which keeps back half, and the live world showed that is not enough. The
 * ground east of the base is a walkway with a one-block shaft cut through it and the far
 * side a block lower — real geometry, correctly rendered, not a stale chunk — and the
 * planner crossed it with a WALKING jump whose reach exceeded what it needed by 0.09 of a
 * block. Nothing is wrong with that arithmetic and the simulation makes the jump every time
 * in isolation. It is still the wrong answer, because a jump is the one move here whose
 * failure is not recoverable: miss a walkway by a hand's breadth in a mining base and the
 * character is twenty blocks down a shaft, which is precisely the "it keeps falling into
 * holes" this work started from. Every other mistake this planner can make costs a detour.
 *
 * At 0.15 the body must clear all but a sixth of the way to the middle of the block it is
 * aiming at, which keeps back 0.65 of the 0.8 for the things the plan cannot see: a frame
 * that took 50 ms instead of 16, the reconciliation nudging the body while it is in the
 * air, a take-off a few centimetres early. The marginal jumps this now refuses become a
 * SPRINT jump (which has the reach to spare) or a detour or an honest "no path" — all three
 * of which are recoverable, and none of which end at the bottom of a shaft.
 *
 * Pinned by a test that runs the REAL `PredictedBody` across the widest jump this planner
 * will issue and asserts it lands on its feet. If this number is ever wrong, that test is
 * what says so.
 */
const JUMP_LANDING_MARGIN = 0.15;
/** A partial path is only worth walking if it gets this much closer to the goal. */
const PARTIAL_MIN_GAIN = 3;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, boolean]> = [
  [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
  [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
];

/**
 * Jumps are CARDINAL only.
 *
 * Same reason diagonals stay level: a diagonal jump is a corner case with no agreed-on
 * physics and getting it wrong is a route the character cannot walk. A gap that genuinely
 * needs crossing on the diagonal is crossed as two cardinal moves or refused.
 */
const JUMP_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/**
 * How far a jump actually carries the body, in blocks, on the game's own numbers.
 *
 * Nothing here is a parkour fact anybody remembers. The body leaves the ground at
 * `jumpSpeed` and is pulled down at `gravity`, both extracted from the real client, so the
 * time in the air before it is `dy` above where it started is the positive root of
 *
 *     -g/2 t^2 + v t - dy = 0      =>      t = (v + sqrt(v^2 - 2 g dy)) / g
 *
 * and the ground covered is the horizontal speed times that. A jump UP has less time and
 * therefore less reach; a jump DOWN has more. `PredictedBody` integrates exactly these
 * constants, which is why the planner and the thing that executes the plan cannot disagree
 * about what is jumpable.
 *
 * Returns 0 when the body cannot rise `dy` at all, which is the honest answer for a ledge
 * higher than a jump: there is no such move.
 */
export function jumpSpan(
  motion: MotionConstants,
  walkSpeed: number,
  sprint: boolean,
  dy: number,
): number {
  const v = motion.jumpSpeed;
  const g = motion.gravity;
  if (!(g > 0) || !(v > 0)) return 0;
  const disc = v * v - 2 * g * dy;
  if (disc < 0) return 0;
  const airtime = (v + Math.sqrt(disc)) / g;
  const speed = walkSpeed * (sprint ? motion.sprintMultiplier : 1);
  return speed * airtime;
}

/**
 * One bounded, resumable A* search.
 *
 * Created per walk. `step` may be called until it stops returning `'searching'`; after
 * that the answer is in `path` (possibly empty) and `partial` says whether it reaches the
 * goal or merely gets closer to it.
 */
export class PathPlanner {
  readonly limits: PathLimits;
  /** Steps from the start (exclusive) to the destination. Empty until the search ends. */
  path: Step[] = [];
  /** True when `path` stops short of the goal because the budget ran out. */
  partial = false;
  /** Node expansions used so far, for the HUD and the tests. */
  expanded = 0;

  private open = new Heap();
  private came = new Map<number, number>();
  /** How the body arrived at each cell — carried into the path so the follower knows. */
  private via = new Map<number, MoveKind>();
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
   *
   * THE ONE THING A PARTIAL PATH CANNOT PROMISE is that its endpoint has a way back. Every
   * cell on it is reachable and no drop on it is further than `maxFall` — so it can never
   * hurt the character — but a descent into a one-way pocket is a place the next search
   * will honestly report as having no route onward, with the character at the bottom of it.
   * Ruling that out means a second search from every candidate endpoint, which costs more
   * than the bounded search this is the cheap alternative to. The trade is taken knowingly:
   * the failure is visible ("no path" on the HUD), bounded (three blocks, no damage) and
   * needs terrain that is a one-way drop with no route on, which is rare in a built world.
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
      if (move) this.offer(key, g, move);
    }
    // Headroom to jump AT ALL is a property of where the body is standing, not of where it
    // is going, so it is asked once rather than once per candidate: the body rises about a
    // block, and a ceiling it would clip means there is no jump from here in any direction.
    if (this.limits.maxJumpCells < 2) return;
    if (this.world.classify(cell[0], cell[1] + 2, cell[2]) !== 'air') return;
    for (const [dx, dz] of JUMP_DIRECTIONS) {
      // Somewhere to stand in the very next cell means a WALKING edge already covers this
      // direction, and every jump over it would be a dearer way to do the same thing. Also
      // asked once per direction rather than once per distance — it is the same cell — which
      // is what keeps the jump search from tripling the cost of an ordinary open-ground node.
      if (this.standableNear(cell[0] + dx, cell[1], cell[2] + dz)) continue;
      for (let d = 2; d <= this.limits.maxJumpCells; d++) {
        const jump = this.jump(cell, dx * d, dz * d, d);
        if (jump) this.offer(key, g, jump);
      }
    }
  }

  /** Relax one edge. Shared by walking and jumping so they cannot book-keep differently. */
  private offer(key: number, g: number, edge: Edge): void {
    const [next, cost, kind] = edge;
    const nk = this.key(next);
    const ng = g + cost;
    const known = this.gScore.get(nk);
    if (known !== undefined && known <= ng) return;
    this.cells.set(nk, next);
    this.gScore.set(nk, ng);
    this.came.set(nk, key);
    this.via.set(nk, kind);
    const h = heuristic(next, this.goal);
    if (h < this.best.h) this.best = { key: nk, h };
    this.open.push(nk, ng + h);
  }

  /**
   * One walking move, or null if a player could not make it.
   *
   * The height search runs downwards from a step up, so the FIRST landing found is the
   * highest one — which is what walking off a ledge does. Searching upwards would let a
   * route drop three blocks into a pit that has a floor at the bottom when it could have
   * walked across the top.
   */
  private move(from: Cell, dx: number, dz: number, diagonal: boolean): Edge | null {
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
    return [[nx, ny, nz], stepCost(diagonal, y, ny), 'walk'];
  }

  /**
   * One jump across a gap, or null if the body could not make it.
   *
   * FOUR THINGS HAVE TO HOLD, and each of them is a way the old "there is no jump move"
   * planner was at least honest:
   *
   *   1. it is really a gap, and there is room to jump at all — both established by the
   *      caller, once per direction rather than once per distance; see `expand`
   *   2. the body fits the whole way — every cell in between is clear at body height AND
   *      one block above it, because a jump rises about a block and a ceiling it clips is a
   *      jump that lands in the gap
   *   3. there is something to land on, within a step up or a safe drop
   *   4. the game's own constants say the body travels far enough to get there — see
   *      `jumpSpan`. This is the check that makes "it should sprint-jump the wide ones"
   *      true without anybody typing in how wide a sprint jump is.
   */
  private jump(from: Cell, dx: number, dz: number, cells: number): Edge | null {
    const [x, y, z] = from;
    const nx = x + dx;
    const nz = z + dz;
    if (this.outOfRange(nx, nz)) return null;
    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);
    const ny = this.jumpLanding(nx, nz, y);
    if (ny === null) return null;
    if (!this.flightClear([x, y, z], [stepX, stepZ], cells, ny)) return null;
    const needed = cells - JUMP_LANDING_MARGIN;
    const m = this.limits;
    if (jumpSpan(m.motion, m.walkSpeed, false, ny - y) >= needed) {
      return [[nx, ny, nz], cells + JUMP_COST, 'jump'];
    }
    if (m.sprint && jumpSpan(m.motion, m.walkSpeed, true, ny - y) >= needed) {
      return [[nx, ny, nz], cells + SPRINT_JUMP_COST, 'sprint'];
    }
    return null;
  }

  /**
   * Is every cell between take-off and landing clear of the body, and of its head?
   *
   * Checked at the HIGHER of the two ends plus one, because the body rises about a block
   * during a jump and a route that clips a ceiling comes down in the gap. Conservative on
   * purpose: it refuses a jump through a two-block-high tunnel that would in fact fit,
   * which costs a detour, where the other direction costs a character in a hole.
   */
  private flightClear(
    from: Cell,
    dir: readonly [number, number],
    cells: number,
    ny: number,
  ): boolean {
    const over = Math.max(from[1], ny);
    for (let i = 1; i < cells; i++) {
      const cx = from[0] + dir[0] * i;
      const cz = from[2] + dir[1] * i;
      if (!this.bodyClear(cx, over, cz)) return false;
      if (this.world.classify(cx, over + 2, cz) !== 'air') return false;
    }
    return true;
  }

  /**
   * Where a jump lands, searched downwards from one block up.
   *
   * Downwards for the same reason walking searches downwards: the first landing found is
   * the highest one, and a jump that could come down on a ledge must not be planned to
   * carry on past it into the pit underneath.
   */
  private jumpLanding(nx: number, nz: number, y: number): number | null {
    for (let ny = y + 1; ny >= y - this.limits.maxFall; ny--) {
      if (this.standable(nx, ny, nz)) return ny;
    }
    return null;
  }

  /** Is there anywhere to stand in this column, within a step up or a safe drop? */
  private standableNear(x: number, y: number, z: number): boolean {
    return groundWithin(this.world, x, y, z, this.limits.maxFall);
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

  private rebuild(key: number): Step[] {
    const out: Step[] = [];
    let k: number | undefined = key;
    while (k !== undefined && k !== this.key(this.start)) {
      out.push({ cell: this.cells.get(k)!, move: this.via.get(k) ?? 'walk' });
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

/** A candidate move: where it lands, what it costs, and how the body gets there. */
type Edge = [Cell, number, MoveKind];

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
 *
 * THERE IS NO JUMP IN HERE, deliberately, and that is what stops `smoothPath` swallowing
 * one: a leg that crosses a gap is not walkable, so the straightener cannot merge across
 * it and every jump survives into the route as a leg of its own.
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
 * A merged leg is by construction a plain WALK — `walkableLine` proved it — so the merged
 * waypoint is re-labelled as one. A leg that could not be merged keeps whatever the search
 * said it was, which is how a jump keeps its label all the way to the follower.
 *
 * The lookahead is capped so this stays linear-ish: the search can return a hundred cells
 * and checking every pair would cost more than the search did.
 */
export function smoothPath(
  world: NavWorld,
  start: Cell,
  path: readonly Step[],
  maxFall = DEFAULT_LIMITS.maxFall,
): Step[] {
  const out: Step[] = [];
  let anchor = start;
  let i = 0;
  while (i < path.length) {
    let best = i;
    const limit = Math.min(path.length - 1, i + SMOOTH_LOOKAHEAD);
    for (let j = limit; j > i; j--) {
      if (walkableLine(world, anchor, path[j].cell, maxFall)) { best = j; break; }
    }
    out.push(best === i ? path[i] : { cell: path[best].cell, move: 'walk' });
    anchor = path[best].cell;
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
 * Is there anywhere to stand in this column, within `maxFall` below and a step above?
 *
 * The follower's ledge guard asks this about the cell it is about to walk into: a column
 * with no answer is a drop the plan did not authorise, and walking into it is the "it fell
 * off the edge" failure. Exported because that check has to ask exactly the question the
 * planner asked, and a second implementation of it would drift.
 */
export function groundWithin(
  world: NavWorld,
  x: number,
  y: number,
  z: number,
  maxFall = DEFAULT_LIMITS.maxFall,
): boolean {
  for (let ny = y + 1; ny >= y - maxFall; ny--) if (standable(world, x, ny, z)) return true;
  return false;
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
