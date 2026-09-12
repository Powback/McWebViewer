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

// ---------------------------------------------------------------------------
// Posing

/**
 * THE INVARIANT THAT MATTERS MOST for animation: posing with no rotation must reproduce the
 * rest pose the viewer has always drawn, quad for quad and vertex for vertex.
 *
 * If it does not, every mob shifts the moment animation is switched on and the bug looks
 * like "the animation is wrong" when it is actually the transform chain being rebuilt
 * differently. Run against the REAL extracted models, not a fixture, because the part trees
 * that matter are the ones with nested children (a cow's head under its body).
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  buildEntityQuads, buildPosedParts, poseQuads, makeEntityModelSet,
} from './entity-geometry.js';

const MODELS = 'public/entity-models.json';
const INDEX = 'public/entity-index.json';
const haveModels = existsSync(MODELS) && existsSync(INDEX);

/** Just enough atlas for the geometry path: it only asks whether the sprite exists. */
const stubAtlas = { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1 }) };

test('posing with zero rotation reproduces the rest pose exactly', { skip: !haveModels }, () => {
  const set = makeEntityModelSet(
    JSON.parse(readFileSync(MODELS, 'utf8')),
    JSON.parse(readFileSync(INDEX, 'utf8')),
  );
  // A handful with genuinely nested parts, so the parent-chain maths is exercised.
  const types = ['minecraft:cow', 'minecraft:chicken', 'minecraft:spider', 'minecraft:creeper'];
  let checked = 0;
  for (const type of types) {
    const flat = buildEntityQuads(set, type, stubAtlas as never);
    const parts = buildPosedParts(set, type, stubAtlas as never);
    if (!flat || !parts) continue;
    const posed = poseQuads(parts, () => ({ x: 0, y: 0, z: 0 }));
    assert.equal(posed.length, flat.length, `${type}: quad count changed`);
    for (let i = 0; i < flat.length; i++) {
      for (let v = 0; v < 12; v++) {
        assert.ok(Math.abs(posed[i].positions[v] - flat[i].positions[v]) < 1e-6,
          `${type}: quad ${i} vertex float ${v} moved (${posed[i].positions[v]} vs ${flat[i].positions[v]})`);
      }
    }
    checked++;
  }
  assert.ok(checked > 0, 'no models were checked — are the extracted models present?');
});

test('a non-zero rotation actually moves the part it names, and only that part', { skip: !haveModels }, () => {
  const set = makeEntityModelSet(
    JSON.parse(readFileSync(MODELS, 'utf8')),
    JSON.parse(readFileSync(INDEX, 'utf8')),
  );
  const parts = buildPosedParts(set, 'minecraft:cow', stubAtlas as never);
  assert.ok(parts, 'no cow model');
  const rest = poseQuads(parts, () => ({ x: 0, y: 0, z: 0 }));
  const swung = poseQuads(parts, (p) => (p.role === 'limb' ? { x: 0.8, y: 0, z: 0 } : { x: 0, y: 0, z: 0 }));
  assert.equal(rest.length, swung.length);
  let moved = 0;
  for (let i = 0; i < rest.length; i++) {
    for (let v = 0; v < 12; v++) {
      if (Math.abs(rest[i].positions[v] - swung[i].positions[v]) > 1e-6) { moved++; break; }
    }
  }
  assert.ok(moved > 0, 'rotating the limbs moved nothing at all');
  assert.ok(moved < rest.length, 'rotating the limbs moved EVERY quad — the body moved too');
});
