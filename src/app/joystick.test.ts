/**
 * The joystick's geometry and how it maps to movement.
 *
 * The parts that make a stick feel right or wrong are all here and none of them is
 * checkable by eye: the deadzone, the clamp, whether a half push walks at half speed, and
 * whether letting go actually stops you.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { vectorFrom, knobOffset, CENTRED } from './joystick.js';
import { dominantDirections } from './live-controls.js';
import { axes, NO_INTENT, type PredictIntent } from './predict.js';

test('a centred stick is exactly zero, so a resting thumb does not walk', () => {
  assert.deepEqual(vectorFrom(0, 0), CENTRED);
  assert.deepEqual(vectorFrom(3, 2), CENTRED, 'inside the deadzone must read as centred');
});

test('a full push is magnitude 1 and no more, however far the drag goes', () => {
  const edge = vectorFrom(46, 0);
  const miles = vectorFrom(4600, 0);
  assert.ok(Math.abs(edge.magnitude - 1) < 1e-6);
  assert.ok(Math.abs(miles.magnitude - 1) < 1e-6, 'magnitude must clamp, not keep growing');
  assert.ok(Math.abs(miles.x - 1) < 1e-6);
});

test('a half push is about half magnitude — the whole point of an analog stick', () => {
  const half = vectorFrom(0, -28);
  assert.ok(half.magnitude > 0.3 && half.magnitude < 0.7, `half push read ${half.magnitude}`);
});

test('magnitude rises from zero AT the deadzone edge, with no jump', () => {
  // Rescaling across the live travel is what stops the stick snapping to a speed the moment
  // it leaves the deadzone.
  const justOut = vectorFrom(0, -(46 * 0.19));
  assert.ok(justOut.magnitude < 0.05, `magnitude jumped to ${justOut.magnitude} at the edge`);
});

test('the knob stays inside its circle', () => {
  const k = knobOffset(500, 500);
  assert.ok(Math.hypot(k.x, k.y) <= 46 + 1e-6, 'the knob escaped the base');
  const inside = knobOffset(10, 5);
  assert.deepEqual(inside, { x: 10, y: 5 }, 'inside the circle the knob follows exactly');
});

// ---------------------------------------------------------------------------
// Direction.

test('screen-up walks FORWARD, not backward', () => {
  // The DOM's y grows downward; movement's grows forward. Getting this wrong inverts the
  // control for the stick while leaving the keyboard correct, which is a maddening bug.
  const up = vectorFrom(0, -46);
  const intent: PredictIntent = { ...NO_INTENT, analog: { x: up.x, y: -up.y } };
  const [, z] = axes(intent, 0);
  assert.ok(z < 0, 'pushing the stick up must walk towards -Z at yaw 0, as W does');
});

test('the analog vector beats the booleans when both are set', () => {
  const intent: PredictIntent = { ...NO_INTENT, forward: true, analog: { x: 1, y: 0 } };
  const [x, z] = axes(intent, 0);
  assert.ok(Math.abs(x) > 0.9 && Math.abs(z) < 0.1, 'the stick should win over a held key');
});

test('a half-pushed stick moves at half speed', () => {
  const full = axes({ ...NO_INTENT, analog: { x: 0, y: 1 } }, 0);
  const half = axes({ ...NO_INTENT, analog: { x: 0, y: 0.5 } }, 0);
  const mag = (v: [number, number]) => Math.hypot(v[0], v[1]);
  assert.ok(Math.abs(mag(full) - 1) < 1e-6);
  assert.ok(Math.abs(mag(half) - 0.5) < 1e-6, `half push gave ${mag(half)}`);
});

test('a centred stick with no keys is no movement', () => {
  assert.deepEqual(axes({ ...NO_INTENT, analog: null }, 1.2), [0, 0]);
  assert.deepEqual(axes({ ...NO_INTENT, analog: { x: 0, y: 0 } }, 1.2), [0, 0]);
});

// ---------------------------------------------------------------------------
// The server's discrete copy.

test('the server command takes the dominant axis', () => {
  assert.deepEqual(dominantDirections({ x: 0, y: 1 }), ['forward']);
  assert.deepEqual(dominantDirections({ x: -1, y: 0 }), ['left']);
  assert.deepEqual(dominantDirections(null), []);
});

test('a diagonal reports BOTH axes, so north-east is not sent as north', () => {
  const d = dominantDirections({ x: 0.7, y: 0.7 });
  assert.deepEqual(new Set(d), new Set(['forward', 'right']));
});

test('a mostly-forward push does not also send a sideways command', () => {
  const d = dominantDirections({ x: 0.05, y: 1 });
  assert.deepEqual(d, ['forward'], 'a small sideways component must not steer the server copy');
});
