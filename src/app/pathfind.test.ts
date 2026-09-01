/**
 * Tests for the walkable-cell planner.
 *
 * WHAT THESE PIN, and why each one is here rather than being obvious:
 *
 * Click-to-move used to be steering — face the point, hold forward, jump if nothing is
 * happening, give up after four seconds. It walked around nothing, so the first tree, wall
 * or fence ended the walk with the character shoving into it. Every test below is one of
 * the things a player does without thinking and that steering could not do at all:
 *
 *   goes around      a wall between here and there is walked around, not into
 *   steps up         one block of rise is climbed; two is not, because the bot cannot
 *   drops down       a ledge is walked off, but only as far as is safe
 *   refuses          a gap it cannot jump, and a destination with no route, are REFUSED —
 *                    it says so instead of setting off and discovering it in four seconds
 *   does not cheat   it will not squeeze diagonally through a corner, walk on water, or
 *                    route through chunks that are not loaded
 *
 * The worlds here are built from predicates rather than fixtures so each test says its
 * geometry out loud in three lines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS, PathPlanner, nearestStandable, smoothPath, walkableLine,
  type Cell, type NavClass, type NavWorld,
} from './pathfind.js';

const GROUND = 64;

/**
 * A world with a floor at y=63 (so cells stand at y=64) and whatever `blocks` says on top.
 * Anything `blocks` returns true for is solid; `avoid` marks water and friends.
 */
function world(
  blocks: (x: number, y: number, z: number) => boolean = () => false,
  avoid: (x: number, y: number, z: number) => boolean = () => false,
  known: (x: number, y: number, z: number) => boolean = () => true,
): NavWorld {
  return {
    classify(x, y, z): NavClass {
      if (avoid(x, y, z)) return 'avoid';
      if (y < GROUND) return 'solid';
      return blocks(x, y, z) ? 'solid' : 'air';
    },
    known,
  };
}

function plan(w: NavWorld, from: Cell, to: Cell, limits = {}) {
  const p = new PathPlanner(w, from, to, limits);
  const state = p.run();
  return { state, path: p.path, partial: p.partial, expanded: p.expanded };
}

/** Does the route ever step onto this cell? */
const visits = (path: Cell[], x: number, z: number) =>
  path.some((c) => c[0] === x && c[2] === z);

// ---------------------------------------------------------------------------
// It goes around.

test('a wall between here and there is walked around, not into', () => {
  // A wall along x=5, from z=-8 to z=8, with the only way round it past z=8.
  const w = world((x, y, z) => x === 5 && y < GROUND + 3 && z >= -8 && z <= 8);
  const { state, path } = plan(w, [0, GROUND, 0], [10, GROUND, 0]);

  assert.equal(state, 'found');
  assert.ok(path.length > 0);
  assert.equal(path.at(-1)!.toString(), [10, GROUND, 0].toString());
  for (const c of path) {
    const inWall = c[0] === 5 && c[2] >= -8 && c[2] <= 8;
    assert.ok(!inWall, `the route walks into the wall at ${c}`);
  }
  // Round the END of it, which means well off the straight line.
  assert.ok(Math.max(...path.map((c) => Math.abs(c[2]))) > 8, 'it has to go round the end');
});

test('a tree trunk is stepped around without ceremony', () => {
  const w = world((x, y, z) => x === 3 && z === 0 && y < GROUND + 6);
  const { state, path } = plan(w, [0, GROUND, 0], [6, GROUND, 0]);

  assert.equal(state, 'found');
  assert.ok(!visits(path, 3, 0), 'it must not route through the trunk');
  // A one-block trunk costs one sidestep and one back; anything much longer is the planner
  // taking a scenic route it did not need.
  assert.ok(path.length <= 9, `expected a short detour, got ${path.length} steps`);
});

