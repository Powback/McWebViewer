/**
 * The crack overlay's sprite selection and the ten stages.
 *
 * The geometry is checked against the REAL baked atlas: the ten `destroy_stage` textures are
 * the one set nothing in the world references, so they are only in the atlas because the
 * bake was told to include them — and if that regresses the overlay silently draws nothing.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'fflate';
import { destroyStageSprite } from './break-overlay.js';
import { breakStage } from '../app/break-progress.js';

const BAKE = '.cache/baked/assets.json.gz';
const have = existsSync(BAKE);
const bundle = have
  ? JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(readFileSync(BAKE)))))
  : null;
const need = { skip: have ? false : 'run npm run bake-assets' };

test('a stage maps to its sprite id', () => {
  assert.equal(destroyStageSprite(0), 'minecraft:block/destroy_stage_0');
  assert.equal(destroyStageSprite(9), 'minecraft:block/destroy_stage_9');
});

test('a stage outside 0..9 is clamped, never asking for a sprite that does not exist', () => {
  assert.equal(destroyStageSprite(-3), 'minecraft:block/destroy_stage_0');
  assert.equal(destroyStageSprite(42), 'minecraft:block/destroy_stage_9');
});

test('ALL TEN stages are in the baked atlas', need, () => {
  // Nothing in the world references these, so they are in the atlas only because the bake
  // asks for them explicitly. Losing that is invisible until someone mines a block.
  const sprites = bundle.atlas.sprites as Record<string, unknown>;
  for (let i = 0; i < 10; i++) {
    const id = destroyStageSprite(i);
    assert.ok(sprites[id], `${id} is missing from the atlas — the overlay would draw nothing`);
  }
});

test('each stage is a real 16x16 rect with a non-empty uv range', need, () => {
  const sprites = bundle.atlas.sprites as Record<string, { w: number; h: number; u0: number; u1: number; v0: number; v1: number }>;
  for (let i = 0; i < 10; i++) {
    const r = sprites[destroyStageSprite(i)];
    assert.equal(r.w, 16);
    assert.equal(r.h, 16);
    assert.ok(r.u1 > r.u0 && r.v1 > r.v0, `stage ${i} has a degenerate uv rect`);
  }
});

test('the ten stages occupy ten DIFFERENT places in the atlas', need, () => {
  // One wrong id in the bake list would silently point several stages at one texture, and
  // the crack would appear to stop growing part-way through.
  const sprites = bundle.atlas.sprites as Record<string, { x: number; y: number }>;
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const r = sprites[destroyStageSprite(i)];
    seen.add(`${r.x},${r.y}`);
  }
  assert.equal(seen.size, 10, 'two stages share an atlas position');
});

test('progress walks every stage exactly once, 0 through 9', () => {
  const seen: number[] = [];
  for (let p = 0.001; p <= 1; p += 0.001) {
    const s = breakStage(p);
    if (s !== seen[seen.length - 1]) seen.push(s);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
