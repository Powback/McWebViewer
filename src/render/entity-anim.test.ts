/**
 * Generic entity animation.
 *
 * These pin the behaviour that makes a mob read as alive rather than broken, and — just as
 * importantly — the cases where it must do NOTHING. A limb swinging while the mob stands
 * still, or an unknown part rotating through the body, is worse than bind pose.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  classifyPart, partRotation, wrapDegrees, MotionTracker, NO_ROTATION,
  type MotionState,
} from './entity-anim.js';

function motion(over: Partial<MotionState> = {}): MotionState {
  return {
    speed: 0, distance: 0, time: 0, headYawDeg: 0, pitchDeg: 0, airborne: false, ...over,
  };
}

// ---------------------------------------------------------------------------
// Classification — the part names vanilla uses and every mod copies.

test('vanilla part names classify the way the models actually name them', () => {
  assert.equal(classifyPart('head'), 'head');
  assert.equal(classifyPart('leg0'), 'limb');
  assert.equal(classifyPart('right_leg'), 'limbOpposed');
  assert.equal(classifyPart('left_wing'), 'wing');
  assert.equal(classifyPart('body'), 'static');
});

test('classification is case-insensitive, because mod part names are not consistent', () => {
  assert.equal(classifyPart('HEAD'), 'head');
  assert.equal(classifyPart('Left_Wing'), 'wing');
});

test('an UNKNOWN part is static — the safe direction', () => {
  // A part we cannot classify keeps exactly the pose the extracted geometry gave it. The
  // failure is then "a modded mob does not animate", not "a modded mob turns inside out".
  for (const n of ['saddle', 'chest_left', 'nose', 'mystery_thing', '']) {
    assert.equal(classifyPart(n), 'static');
    assert.deepEqual(partRotation(classifyPart(n), motion({ speed: 5 })), NO_ROTATION);
  }
});

// ---------------------------------------------------------------------------
// The gait.

test('a standing mob does not move its legs AT ALL', () => {
  // The single most important negative: amplitude scales with speed, so a stopped mob
  // settles to bind pose instead of freezing mid-stride or marching on the spot.
  const r = partRotation('limb', motion({ speed: 0, distance: 12.5 }));
  assert.equal(r.x, 0);
});

test('a walking mob swings its legs', () => {
  const r = partRotation('limb', motion({ speed: 4, distance: 0 }));
  assert.ok(Math.abs(r.x) > 0.5, `leg barely moved: ${r.x}`);
});

test('opposite limbs swing in OPPOSITION, not together', () => {
  const m = motion({ speed: 4, distance: 1.1 });
  const a = partRotation('limb', m).x;
  const b = partRotation('limbOpposed', m).x;
  assert.ok(a * b < 0 || Math.abs(a - b) > 1,
    `both limbs swung the same way (${a} vs ${b}) — the mob would hop, not walk`);
});

test('gait phase follows DISTANCE, not time — a slow walk takes slow steps', () => {
  // Same elapsed time, different distance: the leg angle must differ. Driving the phase off
  // a clock instead makes a slowly-walking mob scurry.
  const a = partRotation('limb', motion({ speed: 2, distance: 0, time: 10 })).x;
  const b = partRotation('limb', motion({ speed: 2, distance: 1.2, time: 10 })).x;
  assert.notEqual(a, b);
});

test('swing amplitude scales with speed and saturates', () => {
  const at = (speed: number) => Math.abs(partRotation('limb', motion({ speed, distance: 0 })).x);
  assert.ok(at(1) < at(2), 'a faster mob should swing further');
  assert.ok(at(2) < at(4));
  assert.ok(Math.abs(at(4) - at(40)) < 1e-9, 'amplitude must saturate, not grow without bound');
});

// ---------------------------------------------------------------------------
// The head.

test('the head follows the look angles', () => {
  const r = partRotation('head', motion({ headYawDeg: 30, pitchDeg: -20 }));
  assert.ok(Math.abs(r.y - (30 * Math.PI) / 180) < 1e-9);
  assert.ok(Math.abs(r.x - (-20 * Math.PI) / 180) < 1e-9);
});

test('a head yaw of 350 turns -10, not the long way round', () => {
  assert.equal(wrapDegrees(350), -10);
  assert.equal(wrapDegrees(-350), 10);
  assert.equal(wrapDegrees(180), -180);
  assert.equal(wrapDegrees(0), 0);
  const r = partRotation('head', motion({ headYawDeg: 350 }));
  assert.ok(r.y < 0, 'the head span the long way round');
});

// ---------------------------------------------------------------------------
// Wings.

test('wings beat only while airborne', () => {
  assert.deepEqual(partRotation('wing', motion({ airborne: false, time: 0.3 })), NO_ROTATION);
  const flying = partRotation('wing', motion({ airborne: true, time: 0.3 }));
  assert.notEqual(flying.z, 0);
});

// ---------------------------------------------------------------------------
// The tracker.

test('the tracker measures speed and accumulates distance', () => {
  const t = new MotionTracker();
  let at = 0;
  for (let i = 0; i < 30; i++) {
    t.update([i * 0.2, 64, 0], at);
    at += 50; // 0.2 blocks per 50 ms = 4 blocks/s
  }
  const s = t.state(0, 0, 0);
  assert.ok(Math.abs(s.speed - 4) < 0.6, `measured ${s.speed}, expected about 4`);
  assert.ok(s.distance > 5, `distance did not accumulate: ${s.distance}`);
});

test('a standing entity measures zero speed and does not accumulate distance', () => {
  const t = new MotionTracker();
  for (let i = 0; i < 20; i++) t.update([10, 64, 10], i * 50);
  const s = t.state(0, 0, 0);
  assert.ok(s.speed < 0.01, `a still entity measured ${s.speed}`);
  assert.equal(s.distance, 0);
});

test('a teleport does not spin the legs', () => {
  // A resync or a dimension change moves an entity hundreds of blocks between samples.
  // Counting that as locomotion makes the mob cycle its legs wildly for one frame.
  const t = new MotionTracker();
  t.update([0, 64, 0], 0);
  t.update([500, 64, 500], 50);
  const s = t.state(0, 0, 0);
  assert.equal(s.distance, 0, 'a teleport was counted as walking');
  assert.equal(s.speed, 0);
});

test('a long gap between samples is not treated as a stride', () => {
  const t = new MotionTracker();
  t.update([0, 64, 0], 0);
  t.update([1, 64, 0], 5000); // the flush path can be seconds apart
  assert.equal(t.state(0, 0, 0).distance, 0);
});
