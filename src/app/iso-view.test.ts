/**
 * Tests for the isometric / RTS camera.
 *
 * Two things are worth pinning here and they are both things a screenshot cannot show.
 *
 * The first is THE WALK, and it is pinned by actually walking it. The route is planned in
 * pathfind.ts and executed by `PredictedBody` — the game's own extracted gravity, jump
 * strength, step height and collision — so a test that only inspected the messages this
 * class emits would prove nothing about whether the character arrives. So the walking tests
 * below close the loop: `steer` decides, the real simulation moves, `frame` follows, one
 * sixtieth of a second at a time, and the assertion is where the body ENDED UP.
 *
 * That matters because of what was actually broken. This view used to send
 * `{t:'input', forward:true}` at the bridge, and the bridge had stopped turning input
 * frames into movement — `FakePlayer.input()` issues no `move` command at all now that the
 * body is driven by `tp` from the local simulation. Meanwhile nothing in this mode was
 * stepping that simulation, because `LiveControls` is unbound here and its intent is
 * all-false. Every layer reported success and the character never moved. A test that
 * asserted "a forward frame went on the wire" would have passed the whole time.
 *
 * The second is the REVEAL, which is the requirement that makes the mode usable at all:
 * the character must never be hidden by whatever is between it and the camera. What that
 * costs — how the hole is placed and sized, and what it must NOT touch — is pinned in
 * viewer-reveal.test.ts, because it is the renderer that answers it. What is pinned here
 * is that this view asks the question, asks it about the right point, and stops asking on
 * the way out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { IsoView, CLICK_TO_WALK_ENABLED } from './iso-view.js';
import type { ControlIntent } from './live-controls.js';
import type { VoxelSource } from './raycast.js';
import type { Cell, NavClass, NavWorld } from './pathfind.js';
import type { BlockShapes } from './block-shapes.js';
import { PredictedBody } from './predict.js';
import { FALLBACK_MOTION, SEED_SPEED } from './physics.js';

const GROUND_Y = 64;

/** Solid everywhere below `GROUND_Y`, sky above — so the top face of the world is y=63. */
const flatWorld: VoxelSource = { getState: (_x, y) => (y < GROUND_Y ? 1 : 0) };

/** The same shape of world the picker sees, in the terms the planner asks in. */
function navFrom(solid: (x: number, y: number, z: number) => boolean): NavWorld {
  return {
    classify: (x, y, z): NavClass => (solid(x, y, z) ? 'solid' : 'air'),
    known: () => true,
  };
}

const flatNav = navFrom((_x, y) => y < GROUND_Y);

interface Harness {
  iso: IsoView;
  sent: ControlIntent[];
  subject: Array<readonly [number, number, number] | null>;
  camera: PerspectiveCamera;
  canvas: EventTarget & { clientWidth: number; clientHeight: number };
  touch: (type: string, points: Array<{ identifier: number; clientX: number; clientY: number }>) => void;
  /** The same blocks again, as collision boxes, for the simulation that walks the route. */
  shapes: BlockShapes;
}

/**
 * Collision boxes for the picker's own world, so the PHYSICS sees what the planner sees.
 *
 * Derived from `getState` rather than written out separately, on purpose: the whole point
 * of these tests is that the planner, the picker and the simulation are looking at one
 * world. Two hand-written worlds could disagree, and the bug that would hide is exactly the
 * one this file exists to catch — a route planned over one world and walked through another.
 */
function shapesOf(world: VoxelSource): BlockShapes {
  return {
    boxesAt: (x, y, z) => (world.getState(x, y, z)
      ? [[x, y, z, x + 1, y + 1, z + 1] as const] : []),
    hardnessAt: () => null,
    // These worlds are entirely known: the test is about the route, not about streaming.
    known: () => true,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
}

/**
 * Walk the route with the game's own physics until it ends, and say where the body got to.
 *
 * THE LOOP IS THE ONE LiveView RUNS: steer from where the body is, step the simulation with
 * what the steering asked for, then put the camera on the result. Written out here rather
 * than faked so that an ordering mistake in live-view.ts — deciding the intent from a
 * position the body has already left, say — shows up as a walk that does not arrive.
 */
function walkOut(
  iso: IsoView,
  shapes: BlockShapes,
  from: readonly [number, number, number],
  frames = 3000,
): { body: PredictedBody; intents: PredictIntentLog[] } {
  const body = new PredictedBody(shapes, FALLBACK_MOTION);
  body.reset(from);
  const intents: PredictIntentLog[] = [];
  const dt = 1 / 60;
  let now = 1000;
  for (let i = 0; i < frames; i++) {
    now += dt * 1000;
    iso.steer(body.position, now);
    const intent = iso.intent();
    intents.push({ ...intent, y: body.position[1] });
    body.step(dt, intent, iso.walkYaw);
    iso.frame(body.position);
    if (iso.walkStatus === 'arrived' || iso.walkStatus === 'no path'
      || iso.walkStatus === 'stuck') break;
  }
  return { body, intents };
}

interface PredictIntentLog {
  forward: boolean;
  sprint: boolean;
  jump: boolean;
  analog?: { x: number; y: number } | null;
  /** Where the feet were when this intent was issued — for "it never fell" assertions. */
  y: number;
}

/** How far the body ended up from the centre of the cell it was sent to. */
function missBy(body: PredictedBody, cell: Cell): number {
  const p = body.position;
  return Math.hypot(cell[0] + 0.5 - p[0], cell[2] + 0.5 - p[2]);
}

function harness(world: VoxelSource = flatWorld, nav: NavWorld = flatNav): Harness {
  const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 600 });
  (globalThis as Record<string, unknown>).window = new EventTarget();
  (globalThis as Record<string, unknown>).document = new EventTarget();

  const camera = new PerspectiveCamera(70, 800 / 600, 0.1, 2000);
  const sent: ControlIntent[] = [];
  const subject: Array<readonly [number, number, number] | null> = [];
  const iso = new IsoView({
    canvas: canvas as unknown as HTMLCanvasElement,
    camera,
    world,
    nav,
    send: (m) => sent.push(m),
    setSubject: (pos) => subject.push(pos),
    // The SAME constants `walkOut` builds the body from. Passed explicitly rather than left
    // to the default so that the wiring itself is covered: a planner reading different
    // gravity from the body that walks its route is the failure this parameter exists for.
    motion: () => ({ motion: FALLBACK_MOTION, speed: SEED_SPEED }),
  });
  const touch = (type: string, points: Array<{ identifier: number; clientX: number; clientY: number }>) => {
    canvas.dispatchEvent(Object.assign(new Event(type), { changedTouches: points }));
  };
  return { iso, sent, subject, camera, canvas, touch, shapes: shapesOf(world) };
}

