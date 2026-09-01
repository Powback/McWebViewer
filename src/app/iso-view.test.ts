/**
 * Tests for the isometric / RTS camera.
 *
 * Two things are worth pinning here and they are both things a screenshot cannot show.
 *
 * The first is the STEERING. There is no goto command on the bridge — the whole mod
 * vocabulary is stateful direction holds plus a relative turn — so "click to move" is
 * face-it-and-hold-forward, and the failure modes are all about when it STOPS: on arrival,
 * when it is stuck, and when it has been stuck long enough to give up. A walk that never
 * ends is a bot shoving into a wall forever, and nothing on screen distinguishes that from
 * a crash.
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
import { IsoView } from './iso-view.js';
import type { ControlIntent } from './live-controls.js';
import type { VoxelSource } from './raycast.js';
import type { NavClass, NavWorld } from './pathfind.js';

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
  });
  const touch = (type: string, points: Array<{ identifier: number; clientX: number; clientY: number }>) => {
    canvas.dispatchEvent(Object.assign(new Event(type), { changedTouches: points }));
  };
  return { iso, sent, subject, camera, canvas, touch };
}

const at = (x: number, z: number): [number, number, number] => [x, GROUND_Y, z];

// ---------------------------------------------------------------------------
// The camera

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

test('tapping the ground walks the character there, and stops it on arrival', () => {
  const { iso, sent, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));
  sent.length = 0;

  // A tap: down and up in the same place, well inside the slop and the time limit.
  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  touch('touchend', [{ identifier: 1, clientX: 300, clientY: 200 }]);

  const target = iso.walkTarget;
  assert.ok(target, 'a tap on solid ground must produce a destination');
  assert.equal(target![1], GROUND_Y, 'the character stands ON the block, not inside it');

  settle(iso, () => at(100, 200));
  assert.equal(iso.walkStatus, 'walking');
  assert.ok(iso.plannedPath.length > 0, 'a route, not a bearing');

  const look = sent.find((m) => m.t === 'look');
  const walk = sent.find((m) => m.t === 'input' && m.forward === true);
  assert.ok(look, 'the body has to be turned toward the waypoint before it walks');
  assert.ok(walk, 'and then held forward — there is no goto command on the bridge');
  assert.equal(look!.pitch, 0, 'an RTS character looks where it walks, not at its feet');

  // Walk it: step to each waypoint in turn, as the character actually would.
  const route = [...iso.plannedPath];
  sent.length = 0;
  let t = 2000;
  for (const cell of route) iso.update([cell[0] + 0.5, cell[1], cell[2] + 0.5], (t += 200));
  assert.equal(iso.walkStatus, 'arrived');
  assert.equal(iso.walkTarget, null);
  const stop = sent.find((m) => m.t === 'input');
  assert.ok(stop, 'arriving must put a stop frame on the wire');
  assert.equal(stop!.forward, false);
});

/**
 * THE FAILURE THIS FEATURE EXISTS TO REMOVE. Steering set off towards any destination and
 * discovered it was impossible by shoving into it for four seconds. A plan knows before
 * the first step, so the character must not move at all.
 */
test('a destination with no route moves the character not one step', () => {
  // An island one block wide, surrounded by void. Nothing can be walked to.
  const island = (x: number, y: number, z: number) => y < GROUND_Y && x === 100 && z === 200;
  const { iso, sent } = harness(
    { getState: (x, y, z) => (island(x, y, z) || y < GROUND_Y - 40 ? 1 : 0) },
    navFrom(island),
  );
  iso.bind();
  iso.update(at(100, 200));

  iso.walkTo(300, 200, 0);
  sent.length = 0;
  settle(iso, () => at(100, 200));

  assert.equal(iso.walkStatus, 'no path');
  assert.equal(iso.walkTarget, null);
  assert.deepEqual(
    sent.filter((m) => m.t === 'input' && m.forward === true), [],
    'it must never have been told to walk',
  );
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

test('a press that travels is a pan, not a destination', () => {
  const { iso, touch } = harness();
  iso.bind();
  iso.update(at(100, 200));

  touch('touchstart', [{ identifier: 1, clientX: 300, clientY: 200 }]);
  for (let i = 1; i <= 6; i++) {
    touch('touchmove', [{ identifier: 1, clientX: 300 + i * 20, clientY: 200 }]);
  }
  touch('touchend', [{ identifier: 1, clientX: 420, clientY: 200 }]);

  assert.equal(iso.walkTarget, null, 'dragging the view must not also order a walk');
  assert.ok(Math.hypot(iso.panX, iso.panZ) > 0, 'and must actually pan');
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
  const { iso, sent } = harness({ getState: (x, y, z) => (solid(x, y, z) ? 1 : 0) },
    navFrom(solid));
  iso.bind();

  // Facing the shelf, close enough to step onto it.
  iso.update([104.5, GROUND_Y, 200.5]);
  (iso as unknown as { goal: [number, number, number] }).goal = [110, GROUND_Y + 1, 200];
  (iso as unknown as { walkStatus: string }).walkStatus = 'planning';
  settle(iso, () => [104.5, GROUND_Y, 200.5]);
  assert.equal(iso.walkStatus, 'walking');

  sent.length = 0;
  iso.update([104.5, GROUND_Y, 200.5], 5000);
  const jump = sent.find((m) => m.t === 'input' && m.jump === true);
  assert.ok(jump, 'a block in front at foot level is a step, and a step gets a jump');
  assert.equal(jump!.forward, true, 'and it must keep walking while it does');

  // Now the wall row: three blocks of it, which no jump can climb.
  const w2 = harness({ getState: (x, y, z) => (solid(x, y, z) ? 1 : 0) }, navFrom(solid));
  w2.iso.bind();
  w2.iso.update([104.5, GROUND_Y, 210.5]);
  (w2.iso as unknown as { path: Array<[number, number, number]> }).path = [[110, GROUND_Y, 210]];
  (w2.iso as unknown as { walkStatus: string }).walkStatus = 'walking';
  (w2.iso as unknown as { goal: [number, number, number] }).goal = [110, GROUND_Y, 210];
  w2.sent.length = 0;
  w2.iso.update([104.5, GROUND_Y, 210.5], 5000);
  assert.deepEqual(
    w2.sent.filter((m) => m.t === 'input' && m.jump === true), [],
    'jumping at a three-block wall is the guess this replaced',
  );
});

test('a route the steering cannot follow is abandoned, not shoved at forever', () => {
  const { iso, sent } = harness();
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
  const stop = sent.find((m) => m.t === 'input' && m.forward === false);
  assert.ok(stop, 'and stop the character rather than leave it walking');
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
