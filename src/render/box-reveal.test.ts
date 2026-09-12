/**
 * BOX MODE: an 8x8 box of world around the character, and everything in it goes.
 *
 * Why a box at all, after a depth plane and a flood fill. A PLANE HAS NO FAR SIDE — "nearer to the
 * camera than the character" keeps being true all the way out of the world — so the cutaway could
 * always tunnel past the room and into geometry the mesher never built faces for. The flood fill
 * has the opposite failure: it only reaches open space, so against a thick wall it had almost
 * nothing it was allowed to cut and stopped revealing the character at all.
 *
 * A box has a far side by construction, four blocks away, and no camera term whatsoever. What it
 * exposes is bounded by its own size rather than by how well anything was tuned, and the size is
 * one number ("lets try a new method where essentially we just take an idk 8x8 voxel around the
 * player and render it as the cutout" — the user, 2026-09-11).
 *
 * The shader cannot be run here, so what is pinned is the rule it implements, stated once in
 * `insideRevealBox` and read by both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideRevealBox } from './viewer.js';

/** Feet on the floor at y=64, the box 4 blocks either way and 8 blocks up. */
const FEET: [number, number, number] = [100, 64, 200];
const HALF = 4;
const at = (x: number, y: number, z: number) => insideRevealBox([x, y, z], FEET, HALF);

test('the character is inside its own box, so what is around them comes away', () => {
  assert.equal(at(100, 65, 200), true, 'head height, dead centre');
  assert.equal(at(100, 64, 200), true, 'the feet themselves');
});

test('THE BOX HAS A FAR SIDE — this is the whole reason it exists', () => {
  // The plane's failure, stated as the thing that cannot happen here. Four blocks out is in;
  // anything past that is untouched however squarely it sits between the camera and the character.
  assert.equal(at(104, 65, 200), true, '+4 is the edge, still inside');
  assert.equal(at(104.5, 65, 200), false, 'past the edge and nothing is cut');
  assert.equal(at(140, 65, 200), false, 'and far outside, obviously');
  assert.equal(at(96, 65, 200), true, 'symmetric on -X');
  assert.equal(at(95.5, 65, 200), false);
});

test('it is a BOX, not a sphere: the corners are in', () => {
  // A radius would spare the corners of a square room, which is most rooms.
  assert.equal(at(104, 65, 204), true, 'the far corner of the footprint is inside');
  // A sphere of the same half-extent would have excluded it: 4,4 is 5.66 away.
  assert.ok(Math.hypot(4, 4) > HALF, 'and a radius test would have got this wrong');
});

test('THE FLOOR SURVIVES: the box starts at the feet and goes up, never down', () => {
  // The lesson the depth cut already paid for — "I can see through the floor and under it". The
  // ground the character stands on is never between them and an overhead camera.
  assert.equal(at(100, 63, 200), false, 'the block underfoot stays');
  assert.equal(at(100, 60, 200), false, 'and the cellar below it');
  assert.equal(at(101, 63.9, 201), false, 'anywhere in the footprint');
});

test('it reaches twice its half-extent upward: a storey of headroom, not the sky', () => {
  assert.equal(at(100, 72, 200), true, 'feet + 8 is the top, still inside');
  assert.equal(at(100, 72.5, 200), false, 'above it the roof of the storey above is untouched');
});

test('the box follows the character, because it is anchored on their feet', () => {
  const moved: [number, number, number] = [108, 64, 200];
  assert.equal(insideRevealBox([104, 65, 200], moved, HALF), true, 'now inside the moved box');
  assert.equal(insideRevealBox([99, 65, 200], moved, HALF), false, 'and what they left is put back');
});

test('a bigger box cuts more, which is what the slider is for', () => {
  assert.equal(insideRevealBox([106, 65, 200], FEET, 4), false);
  assert.equal(insideRevealBox([106, 65, 200], FEET, 8), true, 'at half 8 the same point is in');
});