/** One solid/air predicate, wired up as all three views of the world at once. */
function walkHarness(solid: (x: number, y: number, z: number) => boolean): Harness {
  return harness({ getState: (x, y, z) => (solid(x, y, z) ? 1 : 0) }, navFrom(solid));
}

const at = (x: number, z: number): [number, number, number] => [x, GROUND_Y, z];

// ---------------------------------------------------------------------------
// The camera

/**
 * The feature switch, asserted BOTH WAYS.
 *
 * These tests were skipped behind this flag while click-to-walk was out of service, and the
 * skip is gone because the flag is back on. What is kept is the pairing: whichever way the
 * switch is set, a tap must do exactly one of two things and never something in between.
 * A control that half-acts is worse than one that does nothing, which is why it was turned
 * off in the first place.
 */
test('the switch decides whether a tap is a destination at all', () => {
  const { iso } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const ordered = iso.walkTo(300, 200);
  if (CLICK_TO_WALK_ENABLED) {
    assert.ok(ordered, 'with the feature on, a tap on the ground orders a walk');
    assert.notEqual(iso.walkTarget, null, 'and names a destination');
  } else {
    assert.equal(ordered, false, 'a paused click must not be taken as a destination');
    assert.equal(iso.walkTarget, null, 'a paused click must not set a destination');
  }
});

test('the camera sits above and behind the character and looks down at it', () => {
  const { iso, camera } = harness();
  iso.bind();

  iso.update(at(100, 200));

  assert.ok(camera.position.y > GROUND_Y + 10, 'an isometric camera is ABOVE the subject');
  // It is `dist` away from the focus, in three dimensions — that is what makes it a fixed
  // framing rather than a top-down map.
  const d = Math.hypot(
    camera.position.x - 100,
    camera.position.y - (GROUND_Y + 1),
    camera.position.z - 200,
  );
  assert.ok(Math.abs(d - iso.dist) < 0.001, `expected the camera ${iso.dist} away, got ${d}`);
  assert.ok(camera.rotation.x < 0, 'pitched down');
  // Narrowed field of view is what stands in for an orthographic projection here.
  assert.ok(camera.fov < 40, 'a 70 degree view has far too much perspective to read as iso');
});

test('leaving the mode puts back the field of view and the reveal it asked for', () => {
  const { iso, camera, subject } = harness();
  const before = camera.fov;
  iso.bind();
  iso.update(at(0, 0));
  assert.notEqual(camera.fov, before);

  iso.unbind();

  assert.equal(camera.fov, before, 'first person must not inherit the isometric lens');
  assert.equal(subject.at(-1), null, 'and must not inherit a hole cut in the world');
});

// ---------------------------------------------------------------------------
// The reveal — "see the thing you are driving"

test('the subject named to the renderer is the character, every frame', () => {
  const { iso, subject } = harness();
  iso.bind();

  iso.update([10, 71.8, 20]);

  assert.deepEqual(subject.at(-1), [10, 71.8, 20]);
});

/**
 * THE BUG THE OLD MODEL HAD. The reveal used to be a clipping plane at `playerY + 3`, so
 * the number handed to the renderer changed every time the character stepped up or down —
 * and that number governed the WHOLE SCENE, which is why walls in the distance jumped up
 * and down as you walked. What is handed over now is a position, and a position going up
 * by one block cannot mean anything to geometry that is nowhere near it. Pinned as the
 * absence of a height: there is no longer a scene-wide number to move.
 */
