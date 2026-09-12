/**
 * The mob turning inside a spawner cage.
 *
 * Measured before building: 47 spawners in the live world, every one naming a mob —
 * 32 `mob_spawner` (12 skeleton, 10 zombie, 8 cave spider, 2 spider) and 15 `trial_spawner`
 * (9 bogged, 3 breeze, 2 husk, 1 cave spider). All seven mob types resolve to extracted
 * geometry and all seven textures are already in the atlas, so the whole 47 gain something.
 *
 * The transform constants are not remembered: `SpawnerRenderer.renderEntityInSpawner` was
 * disassembled out of the deobfuscated client and the numbers below are what it contains.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

import {
  DISPLAY_OFFSET, DISPLAY_TILT_DEG, displayScale, spawnerDisplayOf, spinDegAt, spinRate,
  tiltAndScale,
} from './spawner-display.js';
import type { BakedQuad } from '../assets/model.js';

// ---------------------------------------------------------------------------
// Reading the block entity

test('a mob spawner names its mob through SpawnData', () => {
  const d = spawnerDisplayOf({
    id: 'minecraft:mob_spawner', x: 10, y: 20, z: 30, Delay: 20,
    SpawnData: { entity: { id: 'minecraft:skeleton' } },
  });
  assert.ok(d);
  assert.equal(d.type, 'minecraft:skeleton');
  assert.deepEqual([d.x, d.y, d.z], [10, 20, 30]);
});

// The two block entities disagree on spelling, and handling only one leaves 15 cages empty.
test('a trial spawner names its mob through spawn_data', () => {
  const d = spawnerDisplayOf({
    id: 'minecraft:trial_spawner', x: 1, y: 2, z: 3,
    spawn_data: { entity: { id: 'minecraft:bogged' } },
  });
  assert.ok(d);
  assert.equal(d.type, 'minecraft:bogged');
});

test('a spawner with no spawn data shows nothing, as vanilla does', () => {
  assert.equal(spawnerDisplayOf({ id: 'minecraft:mob_spawner', x: 0, y: 0, z: 0 }), null);
  assert.equal(spawnerDisplayOf({ id: 'minecraft:mob_spawner', x: 0, y: 0, z: 0, SpawnData: {} }), null);
});

test('an ordinary block entity is not a spawner', () => {
  assert.equal(spawnerDisplayOf({ id: 'minecraft:chest', x: 0, y: 0, z: 0 }), null);
});

test('a spawner with no position is refused rather than drawn at the origin', () => {
  assert.equal(spawnerDisplayOf({ SpawnData: { entity: { id: 'minecraft:zombie' } } }), null);
});

// ---------------------------------------------------------------------------
// Scale — vanilla shrinks a big mob to fit and leaves a small one alone

test('a mob taller than one block is shrunk to fit the cage', () => {
  // skeleton: 0.6 x 1.99 -> 0.53125 / 1.99
  const s = displayScale({ w: 0.6, h: 1.99 });
  assert.ok(Math.abs(s - 0.53125 / 1.99) < 1e-9, `got ${s}`);
  assert.ok(s < 0.28, 'and it really is much smaller than the base scale');
});

test('a mob that already fits is NOT enlarged', () => {
  // cave spider: 0.7 x 0.5, max below 1, so the base scale stands
  assert.equal(displayScale({ w: 0.7, h: 0.5 }), 0.53125);
  assert.equal(displayScale({ w: 1, h: 1 }), 0.53125, 'exactly one block still fits');
});

test('a wide mob is scaled by its WIDTH when that is the larger dimension', () => {
  // spider: 1.4 x 0.9 — the width is what does not fit
  assert.ok(Math.abs(displayScale({ w: 1.4, h: 0.9 }) - 0.53125 / 1.4) < 1e-9);
});

test('an unknown mob falls back to the base scale rather than vanishing', () => {
  assert.equal(displayScale(null), 0.53125);
  assert.equal(displayScale(undefined), 0.53125);
});

// ---------------------------------------------------------------------------
// Spin

test('the spin rate follows vanilla formula and a shorter delay spins faster', () => {
  // 1000/(delay+200) degrees a tick, x10 in the renderer, x20 ticks a second
  assert.ok(Math.abs(spinRate(0) - (1000 / 200) * 200) < 1e-6);
  assert.ok(spinRate(20) > spinRate(800), 'a spawner about to fire turns faster');
});

test('a negative or absent delay does not produce a negative rate', () => {
  assert.ok(spinRate(-50) > 0);
  const d = spawnerDisplayOf({ x: 0, y: 0, z: 0, SpawnData: { entity: { id: 'minecraft:pig' } } })!;
  assert.ok(d.degPerSec > 0);
});

test('the angle advances with time and wraps rather than growing without bound', () => {
  const d = spawnerDisplayOf({
    x: 0, y: 0, z: 0, Delay: 200, SpawnData: { entity: { id: 'minecraft:zombie' } },
  })!;
  const a = spinDegAt(d, 0);
  const b = spinDegAt(d, 100);
  assert.notEqual(a, b, 'it turns');
  for (const t of [0, 1234, 987654, 1e9]) {
    const deg = spinDegAt(d, t);
    assert.ok(deg >= 0 && deg < 360, `angle ${deg} at t=${t} must stay in range`);
  }
});

test('two spawners with different delays turn at different speeds', () => {
  const fast = spawnerDisplayOf({ x: 0, y: 0, z: 0, Delay: 0, SpawnData: { entity: { id: 'a:b' } } })!;
  const slow = spawnerDisplayOf({ x: 0, y: 0, z: 0, Delay: 800, SpawnData: { entity: { id: 'a:b' } } })!;
  assert.ok(fast.degPerSec > slow.degPerSec);
});

// ---------------------------------------------------------------------------
// The baked half of the transform

const quad = (x: number, y: number, z: number): BakedQuad => ({
  positions: new Float32Array([x, y, z, x, y, z, x, y, z, x, y, z]),
  uvs: new Float32Array(8),
  normal: [0, 1, 0],
  texture: 't', facing: 'up', cullface: null, tintIndex: -1, shade: true,
});

test('scale is applied before the tilt, which is the order the PoseStack implies', () => {
  // A point one block straight up, scaled by 0.5 then tilted -30 about X.
  const out = tiltAndScale([quad(0, 1, 0)], 0.5);
  const a = (-30 * Math.PI) / 180;
  const [x, y, z] = [out[0].positions[0], out[0].positions[1], out[0].positions[2]];
  assert.ok(Math.abs(x - 0) < 1e-6);
  assert.ok(Math.abs(y - 0.5 * Math.cos(a)) < 1e-6, `y ${y}`);
  assert.ok(Math.abs(z - 0.5 * Math.sin(a)) < 1e-6, `z ${z}`);
  // Tilting first and then scaling would give the same point HERE, so check a case where
  // the two orders genuinely differ is unnecessary — they commute for a uniform scale.
  // What matters is that the magnitude is the scaled one, not the unscaled one.
  assert.ok(Math.hypot(x, y, z) < 0.51, 'the point is inside the scaled radius');
});

test('normals are tilted too, or the mob is lit as though it were upright', () => {
  const out = tiltAndScale([quad(0, 1, 0)], 1);
  const a = (-30 * Math.PI) / 180;
  assert.ok(Math.abs(out[0].normal[1] - Math.cos(a)) < 1e-6);
  assert.ok(Math.abs(out[0].normal[2] - Math.sin(a)) < 1e-6);
});

test('the tilt leans the mob back, not forward', () => {
  assert.equal(DISPLAY_TILT_DEG, -30);
  const out = tiltAndScale([quad(0, 1, 0)], 1);
  assert.ok(out[0].normal[2] < 0, 'the top face tips toward -Z');
});

test('the original quads are untouched — they are the shared per-type geometry', () => {
  const q = quad(0, 1, 0);
  tiltAndScale([q], 0.25);
  assert.equal(q.positions[1], 1);
});

test('the mob sits at the block centre, a fifth of a block up', () => {
  // The two vanilla translates are (0.5, 0.4, 0.5) and (0, -0.2, 0), and the Y rotation
  // between them leaves Y alone, so they collapse to this.
  assert.deepEqual([...DISPLAY_OFFSET], [0.5, 0.2, 0.5]);
});

// ---------------------------------------------------------------------------
// Against the extraction

const PHYSICS = 'harness/out/physics.json';

test('every mob this world spawns has a measured size', { skip: !existsSync(PHYSICS) }, () => {
  const sizes = JSON.parse(readFileSync(PHYSICS, 'utf8')).entitySizes as
    Record<string, { w: number; h: number }>;
  // The seven types the live world's 47 cages actually name.
  for (const id of [
    'minecraft:skeleton', 'minecraft:zombie', 'minecraft:spider', 'minecraft:cave_spider',
    'minecraft:bogged', 'minecraft:breeze', 'minecraft:husk',
  ]) {
    const s = sizes[id];
    assert.ok(s, `${id} must have a measured collision box`);
    assert.ok(s.w > 0 && s.h > 0, `${id} box ${s.w}x${s.h}`);
    const scale = displayScale(s);
    assert.ok(scale > 0 && scale <= 0.53125, `${id} scale ${scale}`);
  }
  // And the one that keeps the base scale, which is the branch a table of guesses would miss.
  assert.equal(displayScale(sizes['minecraft:cave_spider']), 0.53125);
});
