/**
 * WHICH WAY IS RIGHT.
 *
 * `axes` turns held keys into a horizontal direction, and its forward vector is shared with the
 * raycast on purpose — "walk forward" and "mine what the crosshair is on" disagreeing about which
 * way is forward is a bug this project has already paid for. The STRAFE vector is not shared with
 * anything, so nothing was checking it, and it was the negative of what it should be: A walked
 * right and D walked left ("a and d is swapped for movement in 1p", the user, 2026-09-11).
 *
 * Pinned with concrete compass directions rather than a formula, because a formula is what was
 * wrong: the comment asserted `right = (-cos, +sin)` and the code implemented the comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axes } from './predict.js';

const NONE = {
  forward: false, back: false, left: false, right: false,
  jump: false, sneak: false, sprint: false,
} as const;

const near = (got: [number, number], want: [number, number], msg: string) => {
  assert.ok(
    Math.abs(got[0] - want[0]) < 1e-9 && Math.abs(got[1] - want[1]) < 1e-9,
    `${msg}: wanted (${want}), got (${got.map((n) => n.toFixed(3))})`,
  );
};

test('FACING NORTH, forward is north and RIGHT IS EAST', () => {
  // yaw 0 looks down -Z, which is north. A player facing north has east on their right.
  near(axes({ ...NONE, forward: true }, 0), [0, -1], 'W goes north');
  near(axes({ ...NONE, back: true }, 0), [0, 1], 'S goes south');
  near(axes({ ...NONE, right: true }, 0), [1, 0], 'D goes EAST, not west');
  near(axes({ ...NONE, left: true }, 0), [-1, 0], 'A goes WEST, not east');
});

test('FACING WEST, right is north — the check that catches a sign flip on one axis only', () => {
  // yaw +pi/2 looks down -X, which is west. Facing west, north is on your right.
  const yaw = Math.PI / 2;
  near(axes({ ...NONE, forward: true }, yaw), [-1, 0], 'W goes west');
  near(axes({ ...NONE, right: true }, yaw), [0, -1], 'D goes NORTH');
  near(axes({ ...NONE, left: true }, yaw), [0, 1], 'A goes SOUTH');
});

test('strafe is perpendicular to forward, and to the correct side', () => {
  for (const yaw of [0, 0.3, 1, 2.5, -1.2, Math.PI]) {
    const f = axes({ ...NONE, forward: true }, yaw);
    const r = axes({ ...NONE, right: true }, yaw);
    assert.ok(Math.abs(f[0] * r[0] + f[1] * r[1]) < 1e-9, `perpendicular at yaw ${yaw}`);
    // The 2D cross product f x r is positive exactly when r is 90 degrees CLOCKWISE of f in the
    // XZ plane seen from above with +X east and -Z north — which is what "right" means here.
    assert.ok(f[0] * r[1] - f[1] * r[0] > 0, `r is on the RIGHT of f at yaw ${yaw}`);
  }
});

test('a diagonal is normalised, so W+D is not faster than W', () => {
  const d = axes({ ...NONE, forward: true, right: true }, 0);
  assert.ok(Math.abs(Math.hypot(d[0], d[1]) - 1) < 1e-9, 'diagonal has unit length');
  assert.ok(d[0] > 0 && d[1] < 0, 'and it is the north-east quadrant');
});

test('an analog stick pushed right goes right too, and half way walks at half speed', () => {
  const full = axes({ ...NONE, analog: { x: 1, y: 0 } } as never, 0);
  near(full, [1, 0], 'stick right is east at yaw 0');
  const half = axes({ ...NONE, analog: { x: 0.5, y: 0 } } as never, 0);
  assert.ok(Math.abs(Math.hypot(half[0], half[1]) - 0.5) < 1e-9, 'half deflection, half speed');
});