test('walking up a step changes the subject and nothing else', () => {
  const { iso, subject } = harness();
  iso.bind();

  iso.update([10, 64, 20]);
  iso.update([10, 65, 20]);

  const [low, high] = subject.slice(-2) as Array<readonly [number, number, number]>;
  assert.deepEqual([low[0], low[2]], [high[0], high[2]]);
  assert.equal(high[1] - low[1], 1, 'the only thing that moved is the character itself');
});

/**
 * The camera is placed BEFORE the subject is announced, because the renderer projects that
 * point through the camera to find it on screen. Announcing first would place the hole
 * through last frame's camera — the character would sit outside its own reveal whenever
 * the view was moving, which is precisely the popping this replaced.
 */
test('the camera is placed before the subject is announced', () => {
  const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 600 });
  (globalThis as Record<string, unknown>).window = new EventTarget();
  (globalThis as Record<string, unknown>).document = new EventTarget();
  const camera = new PerspectiveCamera(70, 800 / 600, 0.1, 2000);
  const seen: Array<number> = [];
  const iso = new IsoView({
    canvas: canvas as unknown as HTMLCanvasElement,
    camera,
    world: flatWorld,
    nav: flatNav,
    send: () => {},
    setSubject: () => seen.push(camera.position.y),
  });
  iso.bind();

  iso.update(at(100, 200));

  assert.ok(seen[0] > GROUND_Y + 10, 'the camera was still at its old place when asked');
});

// ---------------------------------------------------------------------------
// Click to move
//
// The route is worked out in pathfind.ts and pinned there. What is pinned HERE is the
// join: that a tap becomes a goal, that the search runs on a frame budget without moving
// the character, that the steering is handed one waypoint at a time, and — the thing this
// replaced — that a walk with no route stands still and says so instead of shoving.

/** Run frames until the walk settles, so a test does not have to count search budgets. */
function settle(
  iso: IsoView,
  pos: () => [number, number, number],
  frames = 60,
  step = 100,
): void {
  for (let i = 0; i < frames; i++) {
    iso.update(pos(), 1000 + i * step);
    // One more frame once the search has answered: the frame that finds a route does not
    // also steer along it, so a caller that stopped here would see a plan and no movement.
    if (iso.walkStatus !== 'planning') {
      iso.update(pos(), 1000 + (i + 1) * step);
      return;
    }
  }
}

test('tapping the ground walks the character there — and the body actually gets there', () => {
  const { iso, sent, touch, shapes } = harness();
  iso.bind();
  iso.update(at(100, 200));
  sent.length = 0;

  // A tap: down and up in the same place, well inside the slop and the time limit.
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 200 }]);

  const target = iso.walkTarget;
  assert.ok(target, 'a tap on solid ground must produce a destination');
  assert.equal(target![1], GROUND_Y, 'the character stands ON the block, not inside it');

  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'arrived', 'the walk has to END, not merely start');
  assert.equal(iso.walkTarget, null);
  assert.ok(missBy(body, target!) <= 0.25,
    `stopped ${missBy(body, target!).toFixed(2)} blocks from the block that was tapped`);
  assert.ok(intents.some((i) => i.forward), 'it has to have been told to walk at some point');
  assert.equal(iso.intent().forward, false, 'and told to stand still once it arrived');
  const look = sent.find((m) => m.t === 'look');
  assert.ok(look, 'the server-side body has to be turned to face where it is walking');
  assert.equal(look!.pitch, 0, 'an RTS character looks where it walks, not at its feet');
});

/**
 * THE FAILURE THIS FEATURE EXISTS TO REMOVE. Steering set off towards any destination and
 * discovered it was impossible by shoving into it for four seconds. A plan knows before
 * the first step, so the character must not move at all.
 */
test('a destination with no route moves the character not one step', () => {
  // An island one block wide, surrounded by void. Nothing can be walked to.
  const island = (x: number, y: number, z: number) => y < GROUND_Y && x === 100 && z === 200;
  const { iso, shapes } = walkHarness(island);
  iso.bind();
  iso.update(at(100, 200));

  iso.walkToCell([106, GROUND_Y, 200], 0);
  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'no path');
  assert.equal(iso.walkTarget, null);
  assert.deepEqual(intents.filter((i) => i.forward), [],
    'it must never have been told to walk');
  assert.ok(Math.hypot(body.position[0] - 100.5, body.position[2] - 200.5) < 0.01,
    'and must not have moved');
});

test('the search is spread across frames rather than stalling one', () => {
  // A big open plain, so the search has somewhere to spend a budget.
  const { iso } = harness();
  iso.bind();
  iso.update(at(0, 0));
  iso.walkTo(300, 200, 0);

  iso.update(at(0, 0), 100);
  // One frame of search is a bounded number of expansions; the character stands still
  // while it runs rather than setting off on a guess.
  assert.ok(['planning', 'walking'].includes(iso.walkStatus));
  assert.equal(iso.intent().forward, false, 'and it holds nothing while it thinks');
});

