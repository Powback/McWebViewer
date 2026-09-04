/**
 * Following a player.
 *
 * The interesting assertion is the placement, and it is asserted as a DIRECTION rather than
 * as coordinates on purpose. Two 180-degree yaw errors are already recorded in
 * ARCHITECTURE.md §5b and §7, and both survived review because the numbers looked
 * reasonable and the only thing that was wrong was which way the body faced. A dot product
 * cannot be talked into agreeing with itself the way a pair of coordinates can.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_DIST, followPlacement, nextFollowed } from './follow-camera.js';
import { entityYawDeg } from '../render/entity-geometry.js';

/** Minecraft's own facing for a raw yaw: yaw 0 looks down +Z. */
function mcFacing(mcYaw: number): [number, number] {
  const r = (mcYaw * Math.PI) / 180;
  return [-Math.sin(r), Math.cos(r)];
}

/** Unit vector from the camera to the player, on the horizontal plane. */
function towardPlayer(
  camera: readonly [number, number, number],
  player: readonly [number, number, number],
): [number, number] {
  const dx = player[0] - camera[0];
  const dz = player[2] - camera[2];
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}

const PLAYER: [number, number, number] = [120, 68, -45];

test('the camera goes BEHIND the player, whichever way they face', () => {
  for (const mcYaw of [0, 45, 90, 135, 180, 225, 270, 315, 314.7]) {
    const cam = followPlacement(PLAYER, entityYawDeg(mcYaw));
    const toPlayer = towardPlayer(cam, PLAYER);
    const facing = mcFacing(mcYaw);
    // Looking at the player means looking the way they are looking: the camera is behind
    // them, so the direction from camera to player is their own facing direction. The
    // 180-degree error this guards against would give -1 here, and would look entirely
    // plausible on screen until the player walked away from you rather than toward the
    // horizon you were looking at.
    const dot = toPlayer[0] * facing[0] + toPlayer[1] * facing[1];
    assert.ok(dot > 0.999, `at mc yaw ${mcYaw} the camera to player dot product was ${dot}`);
  }
});

test('the camera is above the player and a fixed distance away', () => {
  const cam = followPlacement(PLAYER, entityYawDeg(90));

  assert.ok(cam[1] > PLAYER[1], 'an overhead follow has to look DOWN at the subject');
  assert.equal(
    Math.round(Math.hypot(cam[0] - PLAYER[0], cam[2] - PLAYER[2])),
    FOLLOW_DIST,
    'and the horizontal framing is the distance asked for',
  );
});

// ---------------------------------------------------------------------------
// Cycling

test('the key that starts following is also the key that stops it', () => {
  const names = ['Ada', 'Bob', 'Cy'];

  assert.equal(nextFollowed(names, null), 'Ada');
  assert.equal(nextFollowed(names, 'Ada'), 'Bob');
  assert.equal(nextFollowed(names, 'Cy'), null, 'off the end is RELEASE, not back to Ada');
  assert.equal(nextFollowed(names, null), 'Ada', 'and pressing it again starts over');
});

test('following somebody who logged out starts again rather than sticking', () => {
  assert.equal(nextFollowed(['Bob'], 'Ada'), 'Bob');
});

test('following nobody on an empty server is not an error, it is nobody', () => {
  assert.equal(nextFollowed([], null), null);
  assert.equal(nextFollowed([], 'Ada'), null);
});
