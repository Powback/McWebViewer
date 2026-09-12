/**
 * NARROWED VERTEX ATTRIBUTES, and the precision each one actually needs.
 *
 * A vertex cost 60 bytes: position 12, normal 12, uv 8, colour 16, anim 12. The section budget
 * pays for every one of them, so at a fixed byte ceiling THE VERTEX FORMAT IS THE VIEW DISTANCE —
 * and three of those attributes carried far more precision than their contents can use.
 *
 * These pin that the narrowing is exact where exactness matters, because the failure mode is not
 * an exception: it is a normal that is 0.992 instead of 1, or a colour band, seen and not
 * explained.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSnorm8, toUnorm16, toUnorm8 } from './mesher.js';

/** What the GPU does with a normalized integer attribute, per the GL spec. */
const decodeSnorm8 = (v: number) => Math.max(v / 127, -1);
const decodeUnorm8 = (v: number) => v / 255;
const decodeUnorm16 = (v: number) => v / 65535;

test('A BLOCK FACE NORMAL SURVIVES EXACTLY — every one is -1, 0 or +1', () => {
  // The whole reason int8 is safe here. Anything less than exact would tilt every face slightly,
  // and the reveal reads the normal to decide which column owns a face (see ceiling-map.ts).
  const axes = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  const packed = toSnorm8(axes);
  for (let i = 0; i < axes.length; i++) {
    assert.equal(decodeSnorm8(packed[i]!), axes[i], `component ${i} must be exact`);
  }
});

test('normals are 3 bytes a vertex instead of 12', () => {
  assert.equal(toSnorm8([1, 0, 0]).byteLength, 3);
  assert.equal(new Float32Array([1, 0, 0]).byteLength, 12);
});

test('colour keeps the precision the screen has, and both ends exactly', () => {
  // 0 and 1 must round-trip: a face at full brightness must not come back at 0.996, and the
  // 0.05 floor `faceBrightness` produces must not become 0.
  assert.equal(decodeUnorm8(toUnorm8([0])[0]!), 0);
  assert.equal(decodeUnorm8(toUnorm8([1])[0]!), 1);
  for (const v of [0.05, 0.25, 0.5, 0.8]) {
    assert.ok(Math.abs(decodeUnorm8(toUnorm8([v])[0]!) - v) <= 1 / 255, `${v} within one step`);
  }
  assert.equal(toUnorm8([1, 1, 1, 1]).byteLength, 4, '4 bytes instead of 16');
});

test('UV KEEPS SUB-TEXEL ACCURACY across a large atlas', () => {
  // 65536 steps across an atlas a couple of thousand texels wide is ~30 steps per texel, so a
  // sprite edge cannot drift onto its neighbour -- which is what bleeding artifacts are.
  const ATLAS = 2048;
  for (const texel of [0, 1, 17, 1023, 2047]) {
    const u = texel / ATLAS;
    const back = decodeUnorm16(toUnorm16([u])[0]!);
    assert.ok(Math.abs(back - u) * ATLAS < 0.05, `texel ${texel} drifted ${(back - u) * ATLAS}`);
  }
  assert.equal(toUnorm16([0, 0])[0], 0);
  assert.equal(decodeUnorm16(toUnorm16([1])[0]!), 1, 'the far edge of the atlas is exact');
  assert.equal(toUnorm16([0, 0]).byteLength, 4, '4 bytes instead of 8');
});

test('values outside the range are clamped rather than wrapping', () => {
  // A wrap is the nastiest possible failure here: a normal of 1.0001 becoming -1 flips a face.
  assert.equal(decodeSnorm8(toSnorm8([1.5])[0]!), 1);
  assert.equal(decodeSnorm8(toSnorm8([-1.5])[0]!), -1);
  assert.equal(decodeUnorm8(toUnorm8([2])[0]!), 1);
  assert.equal(decodeUnorm8(toUnorm8([-1])[0]!), 0);
  assert.equal(decodeUnorm16(toUnorm16([2])[0]!), 1);
});

test('the saving is what it claims: 60 bytes a vertex becomes 35', () => {
  // position 12 + normal 3 + uv 4 + colour 4 + anim 12. The same ceiling holds ~70% more world.
  const before = 12 + 12 + 8 + 16 + 12;
  const after = 12 + toSnorm8([0, 0, 0]).byteLength + toUnorm16([0, 0]).byteLength
    + toUnorm8([0, 0, 0, 0]).byteLength + 12;
  assert.equal(before, 60);
  assert.equal(after, 35);
  assert.ok(before / after > 1.7, 'at a fixed ceiling this is how much more world fits');
});