/**
 * A WALK LONGER THAN ONE SEARCH, which is the case the "arrives" requirement is easiest to
 * fail quietly on.
 *
 * The search is capped at a 64-block radius on purpose — an unbounded one drops a frame on
 * a phone — so anything further comes back as a PARTIAL route that stops short and has to
 * be extended when the body gets to the end of it. The trap is that the end of a partial
 * route looks exactly like the end of a finished one, and reporting ARRIVED there is a
 * silent failure wearing a success message. So this walks a distance that cannot be planned
 * in one go and asserts on where the BODY ends up, not on what the status says.
 */
test('a destination beyond one search still gets walked all the way to', () => {
  const { iso, shapes } = harness();
  iso.bind();
  iso.update([0.5, GROUND_Y, 0.5], 0);
  iso.walkToCell([90, GROUND_Y, 0], 0);

  const { body } = walkOut(iso, shapes, [0.5, GROUND_Y, 0.5], 4000);

  assert.equal(iso.walkStatus, 'arrived', `walk ended as ${iso.walkStatus}`);
  assert.ok(missBy(body, [90, GROUND_Y, 0]) <= 0.25,
    `stopped ${missBy(body, [90, GROUND_Y, 0]).toFixed(2)} blocks short`);
});

// ---------------------------------------------------------------------------
// Stepping up, jumping gaps, sprint-jumping wide ones.
//
// All three are the SAME mechanism seen from different sides: the planner refuses any move
// the game's constants say the body cannot make, and the follower asks for a jump at the
// moment the plan was measured from. Every one of these walks the route with the real
// `PredictedBody`, so passing means the body landed on its feet, not that a flag was set.

test('a one-block rise is climbed, not walked into', () => {
  // Everything from x=105 on is one block higher. The simulation steps 0.6 by itself, so a
  // full block is a JUMP — and that jump is read off the terrain, because a straightened
  // leg carries no record of where in it the rise was.
  const solid = (x: number, y: number, _z: number) =>
    y < GROUND_Y || (x >= 105 && y < GROUND_Y + 1);
  const { iso, shapes } = walkHarness(solid);
  iso.bind();
  iso.update([100.5, GROUND_Y, 200.5]);
  iso.walkToCell([110, GROUND_Y + 1, 200], 0);

  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'arrived', `walk ended as ${iso.walkStatus}`);
  assert.ok(body.position[1] >= GROUND_Y + 0.99,
    `it has to end up ON the shelf, got y=${body.position[1].toFixed(2)}`);
  assert.ok(intents.some((i) => i.jump), 'a full block needs a jump; 0.6 of one does not');
});

test('a one-block gap is jumped, and the body lands on the far side', () => {
  const solid = (x: number, y: number, _z: number) => y < GROUND_Y && x !== 105;
  const { iso, shapes } = walkHarness(solid);
  iso.bind();
  iso.update([100.5, GROUND_Y, 200.5]);
  iso.walkToCell([110, GROUND_Y, 200], 0);

  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'arrived', `walk ended as ${iso.walkStatus}`);
  assert.ok(missBy(body, [110, GROUND_Y, 200]) <= 0.25, 'it has to reach the far side');
  // IT NEVER FELL IN. The hole has no floor at all, so a body that dropped into it never
  // comes back — which is what makes this assertion worth more than "it arrived".
  const lowest = Math.min(...intents.map((i) => i.y));
  assert.ok(lowest >= GROUND_Y - 0.01, `the body dipped to y=${lowest.toFixed(2)} on the way`);
  assert.ok(intents.some((i) => i.jump), 'crossing a hole with no floor is a jump');
});

test('a two-block gap is SPRINT-jumped, because a standing jump does not reach', () => {
  const solid = (x: number, y: number, _z: number) =>
    y < GROUND_Y && !(x === 105 || x === 106);
  const { iso, shapes } = walkHarness(solid);
  iso.bind();
  iso.update([100.5, GROUND_Y, 200.5]);
  iso.walkToCell([110, GROUND_Y, 200], 0);

  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'arrived', `walk ended as ${iso.walkStatus}`);
  assert.ok(missBy(body, [110, GROUND_Y, 200]) <= 0.25);
  const lowest = Math.min(...intents.map((i) => i.y));
  assert.ok(lowest >= GROUND_Y - 0.01, `the body dipped to y=${lowest.toFixed(2)} on the way`);
  // The sprint is not decoration: it is the difference between clearing the gap and not.
  assert.ok(intents.some((i) => i.jump && i.sprint),
    'the jump across a two-block gap has to be taken at a run');
});

/**
 * THE REAL GEOMETRY THAT WAS FAILING ON THE LIVE SERVER, kept because it is the one case
 * nobody would have invented.
 *
 * East of the settlement's spawn a walkway has a one-block shaft cut clean through it, and
 * the far side sits a block lower. Read off the live server and off the browser's own world
 * independently, and they AGREE — so this is real terrain, not a stale chunk:
 *
 *     x <= 65   floor top y=67, stand at 68
 *     x == 66   nothing at all, all the way down
 *     x >= 67   floor top y=66, stand at 67
 *
 * The character kept ending up twenty blocks down that shaft. The planner was not wrong
 * about the route — it is a jump, and the simulation makes it — it was wrong about the
 * MARGIN: it chose a walking jump three cells long whose reach beat what it needed by 0.09
 * of a block. Correct arithmetic, and no room at all for a slow frame or the reconciliation
 * nudging the body in mid-air. Tightening JUMP_LANDING_MARGIN turns this into a two-cell
 * jump with most of a block to spare.
 *
 * Asserted by WALKING it with the real physics, from four different approach offsets,
 * because "it works if you start it in exactly the right place" is not the claim.
 */
