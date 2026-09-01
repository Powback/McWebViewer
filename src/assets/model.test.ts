/**
 * Pins variant rotation.
 *
 * The failure this guards against is nasty because it is invisible on terrain: if the
 * geometry rotates one way and the face directions rotate the other, symmetric blocks
 * (stone, dirt) look perfect while every asymmetric block with a variant `y` — furnaces,
 * ladders, stairs, chests — is mirrored, and its cullfaces point at the wrong neighbour
 * so culling silently misbehaves too.
 *
 * Vanilla's BlockModelRotation is
 *   new Quaternionf().rotationXYZ(0, -y*DEG, 0).mul(rotationXYZ(-x*DEG, 0, 0))
 * i.e. a rotation of MINUS y degrees about +Y. For y=90 that carries +Z to -X.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeModel, rotateDirection, DIRECTIONS, DIR_VEC, type RawModel } from './model.js';

/** A model with a single small cube pushed hard toward one face, so its centroid marks it. */
function markerModel(dir: (typeof DIRECTIONS)[number]): RawModel {
  const v = DIR_VEC[dir];
  const c = (n: number) => 8 + n * 6; // centre 8, offset 6 toward the face
  return {
    textures: { t: 'minecraft:block/stone' },
    elements: [
      {
        from: [c(v[0]) - 2, c(v[1]) - 2, c(v[2]) - 2],
        to: [c(v[0]) + 2, c(v[1]) + 2, c(v[2]) + 2],
        faces: Object.fromEntries(DIRECTIONS.map((d) => [d, { texture: '#t' }])),
      },
    ],
  };
}

function centroid(quads: { positions: Float32Array }[]): [number, number, number] {
  let x = 0, y = 0, z = 0, n = 0;
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      x += q.positions[i * 3];
      y += q.positions[i * 3 + 1];
      z += q.positions[i * 3 + 2];
      n++;
    }
  }
  return [x / n, y / n, z / n];
}

/** Which axis direction a centroid (in 0..1 block space) is displaced toward. */
function dominantDirection(c: [number, number, number]): (typeof DIRECTIONS)[number] {
  const d: [number, number, number] = [c[0] - 0.5, c[1] - 0.5, c[2] - 0.5];
  let best: (typeof DIRECTIONS)[number] = DIRECTIONS[0];
  let bestDot = -Infinity;
  for (const dir of DIRECTIONS) {
    const v = DIR_VEC[dir];
    const dot = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = dir;
    }
  }
  return best;
}

test('variant y rotation moves geometry the same way it moves face directions', () => {
  for (const dir of DIRECTIONS) {
    for (const y of [0, 90, 180, 270]) {
      const baked = bakeModel(markerModel(dir), { model: '', y });
      const geometric = dominantDirection(centroid(baked.quads));
      const expected = rotateDirection(dir, 'y', y);
      assert.equal(geometric, expected, `dir=${dir} y=${y}`);
    }
  }
});

test('variant x rotation moves geometry the same way it moves face directions', () => {
  for (const dir of DIRECTIONS) {
    for (const x of [0, 90, 180, 270]) {
      const baked = bakeModel(markerModel(dir), { model: '', x });
      const geometric = dominantDirection(centroid(baked.quads));
      const expected = rotateDirection(dir, 'x', x);
      assert.equal(geometric, expected, `dir=${dir} x=${x}`);
    }
  }
});

test('vanilla reference: y=90 carries +Z to -X', () => {
  const baked = bakeModel(markerModel('south'), { model: '', y: 90 });
  const c = centroid(baked.quads);
  assert.ok(c[0] < 0.5, `expected -X, centroid x=${c[0]}`);
  assert.equal(rotateDirection('south', 'y', 90), 'west');
});

test('a full cube stays a full cube under every rotation', () => {
  const cube: RawModel = {
    textures: { t: 'minecraft:block/stone' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(DIRECTIONS.map((d) => [d, { texture: '#t' }])),
      },
    ],
  };
  for (const x of [0, 90, 180, 270]) {
    for (const y of [0, 90, 180, 270]) {
      const baked = bakeModel(cube, { model: '', x, y });
      assert.equal(baked.quads.length, 6, `x=${x} y=${y}`);
      for (const q of baked.quads) {
        for (const p of q.positions) assert.ok(p >= -1e-6 && p <= 1 + 1e-6, `pos ${p}`);
      }
    }
  }
});