test('the way out of a room is through its door', () => {
  // A closed box around the start, one block open at (2, 1).
  const wall = (x: number, z: number) =>
    (x === -2 || x === 2 || z === -2 || z === 2) && !(x === 2 && z === 1);
  const w = world((x, y, z) => wall(x, z) && y < GROUND + 3
    && x >= -2 && x <= 2 && z >= -2 && z <= 2);
  const { state, path } = plan(w, [0, GROUND, 0], [6, GROUND, 0]);

  assert.equal(state, 'found');
  assert.ok(visits(path, 2, 1), 'the only opening is at (2,1) and the route has to use it');
});

// ---------------------------------------------------------------------------
// Up and down.

test('a one-block step is climbed', () => {
  // Everything past x=2 is one block higher.
  const w = world((x, y) => x > 2 && y === GROUND);
  const { state, path } = plan(w, [0, GROUND, 0], [6, GROUND + 1, 0]);

  assert.equal(state, 'found');
  assert.equal(path.at(-1)![1], GROUND + 1);
  assert.ok(path.some((c) => c[1] === GROUND + 1), 'the route has to actually go up');
});

test('a two-block step is REFUSED, because the character cannot make it', () => {
  // A shelf two blocks up, with nothing to climb.
  const w = world((x, y) => x > 2 && (y === GROUND || y === GROUND + 1));
  const { state } = plan(w, [0, GROUND, 0], [6, GROUND + 2, 0]);

  assert.equal(state, 'unreachable', 'no route may be planned that needs a jump it cannot make');
});

test('a step up needs headroom over where it is standing', () => {
  // The step is climbable, but there is a ceiling one block over the character's head on
  // the near side, so it cannot rise into it.
  const step = (x: number, y: number) => x > 2 && y === GROUND;
  const roof = (x: number, y: number) => x <= 2 && y === GROUND + 2;
  const w = world((x, y) => step(x, y) || roof(x, y));
  const { state } = plan(w, [0, GROUND, 0], [6, GROUND + 1, 0]);

  assert.equal(state, 'unreachable', 'you cannot step up into a ceiling');
});

test('a ledge is walked off, and a cliff is not', () => {
  // Ground drops away past x=2, by `drop` blocks. Built directly rather than through the
  // flat-floor helper, because the whole point is that the floor is not flat.
  const at = (drop: number): NavWorld => ({
    classify: (x, y) => (y < (x > 2 ? GROUND - drop : GROUND) ? 'solid' : 'air'),
    known: () => true,
  });
  const safe = plan(at(2), [0, GROUND, 0], [6, GROUND - 2, 0]);
  assert.equal(safe.state, 'found', 'a two-block drop is an ordinary step down');

  const deadly = plan(at(8), [0, GROUND, 0], [6, GROUND - 8, 0]);
  assert.equal(deadly.state, 'unreachable', 'an eight-block drop is not a route, it is a fall');
});

test('a gap it cannot jump is a wall', () => {
  // A one-block-wide chasm all the way across with no floor at all in it, and solid
  // ground on both sides. A player hops this; the planner has no move that does.
  const gapped: NavWorld = {
    classify: (x, y) => (x !== 3 && y < GROUND ? 'solid' : 'air'),
    known: () => true,
  };
  const { state } = plan(gapped, [0, GROUND, 0], [6, GROUND, 0]);
  assert.equal(state, 'unreachable', 'the planner has no jump-a-gap move, so there is no route');
});

// ---------------------------------------------------------------------------
// It does not cheat.

test('a diagonal may not squeeze through the corner of a wall', () => {
  // An L: blocks at (1,0) and (0,1), leaving (1,1) reachable only by cutting the corner.
  const w = world((x, y, z) =>
    y < GROUND + 2 && ((x === 1 && z === 0) || (x === 0 && z === 1)));
  const { state } = plan(w, [0, GROUND, 0], [1, GROUND, 1], { maxRadius: 1 });

  assert.equal(state, 'unreachable', 'cutting a corner walks the body through a block');
});