test('the shaft in the live walkway is crossed, from wherever the character approaches it', () => {
  const solid = (x: number, y: number, _z: number) =>
    (x === 66 ? false : (x <= 65 ? y === 67 : y === 66));

  for (const startX of [64.0, 64.2, 64.5, 64.8]) {
    const { iso, shapes } = walkHarness(solid);
    iso.bind();
    iso.update([startX, 68, 36.5], 0);
    iso.walkToCell([72, 67, 36], 0);

    const { body, intents } = walkOut(iso, shapes, [startX, 68, 36.5]);

    assert.equal(iso.walkStatus, 'arrived', `from x=${startX} the walk ended as ${iso.walkStatus}`);
    assert.ok(missBy(body, [72, 67, 36]) <= 0.25, `from x=${startX} it stopped short`);
    // THE ASSERTION THAT MATTERS: it never entered the shaft. There is no floor in that
    // column at any depth, so a body that dropped into it is gone.
    const lowest = Math.min(...intents.map((i) => i.y));
    assert.ok(lowest >= 66.99,
      `from x=${startX} the body dipped to y=${lowest.toFixed(2)} — that is down the shaft`);
  }
});

test('a gap wider than a sprint jump is refused, and the character does not try it', () => {
  // THE OTHER HALF OF ADDING A JUMP. A planner that will hop is only an improvement if it
  // still says no to the hops the body cannot make — otherwise click-to-move went from
  // walking into things to jumping into holes.
  const solid = (x: number, y: number, _z: number) =>
    y < GROUND_Y && !(x >= 105 && x <= 108);
  const { iso, shapes } = walkHarness(solid);
  iso.bind();
  iso.update([100.5, GROUND_Y, 200.5]);
  iso.walkToCell([110, GROUND_Y, 200], 0);

  const { body, intents } = walkOut(iso, shapes, [100.5, GROUND_Y, 200.5]);

  assert.equal(iso.walkStatus, 'no path', 'the answer is a refusal, not an attempt');
  // It is allowed to walk UP TO the chasm — the search is bounded, so getting closer and
  // re-planning is how it covers distance, and stopping at the lip is what a player does.
  // What it must never do is take off, and it must never end up in the hole.
  assert.deepEqual(intents.filter((i) => i.jump), [],
    'four blocks of nothing is not a jump, so it must not have tried one');
  assert.ok(body.position[1] >= GROUND_Y - 0.01,
    `it ended at y=${body.position[1].toFixed(2)} — that is inside the chasm`);
  assert.ok(body.position[0] < 105,
    `it walked to x=${body.position[0].toFixed(2)}, past the near lip`);
});

/**
 * "NEVER PATH OFF A LEDGE" IS TWO REQUIREMENTS, and this is the second one.
 *
 * The planner covers the first: it has no edge that drops further than is safe. But the
 * body is steered rather than railed, and the world moves — a turtle mines the floor, a
 * chunk unloads — so a route that was correct when it was planned can run off a cliff while
 * it is being walked. The guard reads the cell it is about to enter and stops.
 */
test('ground that vanishes mid-walk stops the character rather than dropping it', () => {
  let hole = false;
  const solid = (x: number, y: number, _z: number) => {
    if (hole && x >= 104 && x <= 112) return false;
    return y < GROUND_Y;
  };
  const { iso, shapes } = walkHarness(solid);
  iso.bind();
  iso.update([100.5, GROUND_Y, 200.5]);
  iso.walkToCell([115, GROUND_Y, 200], 0);

  const body = new PredictedBody(shapes, FALLBACK_MOTION);
  body.reset([100.5, GROUND_Y, 200.5]);
  const dt = 1 / 60;
  let now = 1000;
  for (let i = 0; i < 3000; i++) {
    now += dt * 1000;
    // The floor is mined out from under the route once the character is on its way.
    if (body.position[0] > 102) hole = true;
    iso.steer(body.position, now);
    body.step(dt, iso.intent(), iso.walkYaw);
    iso.frame(body.position);
    if (iso.walkStatus === 'no path' || iso.walkStatus === 'stuck') break;
  }

  assert.ok(['no path', 'stuck'].includes(iso.walkStatus),
    `a route into a hole has to end in a refusal, got ${iso.walkStatus}`);
  assert.ok(body.position[1] >= GROUND_Y - 0.01,
    `it fell to y=${body.position[1].toFixed(2)} instead of stopping at the edge`);
  assert.ok(body.position[0] < 104.5,
    `it walked to x=${body.position[0].toFixed(2)}, past the lip of the hole`);
});

