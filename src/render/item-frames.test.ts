/**
 * Item frames.
 *
 * This one was mis-filed on a sentence that sounded authoritative — "no entity model by
 * design" — which is true and does not imply what it was used to imply. An item frame has no
 * `EntityModel` and a perfectly ordinary BLOCK model, which vanilla draws with
 * `renderSingleBlock`. Every piece was already here; only the wiring was missing.
 *
 * Measured in this world before building: 3 `minecraft:item_frame`, all facing south, all
 * `ItemRotation` 0, all holding a modded item. 0 glow frames and 0 framed maps — both are
 * handled below but neither is verifiable here, and they stay category 2 until a world has
 * one.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ENTITY_BLOCK_STATES, frameAppearance, isFramedMap, itemRotationDeg, pitchMesh,
} from './item-frames.js';

// ---------------------------------------------------------------------------
// Which model

test('the frame resolves to the block state vanilla uses', () => {
  assert.equal(frameAppearance(3, false, false).stateKey, 'minecraft:item_frame[map=false]');
});

test('a framed map is a different model, and a glow frame a different block', () => {
  assert.equal(frameAppearance(3, true, false).stateKey, 'minecraft:item_frame[map=true]');
  assert.equal(frameAppearance(3, false, true).stateKey, 'minecraft:glow_item_frame[map=false]');
  assert.equal(frameAppearance(3, true, true).stateKey, 'minecraft:glow_item_frame[map=true]');
});

test('only a filled map takes the map model', () => {
  assert.equal(isFramedMap('minecraft:filled_map'), true);
  assert.equal(isFramedMap('minecraft:map'), false, 'an empty map is an ordinary item');
  assert.equal(isFramedMap('runes:fire_stone'), false);
  assert.equal(isFramedMap(null), false);
});

// Every state here is one nothing in the world ever places, so nothing else would bake them.
test('all four frame states are offered to the bake', () => {
  for (const glow of [false, true]) {
    for (const map of [false, true]) {
      assert.ok(ENTITY_BLOCK_STATES.includes(frameAppearance(3, map, glow).stateKey),
        `glow=${glow} map=${map} must be baked`);
    }
  }
});

// ---------------------------------------------------------------------------
// Orientation

// The model faces north as authored, and mob models do too — so the frame reuses the entity
// path's `180 - yRot` convention rather than inventing a second one.
test('a south-facing frame is turned to face south', () => {
  assert.equal(frameAppearance(3, false, false).yawDeg, 180);
});

test('the four wall facings are distinct and a quarter turn apart', () => {
  const yaws = [2, 3, 4, 5].map((f) => frameAppearance(f, false, false).yawDeg);
  assert.deepEqual(yaws, [0, 180, 90, -90], 'north, south, west, east');
  assert.equal(new Set(yaws).size, 4);
});

test('a wall frame has no pitch; a floor or ceiling frame does', () => {
  for (const f of [2, 3, 4, 5]) assert.equal(frameAppearance(f, false, false).pitchDeg, 0);
  assert.equal(frameAppearance(0, false, false).pitchDeg, 90, 'on the ceiling, looking down');
  assert.equal(frameAppearance(1, false, false).pitchDeg, -90, 'on the floor, looking up');
});

// ---------------------------------------------------------------------------
// The contained item's own rotation

test('ItemRotation turns the item in 45-degree steps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(itemRotationDeg),
    [0, 45, 90, 135, 180, 225, 270, 315]);
});

test('an out-of-range or absent rotation is wrapped rather than trusted', () => {
  assert.equal(itemRotationDeg(8), 0);
  assert.equal(itemRotationDeg(9), 45);
  assert.equal(itemRotationDeg(-1), 315);
  assert.equal(itemRotationDeg(null), 0);
  assert.equal(itemRotationDeg(undefined), 0);
});

// ---------------------------------------------------------------------------
// Baking the pitch into the geometry

function meshOf(positions: number[], normals: number[]) {
  return { layers: { solid: {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
  } } };
}

test('zero pitch leaves the geometry untouched, which is every frame in this world', () => {
  const m = meshOf([0, 1, 0], [0, 1, 0]);
  const before = [...m.layers.solid.positions];
  pitchMesh(m, 0);
  assert.deepEqual([...m.layers.solid.positions], before);
});

test('a ceiling frame turns its geometry a quarter turn about X', () => {
  const m = meshOf([0, 1, 0], [0, 1, 0]);
  pitchMesh(m, 90);
  const [x, y, z] = m.layers.solid.positions;
  assert.ok(Math.abs(x) < 1e-5);
  assert.ok(Math.abs(y) < 1e-5, `y ${y}`);
  assert.ok(Math.abs(z - 1) < 1e-5, `z ${z}`);
});

// Leaving the normals behind would light a floor frame as though it were still on a wall.
test('normals turn with the positions', () => {
  const m = meshOf([0, 0, 0], [0, 1, 0]);
  pitchMesh(m, -90);
  const [nx, ny, nz] = m.layers.solid.normals;
  assert.ok(Math.abs(nx) < 1e-5);
  assert.ok(Math.abs(ny) < 1e-5, `ny ${ny}`);
  assert.ok(Math.abs(nz + 1) < 1e-5, `nz ${nz}`);
});

test('the rotation preserves length, so a normal stays a unit vector', () => {
  const m = meshOf([0, 0, 0], [0, 0.6, 0.8]);
  pitchMesh(m, 37);
  const [nx, ny, nz] = m.layers.solid.normals;
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5);
});