test('it will not stand in water and will not walk into it', () => {
  const pond = (x: number, _y: number, z: number) => x >= 2 && x <= 4 && z >= -4 && z <= 4;
  const w = world(() => false, (x, y, z) => pond(x, y, z) && y === GROUND);
  const { state, path } = plan(w, [0, GROUND, 0], [6, GROUND, 0]);

  assert.equal(state, 'found');
  for (const c of path) {
    assert.ok(!pond(c[0], c[1], c[2]), `the route wades through the pond at ${c}`);
  }
});

test('unloaded chunks are not walkable, however empty they look', () => {
  // Everything past x=4 is outside the loaded region. `World.getState` answers AIR there,
  // which reads as walkable — that is the trap `known` exists to close. The route stops at
  // the edge of what has been seen rather than marching off into it.
  const w = world(() => false, () => false, (x) => x <= 4);
  const { state, path, partial } = plan(w, [0, GROUND, 0], [10, GROUND, 0]);

  assert.equal(state, 'found');
  assert.equal(partial, true, 'the goal is not reachable, so any route to it is partial');
  for (const c of path) {
    assert.ok(c[0] <= 4, `the route left the loaded world at ${c}`);
  }
});

// ---------------------------------------------------------------------------
// It is affordable, and it is honest when it is not.

test('the search is resumable, and one step costs only what it is given', () => {
  const w = world();
  const p = new PathPlanner(w, [0, GROUND, 0], [40, GROUND, 0]);

  assert.equal(p.step(1), 'searching', 'one node is not an answer');
  assert.ok(p.expanded <= 1, `a budget of 1 expanded ${p.expanded}`);

  let state = p.step(50);
  let rounds = 1;
  while (state === 'searching' && rounds < 500) { state = p.step(50); rounds++; }
  assert.equal(state, 'found');
  assert.equal(p.path.at(-1)!.toString(), [40, GROUND, 0].toString());
});

test('an open plain does not blow the node budget on a straight line', () => {
  const { state, expanded } = plan(world(), [0, GROUND, 0], [50, GROUND, 0]);
  assert.equal(state, 'found');
  // The heuristic is admissible and the plain is empty, so this should be close to the
  // number of cells on the line. A blow-up here means the heuristic stopped guiding.
  assert.ok(expanded < 400, `a straight walk expanded ${expanded} nodes`);
});

/**
 * When the budget runs out, a route that gets meaningfully closer is worth walking and is
 * re-planned on arrival — that is the whole reason the search may be capped. A route that
 * gets nowhere is not, and must be reported as failure rather than walked.
 */
test('a budget that runs out yields a partial route, not a wrong one', () => {
  const w = world();
  const { state, path, partial } = plan(w, [0, GROUND, 0], [60, GROUND, 0], { maxNodes: 30 });

  assert.equal(state, 'found');
  assert.equal(partial, true);
  assert.ok(path.length > 0);
  const end = path.at(-1)!;
  assert.ok(end[0] > 3, 'a partial route has to make real progress toward the goal');
  assert.ok(end[0] < 60, 'and it is not the goal, which is what partial means');
});

test('walled in with nowhere to go is a refusal, not a partial route', () => {
  // A 3x3 pen. Nothing can be reached, so nothing may be offered.
  const w = world((x, y, z) => y < GROUND + 3 && (Math.abs(x) > 1 || Math.abs(z) > 1));
  const { state, path } = plan(w, [0, GROUND, 0], [20, GROUND, 0]);

  assert.equal(state, 'unreachable');
  assert.deepEqual(path, [], 'refusing means offering no route at all');
});

// ---------------------------------------------------------------------------
// Snapping a tap to somewhere a body can stand.