/**
 * THE LEDGE GUARD MUST NOT BE THE THING THAT GIVES UP, and this is a bug the unit tests
 * could not have found — it took watching the real bot.
 *
 * The guard runs every frame. The first version of it answered a ledge by re-planning, and
 * a body standing at a lip therefore spent its entire re-plan budget in four frames: the
 * walk was reported "stuck" 0.2 seconds after it started, long before anything had had a
 * chance to be wrong. Standing still is the guard's whole job; deciding that a leg is
 * hopeless belongs to the stuck detector, which owns a 1.2 second clock for exactly this.
 */
test('standing at a ledge does not burn the whole retry budget in four frames', () => {
  // A world that is floor on the near side and nothing at all past x=104 — so the very
  // first step of the route is over the edge, every frame, from the moment it sets off.
  let hole = false;
  const solid = (x: number, y: number, _z: number) =>
    y < GROUND_Y && !(hole && x >= 104);
  const { iso } = walkHarness(solid);
  iso.bind();
  iso.update([103.5, GROUND_Y, 200.5], 0);
  iso.walkToCell([115, GROUND_Y, 200], 0);
  settle(iso, () => [103.5, GROUND_Y, 200.5]);
  assert.equal(iso.walkStatus, 'walking');
  hole = true;

  // Half a second of frames at the lip. The guard fires on every one of them.
  let t = 2000;
  for (let i = 0; i < 30; i++) iso.update([103.5, GROUND_Y, 200.5], (t += 16));

  assert.equal(iso.intent().forward, false, 'it must not step off the edge');
  assert.notEqual(iso.walkStatus, 'stuck',
    'half a second at a ledge is not enough evidence to abandon the walk');

  // ...and it still ends, on the stuck detector's own clock rather than on the frame rate:
  // a re-plan 1.2 s later, which this time can SEE the hole and reports no route at all.
  // Either terminal answer is honest; taking a fifth of a second to reach one was not.
  const over = ['stuck', 'no path'];
  for (let i = 0; i < 200 && !over.includes(iso.walkStatus); i++) {
    iso.update([103.5, GROUND_Y, 200.5], (t += 500));
  }
  assert.ok(over.includes(iso.walkStatus), `it has to end, got ${iso.walkStatus}`);
  assert.equal(iso.walkTarget, null);
});

test('tapping the sky does nothing at all', () => {
  const { iso, sent } = harness({ getState: () => 0 });
  iso.bind();
  iso.update(at(100, 200));
  sent.length = 0;

  const hit = iso.walkTo(400, 300);

  assert.equal(hit, false);
  assert.equal(iso.walkTarget, null, 'a tap on the horizon must not start a march to nowhere');
  assert.deepEqual(sent, []);
});

/**
 * GESTURE ROUTING. The plain drag used to pan; it now turns the view, because turning is
 * the thing you reach for constantly and panning is not ("the user wants to swipe/drag to
 * rotate the isometric view"). Panning kept a home rather than being dropped: the right
 * button on a mouse, two fingers on a phone.
 *
 * The arrangement is worth a test of its own because it is the one place where a single
 * physical gesture has to be told apart from two others by nothing but how far it moved
 * and how many fingers were down — and getting that wrong means a tap that walks somewhere
 * you did not ask for, or a turn that also orders a walk.
 */
test('a one-finger drag turns the view; it does not pan and does not order a walk', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const yaw0 = iso.yaw;

  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 6; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300 + i * 20, clientY: 200 }]);
  }
  touch('touchend', [{ identifier: 1, clientX: 420, clientY: 200 }]);

  assert.notEqual(iso.yaw, yaw0, 'the drag must turn the view');
  assert.equal(Math.hypot(iso.panX, iso.panZ), 0, 'and must NOT also pan');
  assert.equal(iso.walkTarget, null, 'and must not also order a walk');
});

test('LETTING GO OF A TURN LEAVES IT THERE — no snap back to the isometric diagonal', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const start = iso.yaw;

  // 40 px at 800 px per full turn is 18 degrees: past the tap threshold, so a real turn,
  // and the exact case the old snap undid. A few degrees off the diagonal is the whole
  // point — it is what gives the walls parallax and makes the depth readable.
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 4; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300 + i * 10, clientY: 200 }]);
  }
  // 30 px of turn, not 40: the first 10 px step is inside TAP_SLOP_PX and is what tells a
  // tap from a drag, so it moves nothing. That part is unchanged and deliberate.
  const turned = iso.yaw;
  assert.ok(Math.abs(turned - start - (2 * Math.PI * 30) / 800) < 1e-9,
    `the drag turns by its pixels past the slop, got ${turned - start}`);
  touch('touchend', [{ identifier: 1, clientX: 340, clientY: 200 }]);
  assert.equal(iso.yaw, turned, 'letting go must not move the angle at all');

  // ...and it must still be there many frames later: nothing eases it anywhere.
  let t = 0;
  for (let i = 0; i < 200; i++) iso.update(at(100, 200), (t += 16));
  assert.equal(iso.yaw, turned, 'no settle may creep the angle after the finger is gone');
});

