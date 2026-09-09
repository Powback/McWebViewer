/**
 * Regression test for the winding of free-standing block meshes.
 *
 * `meshBlockSet` draws Create contraptions and the live turtles. It used a fixed triangle
 * index order, which is right for vanilla's side faces and wrong for its horizontal ones —
 * and wrong again for whatever a variant rotation makes of the corner order. Under
 * THREE.FrontSide that back-face-culls the lid of every live turtle: on screen it was an
 * open box you looked into, its far walls showing from the inside. The terrain mesher had
 * already fixed the same bug by deriving the winding from the geometry; this checks the
 * entity path does too, by running the real baker and the real mesher over a turtle-shaped
 * element and asserting every emitted triangle faces out of its block.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bakeModel, type RawModel } from '../assets/model.js';
import type { TextureAtlas } from './atlas.js';
import type { RenderableState } from './registry.js';
import type { StateSource } from './mesher.js';
import { meshBlockSet } from './entities.js';

/** A turtle-shaped body: an inset box with all six faces, like cc-tweaked's turtle_base. */
const TURTLE_LIKE: RawModel = {
  textures: { all: 'test:block/skin' },
  elements: [
    {
      from: [2, 2, 2],
      to: [14, 14, 13],
      faces: {
        down: { uv: [0, 0, 12, 11], texture: '#all' },
        up: { uv: [0, 0, 12, 11], texture: '#all' },
        north: { uv: [0, 0, 12, 12], texture: '#all' },
        south: { uv: [0, 0, 12, 12], texture: '#all' },
        west: { uv: [0, 0, 11, 12], texture: '#all' },
        east: { uv: [0, 0, 11, 12], texture: '#all' },
      },
    },
  ],
};

function stateFor(key: string, y: number): RenderableState {
  return {
    key,
    name: key,
    props: {},
    quads: bakeModel(TURTLE_LIKE, { model: 'test:block/turtle', y }).quads,
    renderType: 'translucent',
    opaqueFullCube: false,
    ambientOcclusion: true,
    tintSource: -1,
    provenance: 'asset',
    lightEmission: 0,
  };
}

const atlas = {
  get: () => ({ x: 0, y: 0, w: 16, h: 16, frames: 1, frametime: 1, u0: 0, v0: 0, u1: 1, v1: 1 }),
} as unknown as TextureAtlas;

/** Every triangle's cross product, dotted with its own offset from the block centre. */
function outwardness(mesh: ReturnType<typeof meshBlockSet>, centre: [number, number, number]) {
  const out: number[] = [];
  for (const buf of Object.values(mesh.layers)) {
    if (!buf) continue;
    const p = buf.positions;
    const idx = buf.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const ax = p[b] - p[a], ay = p[b + 1] - p[a + 1], az = p[b + 2] - p[a + 2];
      const bx = p[c] - p[a], by = p[c + 1] - p[a + 1], bz = p[c + 2] - p[a + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const cx = (p[a] + p[b] + p[c]) / 3 - centre[0];
      const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - centre[1];
      const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - centre[2];
      out.push(nx * cx + ny * cy + nz * cz);
    }
  }
  return out;
}

for (const y of [0, 90, 180, 270]) {
  test(`every triangle of a turtle-shaped block faces outward (variant y=${y})`, () => {
    const key = `test:turtle[facing=${y}]`;
    const registry: StateSource = {
      resolve: () => stateFor(key, y),
      unresolved: new Set(),
      missing: new Set(),
    } as unknown as StateSource;
    // Placed the way live-entities.ts places a turtle: centred on the entity.
    const mesh = meshBlockSet([{ x: -0.5, y: 0, z: -0.5, stateKey: key }], registry, atlas);
    assert.equal(mesh.quadCount, 6, 'six faces, none culled');
    const dots = outwardness(mesh, [0, 0.5, 0]);
    assert.equal(dots.length, 12, 'two triangles per face');
    const inward = dots.filter((d) => d <= 0).length;
    assert.equal(inward, 0, `${inward} of 12 triangles wind inward (would be back-face culled)`);
  });
}