test('a tap on the side of a wall snaps to the ground beside it', () => {
  const w = world((x, y, z) => x === 4 && z === 0 && y < GROUND + 4);
  // The cell "above the block that was hit" when you tap the wall's face at head height.
  const snapped = nearestStandable(w, [4, GROUND + 2, 0]);

  assert.ok(snapped, 'a tap on a wall must not simply do nothing');
  // Somewhere a body actually fits: on top of the wall or on the ground beside it, never
  // inside it. The wall occupies y 64..67 at (4, 0).
  const inside = snapped![0] === 4 && snapped![2] === 0
    && snapped![1] >= GROUND && snapped![1] < GROUND + 4;
  assert.ok(!inside, `snapped inside the wall at ${snapped}`);
  assert.equal(w.classify(snapped![0], snapped![1] - 1, snapped![2]), 'solid', 'on ground');
  assert.equal(w.classify(snapped![0], snapped![1], snapped![2]), 'air', 'with room for feet');
});

test('a tap with nowhere to stand anywhere near it is refused', () => {
  // High in the air over a solid world, well outside the snap radius of any floor.
  const { state } = plan(world(), [0, GROUND, 0], [0, GROUND + 40, 0]);
  assert.equal(state, 'unreachable');
  assert.equal(nearestStandable(world(), [0, GROUND + 40, 0]), null);
});

test('the default limits are the ones the caller gets', () => {
  const p = new PathPlanner(world(), [0, GROUND, 0], [1, GROUND, 0]);
  assert.deepEqual(p.limits, DEFAULT_LIMITS);
});


// ---------------------------------------------------------------------------
// Straightening the route.
//
// A* on a cell grid returns a staircase, and a follower that aims the body at every cell
// spends its time turning instead of walking. MEASURED against the live server before this
// existed: a ten-cell route moved the character four blocks in sixty seconds. The route is
// therefore collapsed to the fewest cells that can still be walked in straight lines.

test('an open plain collapses to a single leg', () => {
  const w = world();
  const p = new PathPlanner(w, [0, GROUND, 0], [20, GROUND, 12]);
  assert.equal(p.run(), 'found');
  assert.ok(p.path.length > 15, 'the raw route is a staircase');

  const smooth = smoothPath(w, [0, GROUND, 0], p.path);
  assert.equal(smooth.length, 1, `nothing is in the way, so it is one leg (got ${smooth.length})`);
  assert.deepEqual(smooth[0], [20, GROUND, 12]);
});

test('straightening may not shortcut through the thing the route went around', () => {
  const w = world((x, y, z) => x === 5 && y < GROUND + 3 && z >= -8 && z <= 8);
  const p = new PathPlanner(w, [0, GROUND, 0], [10, GROUND, 0]);
  assert.equal(p.run(), 'found');

  const smooth = smoothPath(w, [0, GROUND, 0], p.path);
  assert.ok(smooth.length >= 2, 'a route round a wall cannot be one straight leg');
  // Every leg has to be walkable in a straight line, which is what makes it safe to skip
  // the cells in between.
  let from: Cell = [0, GROUND, 0];
  for (const leg of smooth) {
    assert.ok(walkableLine(w, from, leg), `leg ${from} -> ${leg} is not walkable straight`);
    from = leg;
  }
  assert.deepEqual(smooth.at(-1), [10, GROUND, 0], 'and it still ends where it was going');
});

test('a straight line is refused when it would walk through a wall', () => {
  const w = world((x, y, z) => x === 5 && y < GROUND + 3 && z >= -8 && z <= 8);
  assert.equal(walkableLine(w, [0, GROUND, 0], [10, GROUND, 0]), false);
  assert.equal(walkableLine(w, [0, GROUND, 12], [10, GROUND, 12]), true, 'clear of the wall');
});

test('a straight line is refused when it would need a two-block climb', () => {
  const w = world((x, y) => x > 2 && (y === GROUND || y === GROUND + 1));
  assert.equal(walkableLine(w, [0, GROUND, 0], [6, GROUND + 2, 0]), false);
});

test('a straight line over a one-block step is fine', () => {
  const w = world((x, y) => x > 2 && y === GROUND);
  assert.equal(walkableLine(w, [0, GROUND, 0], [6, GROUND + 1, 0]), true);
});