test('a long drag turns by exactly its pixels, so the view can be turned right round', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const start = iso.yaw;

  touch('touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }]);
  for (let i = 1; i <= 20; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 100 + i * 10, clientY: 200 }]);
  }
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 200 }]);

  // 190 px of the 200 turn the view (the first step is the tap slop), and the angle keeps
  // every one of them. THE SECOND ASSERTION IS THE POINT: a drag one step short of a
  // quarter turn used to be rounded up to the quarter, and now it is not.
  assert.ok(Math.abs(Math.abs(iso.yaw - start) - (2 * Math.PI * 190) / 800) < 1e-9,
    `expected the drag's own angle, got ${iso.yaw - start}`);
  assert.ok(Math.abs(Math.abs(iso.yaw - start) - Math.PI / 2) > 1e-3,
    'the angle must NOT have been rounded to the quarter turn it fell just short of');
});

test('two fingers pan, and a second finger leaves the turn it interrupts where it was', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));

  // A turn under way...
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 6; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300 + i * 20, clientY: 200 }]);
  }
  // ...interrupted by a second finger. The angle the first finger reached simply stands:
  // the pinch takes over the gesture, it does not reach back and change the view.
  const turned = iso.yaw;
  touch('touchstart', [{ identifier: 2, clientX: 500, clientY: 400 }]);
  assert.equal(iso.yaw, turned, 'a second finger must not move the angle');

  // Now both fingers slide together: that pans.
  touch('touchmove', [
    { identifier: 1, clientX: 460, clientY: 200 },
    { identifier: 2, clientX: 560, clientY: 400 },
  ]);
  assert.ok(Math.hypot(iso.panX, iso.panZ) > 0, 'two fingers sliding together must pan');
});

test('a tap still walks — the turn must not swallow the destination', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const yaw0 = iso.yaw;

  // Under the slop threshold, so it is a tap and not a turn.
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  touch('touchmove', [{ identifier: 1, clientX: 302, clientY: 201 }]);
  touch('touchend', [{ identifier: 1, clientX: 302, clientY: 201 }]);

  assert.equal(iso.yaw, yaw0, 'a tap must not turn the view');
  assert.notEqual(iso.walkTarget, null, 'a tap must still be a destination');
});

/**
 * The jump is no longer a guess made after 600 ms of getting nowhere. It is read off the
 * block directly in front of the character — solid at foot level with room above it is a
 * step up and nothing else — so it fires where a player would make it, and does NOT fire
 * at a wall it could never climb.
 */
test('a block to step onto gets a jump; a wall does not', () => {
  // A shelf one block high at x >= 105, and a three-block wall at x >= 105 in the z=210 row.
  const shelf = (x: number, y: number, z: number) => x >= 105 && z < 205 && y < GROUND_Y + 1;
  const wall = (x: number, y: number, z: number) => x >= 105 && z >= 205 && y < GROUND_Y + 3;
  const solid = (x: number, y: number, z: number) =>
    y < GROUND_Y || shelf(x, y, z) || wall(x, y, z);
  const { iso } = walkHarness(solid);
  iso.bind();

  // Facing the shelf, close enough to step onto it.
  iso.update([104.5, GROUND_Y, 200.5]);
  iso.walkToCell([110, GROUND_Y + 1, 200], 0);
  // `settle` ends on the first frame that actually follows the route, which is the frame
  // whose intent this is about. Running further frames from a FROZEN position would trip
  // the stuck timer instead, and the halt it issues would wipe the answer.
  settle(iso, () => [104.5, GROUND_Y, 200.5]);
  assert.equal(iso.walkStatus, 'walking');

  assert.equal(iso.intent().jump, true,
    'a block in front at foot level is a step, and a step gets a jump');
  assert.equal(iso.intent().forward, true, 'and it must keep walking while it does');

  // Now the wall row: three blocks of it, which no jump can climb. There is no route to
  // the far side at all, so the walk must refuse rather than hop at the bricks — which is
  // the same refusal, seen from the other end.
  const w2 = walkHarness(solid);
  w2.iso.bind();
  w2.iso.update([104.5, GROUND_Y, 210.5]);
  w2.iso.walkToCell([110, GROUND_Y, 210], 0);
  const { intents } = walkOut(w2.iso, w2.shapes, [104.5, GROUND_Y, 210.5]);
  assert.equal(w2.iso.walkStatus, 'no path');
  assert.deepEqual(intents.filter((i) => i.jump), [],
    'jumping at a three-block wall is the guess this replaced');
});

test('a route the steering cannot follow is abandoned, not shoved at forever', () => {
  const { iso } = harness();
  iso.bind();
  iso.update(at(100, 200));
  iso.walkTo(300, 200, 0);
  settle(iso, () => at(100, 200));
  assert.equal(iso.walkStatus, 'walking');

  // Frozen: the same position for far longer than the stuck timer, over every re-plan the
  // walk is allowed. Re-planning from a place the steering cannot leave gives the same
  // plan, so this has to end.
  const stuck = at(100, 200);
  for (let i = 0; i < 200 && (iso.walkStatus as string) !== 'stuck'; i++) {
    iso.update(stuck, 2000 + i * 500);
  }

  assert.equal(iso.walkStatus, 'stuck');
  assert.equal(iso.walkTarget, null, 'it has to give up eventually');
  assert.equal(iso.intent().forward, false,
    'and stop the character rather than leave it walking');
});

