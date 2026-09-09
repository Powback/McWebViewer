/**
 * Every face of an entity cube must wind outward: the entity mesh builder uses a fixed
 * index order, and vanilla's corner order is not uniform across faces, so without
 * `orientOutward` some faces of every mob were back-face culled — the wolf had no back, the
 * cow's head no top. Bakes a real cube through the real box() + bakeModel path and checks.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bakeModel } from '../assets/model.js';
import { box } from './ber-models.js';
import { orientOutward } from './entity-geometry.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

test('all six faces of a model cube wind outward after orientOutward, normals agreeing', () => {
  // a cow-head-like box: texOffs (0,0), from (-4,-8,-6), size 8x8x6 on a 64x32 sheet
  const el = box(IDENTITY, { texOffs: [0, 0], from: [-4, -8, -6], size: [8, 8, 6], texture: 't:cow', texSize: [64, 32] });
  const centre: [number, number, number] = [
    (el.from[0] + el.to[0]) / 32, (el.from[1] + el.to[1]) / 32, (el.from[2] + el.to[2]) / 32,
  ];
  const quads = bakeModel({ elements: [el] }, { model: '' }).quads;
  assert.equal(quads.length, 6);
  let reversed = 0;
  for (const raw of quads) {
    const q = orientOutward(raw, centre);
    if (q.positions !== raw.positions) reversed++;
    const p = q.positions;
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
    const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const fc = [(p[0] + p[3] + p[6] + p[9]) / 4 - centre[0], (p[1] + p[4] + p[7] + p[10]) / 4 - centre[1], (p[2] + p[5] + p[8] + p[11]) / 4 - centre[2]];
    assert.ok(n[0] * fc[0] + n[1] * fc[1] + n[2] * fc[2] > 0, `${raw.facing} face winds inward`);
    assert.ok(q.normal[0] * fc[0] + q.normal[1] * fc[1] + q.normal[2] * fc[2] > 0, `${raw.facing} normal points inward`);
    // the uv corners travel with their vertices: the set of (position, uv) pairs is unchanged
    const pairs = (qq: typeof q) => [0, 1, 2, 3].map((i) => `${qq.positions[i * 3]},${qq.positions[i * 3 + 1]},${qq.positions[i * 3 + 2]}:${qq.uvs[i * 2]},${qq.uvs[i * 2 + 1]}`).sort();
    assert.deepEqual(pairs(q), pairs(raw));
  }
  assert.ok(reversed > 0, 'vanilla corner order needs at least one face turned, or this test proves nothing');
});
