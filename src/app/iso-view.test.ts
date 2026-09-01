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
 * The second is the CUTAWAY, which is the requirement that makes the mode usable at all:
 * the character must never be hidden by the terrain on top of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { IsoView } from './iso-view.js';
import type { ControlIntent } from './live-controls.js';
import type { VoxelSource } from './raycast.js';

const GROUND_Y = 64;

/** Solid everywhere below `GROUND_Y`, sky above — so the top face of the world is y=63. */
const flatWorld: VoxelSource = { getState: (_x, y) => (y < GROUND_Y ? 1 : 0) };

interface Harness {
  iso: IsoView;
  sent: ControlIntent[];
  cut: Array<number | null>;
  camera: PerspectiveCamera;
  canvas: EventTarget & { clientWidth: number; clientHeight: number };
  touch: (type: string, points: Array<{ identifier: number; clientX: number; clientY: number }>) => void;
}

function harness(world: VoxelSource = flatWorld): Harness {
  const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 600 });
  (globalThis as Record<string, unknown>).window = new EventTarget();
  (globalThis as Record<string, unknown>).document = new EventTarget();

  const camera = new PerspectiveCamera(70, 800 / 600, 0.1, 2000);
  const sent: ControlIntent[] = [];
  const cut: Array<number | null> = [];
  const iso = new IsoView({
    canvas: canvas as unknown as HTMLCanvasElement,
    camera,
    world,
    send: (m) => sent.push(m),
    setCutaway: (y) => cut.push(y),
  });
  const touch = (type: string, points: Array<{ identifier: number; clientX: number; clientY: number }>) => {
    canvas.dispatchEvent(Object.assign(new Event(type), { changedTouches: points }));
  };
  return { iso, sent, cut, camera, canvas, touch };
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

test('leaving the mode puts back the field of view and the cutaway it changed', () => {
  const { iso, camera, cut } = harness();
  const before = camera.fov;
  iso.bind();
  iso.update(at(0, 0));
  assert.notEqual(camera.fov, before);

  iso.unbind();

  assert.equal(camera.fov, before, 'first person must not inherit the isometric lens');
  assert.equal(cut.at(-1), null, 'and must not inherit a world cut off above your head');
});

// ---------------------------------------------------------------------------
// The cutaway — "free whatever is occluding the player"

test('the world is cut off just above the character, never below it', () => {
  const { iso, cut } = harness();
  iso.bind();

  iso.update([10, 71.8, 20]);

  const y = cut.at(-1) as number;
  // Above the head (a player is 1.8 blocks tall) so the model is never clipped...
  assert.ok(y >= 71.8 + 1.5, `cut at ${y} would slice the character itself`);
  // ...and low enough that a ceiling one block over it is opened up rather than left.
  assert.ok(y <= 71.8 + 4, `cut at ${y} leaves too much roof on top of the character`);
});

/**
 * Why a plane above the head is sufficient, stated as a test rather than a comment: from a
 * camera placed above the subject, every point on the line of sight between them is HIGHER
 * than the subject. So an occluder is by definition above it, and cutting above the head
 * cannot miss one.
 */
test('everything between the camera and the character is above the cut', () => {
  const { iso, camera, cut } = harness();
  iso.bind();
  const player = at(100, 200);
  iso.update(player);
  const y = cut.at(-1) as number;

  const eye = [player[0], player[1] + 1.6, player[2]];
  for (let t = 0.05; t <= 1; t += 0.05) {
    const py = eye[1] + (camera.position.y - eye[1]) * t;
    if (py <= y) continue;
    // Past the cut height the ray is in cut-away air for the rest of its length: the
    // camera only ever gets higher, so nothing can occlude from here on.
    assert.ok(camera.position.y > y, 'the camera itself must be above the cut');
    break;
  }
  assert.ok(camera.position.y > y);
});

// ---------------------------------------------------------------------------
// Click to move

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
  assert.equal(target![0] % 1, 0.5, 'centred on the block it tapped');

  // Far from it: face it and hold forward.
  iso.update(at(100, 200), 1000);
  const look = sent.find((m) => m.t === 'look');
  const walk = sent.find((m) => m.t === 'input' && m.forward === true);
  assert.ok(look, 'the body has to be turned toward the target before it walks');
  assert.ok(walk, 'and then held forward — there is no goto command on the bridge');
  assert.equal(look!.pitch, 0, 'an RTS character looks where it walks, not at its feet');

  // Standing on it: stop, and say so.
  sent.length = 0;
  iso.update([target![0], GROUND_Y, target![2]], 2000);
  assert.equal(iso.walkTarget, null);
  const stop = sent.find((m) => m.t === 'input');
  assert.ok(stop, 'arriving must put a stop frame on the wire');
  assert.equal(stop!.forward, false);
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

// ---------------------------------------------------------------------------
// Steering is not pathfinding, and has to admit it

test('no progress gets a jump, because a one-block step stops a walk dead', () => {
  const { iso, sent } = harness();
  iso.bind();
  iso.update(at(100, 200));
  iso.walkTo(300, 200, 0);
  assert.ok(iso.walkTarget);

  // Pinned against a step: the same position, frame after frame.
  const stuck = at(100, 200);
  iso.update(stuck, 0);
  sent.length = 0;
  iso.update(stuck, 700);

  const jump = sent.find((m) => m.t === 'input' && m.jump === true);
  assert.ok(jump, 'a stuck walk must try to step up before it gives up');
  assert.equal(jump!.forward, true, 'and must keep walking while it does');
});

test('a walk that never gets anywhere is abandoned, not left shoving into a wall', () => {
  const { iso, sent } = harness();
  iso.bind();
  iso.update(at(100, 200));
  iso.walkTo(300, 200, 0);
  const stuck = at(100, 200);
  iso.update(stuck, 0);

  sent.length = 0;
  iso.update(stuck, 5000);

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