/**
 * THE OUTERMOST GIVE-UP, and the reason it exists separately from every other one.
 *
 * "It always reaches the destination" is only half a requirement; the other half is that a
 * walk which cannot reach it SAYS SO rather than trying forever. Every other stop here is
 * local — this leg is not progressing, this search found nothing — and a walk can satisfy
 * all of them for ever by making a little progress, losing it, and re-planning. The clock
 * is what closes that, so it is pinned on its own.
 */
test('a walk that never ends is ended, however healthy each individual leg looked', () => {
  const { iso } = harness();
  iso.bind();
  iso.update(at(100, 200), 0);
  iso.walkTo(300, 200, 0);

  // Fed a position that keeps closing on the waypoint, so the stuck detector never fires —
  // but so slowly that it would take hours. Only the deadline can end this.
  let x = 100;
  let t = 0;
  for (let i = 0; i < 4000 && (iso.walkStatus as string) !== 'stuck'; i++) {
    x += 0.06;
    t += 60;
    iso.update([x, GROUND_Y, 200], t);
  }

  assert.equal(iso.walkStatus, 'stuck', 'a walk with no end has to be given one');
  assert.equal(iso.walkTarget, null);
  assert.equal(iso.intent().forward, false);
});

// ---------------------------------------------------------------------------
// Framing gestures

test('zoom is clamped at both ends', () => {
  const { iso } = harness();
  iso.bind();

  for (let i = 0; i < 100; i++) iso.zoomBy(0.5);
  assert.ok(iso.dist >= 1, 'zooming in cannot put the camera inside the character');
  const near = iso.dist;

  for (let i = 0; i < 100; i++) iso.zoomBy(2);
  assert.ok(iso.dist > near);
  assert.ok(iso.dist <= 200, 'zooming out cannot leave the character a sub-pixel speck');
});

/**
 * The camera follows a character. A pan that can leave it off screen produces a mode where
 * the thing you are driving is nowhere to be found and no gesture obviously brings it back.
 */
test('panning cannot lose the character', () => {
  const { iso } = harness();
  iso.bind();

  for (let i = 0; i < 500; i++) iso.pan(40, 40);

  assert.ok(Math.hypot(iso.panX, iso.panZ) <= 48.001, 'the pan has to be clamped');
});

test('a pinch zooms and does not walk anywhere', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const before = iso.dist;

  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 300 }]);
  touch('touchstart', [{ identifier: 2, clientX: 500, clientY: 300 }]);
  touch('touchmove', [{ identifier: 2, clientX: 700, clientY: 300 }]);
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 300 }]);
  touch('touchend', [{ identifier: 2, clientX: 700, clientY: 300 }]);

  assert.ok(iso.dist < before, 'fingers apart zooms in');
  assert.equal(iso.walkTarget, null, 'a pinch is not a tap and must not order a walk');
});

test('unbinding removes the listeners, so a mode switch really does hand over input', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  iso.unbind();

  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 200 }]);

  assert.equal(iso.walkTarget, null, 'first person must not also be ordering walks');
});

/**
 * THE ELEVATION IS DRAGGABLE TOO, and its clamp is not cosmetic.
 *
 * `pan` divides screen pixels by `sin(-pitch)` to keep the ground under the finger, so a
 * pitch that reaches level divides by zero and a positive one puts the camera under the
 * floor looking up through it. Both ends are pinned here, along with the plain fact that a
 * vertical drag tilts the view at all.
 */
test('a vertical drag tilts the view, and the tilt stays where it is let go', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  const start = iso.pitch;

  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 4; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300, clientY: 200 + i * 10 }]);
  }
  // Dragging DOWN the screen tilts the camera down towards the ground: pitch rises to 0.
  assert.ok(iso.pitch > start, `a downward drag must raise the pitch, got ${iso.pitch}`);
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 240 }]);
  const tilted = iso.pitch;
  let t = 0;
  for (let i = 0; i < 60; i++) iso.update(at(100, 200), (t += 16));
  assert.equal(iso.pitch, tilted, 'nothing may pull the tilt back to the isometric angle');
});

test('THE TILT NEVER REACHES LEVEL AND NEVER GOES BELOW IT, however far you drag', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));

  // Drag down hard enough to swing through level several times over.
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 100; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300, clientY: 200 + i * 20 }]);
  }
  assert.ok(iso.pitch < 0, `the camera must stay above the ground, got ${iso.pitch}`);
  // sin(-pitch) is what `pan` divides by; it must stay comfortably off zero.
  assert.ok(Math.sin(-iso.pitch) > 0.1, `pan would divide by ${Math.sin(-iso.pitch)}`);

  // And the other way: never past straight down, where yaw stops meaning anything.
  touch('touchstart', [{ identifier: 2, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 100; i++) {
    touch('touchmove', [{ identifier: 2, clientX: 300, clientY: 200 - i * 20 }]);
  }
  assert.ok(iso.pitch > -Math.PI / 2, `never past straight down, got ${iso.pitch}`);
});
