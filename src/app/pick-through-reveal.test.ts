/**
 * A CLICK MEANS WHAT IS ON SCREEN.
 *
 * The isometric reveal removes geometry in the fragment shader, which removes it from the PICTURE
 * and not from the world. The picker is a DDA through the voxels, so it happily stopped on the roof
 * the reveal had just taken off: you click into the room you can plainly see, and the pick resolves
 * to the invisible ceiling above it — "the isometric click to move doesnt understand when I'm
 * trying to click through the occlusion window thingy we made" (the user, 2026-09-11).
 *
 * `voxelCast` now takes the same question the shader asks, and these pin that it is asked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voxelCast, type VoxelSource } from './raycast.js';

/** Solid at y=70 (a roof) and y=64 (the floor); air between, which is the room. */
const roofed: VoxelSource = { getState: (_x, y) => (y === 70 || y === 64 ? 1 : 0) };

/** Straight down from above the roof. */
const DOWN: [number, number, number] = [0, -1, 0];
const ABOVE = { x: 0.5, y: 80, z: 0.5 };

test('without the reveal, the pick stops on the roof — the behaviour that was wrong on screen', () => {
  const hit = voxelCast(roofed, ABOVE, DOWN, 40);
  assert.deepEqual(hit?.block, [0, 70, 0], 'the roof is what a plain DDA finds first');
});

test('WITH THE ROOF REVEALED AWAY, the pick falls through to the floor you can see', () => {
  const hidden = (_x: number, y: number) => y === 70;
  const hit = voxelCast(roofed, ABOVE, DOWN, 40, hidden);
  assert.deepEqual(hit?.block, [0, 64, 0], 'the floor of the room is what is actually on screen');
});

test('only the hidden blocks are skipped: the floor still stops the ray', () => {
  // A predicate that hid everything would make every click miss, which is the failure next door.
  const hit = voxelCast(roofed, ABOVE, DOWN, 40, (_x, y) => y === 70);
  assert.ok(hit, 'the ray must still hit something');
  assert.equal(hit!.block[1], 64);
});

test('a reveal that hides nothing leaves the pick exactly as it was', () => {
  const a = voxelCast(roofed, ABOVE, DOWN, 40);
  const b = voxelCast(roofed, ABOVE, DOWN, 40, () => false);
  assert.deepEqual(a?.block, b?.block);
});

test('a thick lid is skipped all the way through, not just its first block', () => {
  // The settlement's roofs are several blocks thick. Skipping one layer and stopping on the next
  // would look identical on screen to not skipping at all.
  const thick: VoxelSource = { getState: (_x, y) => (y >= 68 && y <= 72) || y === 64 ? 1 : 0 };
  const hit = voxelCast(thick, ABOVE, DOWN, 40, (_x, y) => y >= 68 && y <= 72);
  assert.deepEqual(hit?.block, [0, 64, 0]);
});

test('the face is the one of the block actually hit, so a walk target sits on the right surface', () => {
  const hit = voxelCast(roofed, ABOVE, DOWN, 40, (_x, y) => y === 70);
  assert.deepEqual(hit?.face, [0, 1, 0], 'hit the TOP of the floor, coming down');
});
