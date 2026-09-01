/**
 * Regression test for quad winding.
 *
 * Vanilla's corner order is NOT uniform across faces: it comes out
 * counter-clockwise-from-outside for the side faces but clockwise for the horizontal
 * ones. A fixed index order therefore renders the sides correctly and silently
 * back-face-culls every block top under THREE.FrontSide — the world looks solid from a
 * distance and you see sky straight through the ground from above.
 *
 * The failure is invisible in aggregate counts (the geometry is all present, correctly
 * positioned and correctly coloured), which is exactly why it needs a check rather than
 * an eyeball.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { facesInward } from './mesher.js';

/** 4 vertices x xyz, in the order the mesher emits them. */
const quad = (...v: number[]) => new Float32Array(v);

// Stated by cross-product direction rather than by "clockwise", which is ambiguous
// without also fixing which way the viewer is looking — and getting it backwards is how
// this bug survived a review in the first place.
test('a top face whose cross product opposes +Y is detected as inward', () => {
  // (v1-v0) x (v2-v0) = (0,-1,0), pointing away from the face's outward direction.
  const p = quad(
    0, 1, 0,
    1, 1, 0,
    1, 1, 1,
    0, 1, 1,
  );
  assert.equal(facesInward(p, [0, 1, 0]), true);
});

test('a top face whose cross product agrees with +Y is left alone', () => {
  // (v1-v0) x (v2-v0) = (0,1,0).
  const p = quad(
    0, 1, 0,
    0, 1, 1,
    1, 1, 1,
    1, 1, 0,
  );
  assert.equal(facesInward(p, [0, 1, 0]), false);
});

test('a north face wound counter-clockwise from outside is left alone', () => {
  // Outward is -Z, so CCW seen from -Z means the cross product points -Z too.
  const p = quad(
    0, 0, 0,
    0, 1, 0,
    1, 1, 0,
    1, 0, 0,
  );
  assert.equal(facesInward(p, [0, 0, -1]), false);
});

test('reversing a quad flips the verdict', () => {
  const forward = quad(0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1);
  const reversed = quad(0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0);
  assert.notEqual(facesInward(forward, [0, 1, 0]), facesInward(reversed, [0, 1, 0]));
});

test('the same corner order gives opposite verdicts for opposite faces', () => {
  // The invariant that actually matters: one fixed index order cannot be correct for
  // both a top and a bottom face, which is precisely why the winding is derived.
  const p = quad(0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0);
  assert.notEqual(facesInward(p, [0, 1, 0]), facesInward(p, [0, -1, 0]));
});
