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

// ---------------------------------------------------------------------------
// The outward direction itself. A slab's top passes through the block centre and a
// stair's riser sits straight above it, so "quad centre minus block centre" says nothing
// useful about either — and left to the fixed corner order, every slab top and stair step
// was back-face culled (reported on the reference world). These bake real slab and stair
// elements and check the direction the mesher compares against agrees with the face.

import { bakeModel, DIR_VEC, type RawModel } from '../assets/model.js';
import { quadOutward } from './mesher.js';

const SLAB_BOTTOM: RawModel = {
  textures: { side: 'test:block/side', top: 'test:block/top' },
  elements: [{
    from: [0, 0, 0], to: [16, 8, 16],
    faces: {
      down: { texture: '#top', cullface: 'down' }, up: { texture: '#top' },
      north: { texture: '#side', cullface: 'north' }, south: { texture: '#side', cullface: 'south' },
      west: { texture: '#side', cullface: 'west' }, east: { texture: '#side', cullface: 'east' },
    },
  }],
};

const STAIRS: RawModel = {
  textures: { all: 'test:block/all' },
  elements: [
    { from: [0, 0, 0], to: [16, 8, 16], faces: {
      down: { texture: '#all', cullface: 'down' }, up: { texture: '#all' },
      north: { texture: '#all', cullface: 'north' }, south: { texture: '#all', cullface: 'south' },
      west: { texture: '#all', cullface: 'west' }, east: { texture: '#all', cullface: 'east' },
    } },
    // the step: its north riser is the face at z=8, centred straight above the block centre
    { from: [0, 8, 8], to: [16, 16, 16], faces: {
      up: { texture: '#all', cullface: 'up' }, north: { texture: '#all' },
      south: { texture: '#all', cullface: 'south' },
      west: { texture: '#all', cullface: 'west' }, east: { texture: '#all', cullface: 'east' },
    } },
  ],
};

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

for (const y of [0, 90, 180, 270]) {
  test(`a bottom slab's outward directions agree with each face (variant y=${y})`, () => {
    const quads = bakeModel(SLAB_BOTTOM, { model: 'test:slab', y }).quads;
    assert.equal(quads.length, 6);
    for (const q of quads) {
      const o = quadOutward(q);
      assert.ok(dot(o, DIR_VEC[q.facing]) > 0, `${q.facing} face: outward ${o} disagrees`);
    }
  });

  test(`a stair's outward directions agree with each face, riser included (variant y=${y})`, () => {
    const quads = bakeModel(STAIRS, { model: 'test:stairs', y }).quads;
    assert.equal(quads.length, 11);
    for (const q of quads) {
      const o = quadOutward(q);
      assert.ok(dot(o, DIR_VEC[q.facing]) > 0, `${q.facing} face: outward ${o} disagrees`);
    }
  });
}

test('an off-centre face still takes its direction from the geometry, not the label', () => {
  // A quad whose declared facing is deliberately wrong (as a chest's element-rotated yaw
  // leaves it): the geometry, at x=1, says east.
  const q = bakeModel(SLAB_BOTTOM, { model: 'test:slab' }).quads.find((k) => k.facing === 'east')!;
  const mislabelled = { ...q, facing: 'north' as const };
  assert.ok(dot(quadOutward(mislabelled), [1, 0, 0]) > 0);
});

// A cross model (grass tufts, flowers): two planes through the block centre, rotated 45
// degrees, each with a front and a back face. Their centres miss the block centre by float
// noise only, and treating that noise as a direction flipped faces at random — tufts went
// invisible from one side and z-fought themselves from the other. Both faces of a plane
// must end up wound opposite ways, each facing out along its own declared direction.
const CROSS: RawModel = {
  textures: { cross: 'test:block/short_grass' },
  elements: [
    { from: [0.8, 0, 8], to: [15.2, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true },
      shade: false, faces: { north: { texture: '#cross' }, south: { texture: '#cross' } } },
    { from: [8, 0, 0.8], to: [8, 16, 15.2], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true },
      shade: false, faces: { west: { texture: '#cross' }, east: { texture: '#cross' } } },
  ],
};

test('both faces of a cross plane face out along their own direction after the winding rule', () => {
  const quads = bakeModel(CROSS, { model: 'test:cross' }).quads;
  assert.equal(quads.length, 4);
  for (const q of quads) {
    const p = q.positions;
    // the triangle the mesher would emit after applying its rule
    const o = quadOutward(q);
    const flip = facesInward(p, o) ? -1 : 1;
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
    const n = [flip * (ay * bz - az * by), flip * (az * bx - ax * bz), flip * (ax * by - ay * bx)];
    assert.ok(dot(n, DIR_VEC[q.facing]) > 0, `${q.facing} face ends up facing the wrong way`);
    assert.ok(dot(o, DIR_VEC[q.facing]) > 0.5, `${q.facing} face: outward ${o} came from noise, not the label`);
  }
});
