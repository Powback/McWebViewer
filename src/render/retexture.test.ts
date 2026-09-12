/**
 * Blocks whose material lives in their block entity.
 *
 * Measured before building: 28 placed `domum_ornamentum:plain` blocks, every one carrying
 * `{minecraft:block/oak_planks -> minecraft:birch_planks, minecraft:block/dark_oak_planks
 * -> minecraft:birch_planks}`, and every one drawing in oak. At 126 quads each (120 oak,
 * 6 dark oak) that is 3,528 quads of the wrong wood.
 *
 * The mesher tests at the bottom are the ones that would have failed before the fix: the
 * pure functions can be right while the substitution never reaches the geometry.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  materialsIn, normaliseTexId, retextureKey, retextureQuads, textureMapOf,
} from './retexture.js';
import { meshSection, type MeshContext } from './mesher.js';
import type { RenderableState } from './registry.js';
import type { BakedQuad } from '../assets/model.js';

// ---------------------------------------------------------------------------
// Reading the map

test('a block entity with textureData yields a normalised map', () => {
  const map = textureMapOf({
    id: 'domum_ornamentum:materially_retexturable',
    textureData: {
      'minecraft:block/oak_planks': 'minecraft:birch_planks',
      'minecraft:block/dark_oak_planks': 'minecraft:birch_planks',
    },
  });
  assert.ok(map);
  assert.equal(map.size, 2);
  assert.equal(map.get('minecraft:block/oak_planks'), 'minecraft:birch_planks');
});

// The two spellings are the same sprite, and the model and the NBT do not have to agree.
test('an unnamespaced key matches a namespaced one', () => {
  assert.equal(normaliseTexId('block/oak_planks'), 'minecraft:block/oak_planks');
  assert.equal(normaliseTexId('mod:block/x'), 'mod:block/x');
  const map = textureMapOf({ textureData: { 'block/oak_planks': 'minecraft:birch_planks' } })!;
  assert.equal(map.get('minecraft:block/oak_planks'), 'minecraft:birch_planks');
});

test('a block entity with no texture data yields null, not an empty map', () => {
  assert.equal(textureMapOf({ id: 'minecraft:chest' }), null);
  assert.equal(textureMapOf({ textureData: {} }), null);
  assert.equal(textureMapOf({ textureData: 'nonsense' }), null);
  assert.equal(textureMapOf({ textureData: { 'block/x': 42 } }), null, 'a non-string value is not a block id');
});

test('the cache key is order-independent, or the same material meshes once per block', () => {
  const a = textureMapOf({ textureData: { 'block/a': 'm:x', 'block/b': 'm:y' } })!;
  const b = textureMapOf({ textureData: { 'block/b': 'm:y', 'block/a': 'm:x' } })!;
  assert.equal(retextureKey(a), retextureKey(b));
  const c = textureMapOf({ textureData: { 'block/a': 'm:z', 'block/b': 'm:y' } })!;
  assert.notEqual(retextureKey(a), retextureKey(c));
});

// ---------------------------------------------------------------------------
// Rewriting quads

const quad = (texture: string): BakedQuad => ({
  positions: new Float32Array([0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0]),
  uvs: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
  normal: [0, 1, 0], texture, facing: 'up', cullface: null, tintIndex: -1, shade: true,
});

const MATERIALS: Record<string, string> = {
  'minecraft:birch_planks': 'minecraft:block/birch_planks',
  'mod:fancy_wood': 'mod:block/fancy/planks',
};
const lookup = (id: string) => MATERIALS[id] ?? null;

test('matching quads take the material texture and the rest are untouched', () => {
  const map = textureMapOf({ textureData: { 'block/oak_planks': 'minecraft:birch_planks' } })!;
  const quads = [quad('block/oak_planks'), quad('block/stone'), quad('block/oak_planks')];
  const out = retextureQuads(quads, map, lookup);
  assert.deepEqual(out.map((q) => q.texture), [
    'minecraft:block/birch_planks', 'block/stone', 'minecraft:block/birch_planks',
  ]);
});

// A mod's material need not follow `block/<name>`, which is why the lookup goes through the
// registry instead of building the path by hand.
test('a modded material resolves to whatever its own model names', () => {
  const map = textureMapOf({ textureData: { 'block/oak_planks': 'mod:fancy_wood' } })!;
  const out = retextureQuads([quad('block/oak_planks')], map, lookup);
  assert.equal(out[0].texture, 'mod:block/fancy/planks');
});

test('an unresolvable material leaves the template texture rather than an unbaked sprite', () => {
  const map = textureMapOf({ textureData: { 'block/oak_planks': 'mod:missing' } })!;
  const out = retextureQuads([quad('block/oak_planks')], map, lookup);
  assert.equal(out[0].texture, 'block/oak_planks', 'better the wrong wood than atlas (0,0)');
});

test('nothing to substitute returns the very same array, allocating nothing', () => {
  const map = textureMapOf({ textureData: { 'block/spruce_planks': 'minecraft:birch_planks' } })!;
  const quads = [quad('block/stone')];
  assert.equal(retextureQuads(quads, map, lookup), quads);
});

test('the original quads are never mutated — they are shared by every cell of that state', () => {
  const map = textureMapOf({ textureData: { 'block/oak_planks': 'minecraft:birch_planks' } })!;
  const quads = [quad('block/oak_planks')];
  retextureQuads(quads, map, lookup);
  assert.equal(quads[0].texture, 'block/oak_planks');
});

test('materials are collected for the bake, deduplicated', () => {
  const mats = materialsIn([
    { textureData: { 'block/oak_planks': 'minecraft:birch_planks', 'block/dark_oak_planks': 'minecraft:birch_planks' } },
    { textureData: { 'block/stone': 'mod:fancy_wood' } },
    { id: 'minecraft:chest' },
  ]);
  assert.deepEqual([...mats].sort(), ['minecraft:birch_planks', 'mod:fancy_wood']);
});

// ---------------------------------------------------------------------------
// Through the real mesher — the part that was actually broken.

const SPRITE = { u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1 };

function stateFor(key: string): RenderableState {
  const name = key.split('[')[0];
  const air = name === 'minecraft:air';
  const texture = name === 'minecraft:birch_planks'
    ? 'minecraft:block/birch_planks'
    : name === 'domum_ornamentum:plain' ? 'block/oak_planks' : 'block/stone';
  return {
    key, name, props: {},
    quads: air ? [] : [quad(texture)],
    renderType: 'solid', opaqueFullCube: !air, ambientOcclusion: false,
    tintSource: -1, provenance: air ? 'air' : 'asset', lightEmission: 0,
  };
}

/** One section holding a single block, with the block entities the caller supplies. */
function worldOf(blockKey: string, blockEntities: Array<Record<string, unknown>>) {
  const palette = ['minecraft:air', blockKey];
  const ids = new Uint16Array(4096);
  const at = { x: 5, y: 5, z: 5 };
  ids[(at.y << 8) | (at.z << 4) | at.x] = 1;
  const section = { ids, uniform: 0 };
  const beMap = new Map<string, Record<string, unknown>>();
  blockEntities.forEach((be, i) => beMap.set(String(i), be));
  const cache = new Map<string, RenderableState>();
  return {
    at,
    ctx: {
      world: {
        palette,
        biomePalette: ['minecraft:plains'],
        getChunk: (cx: number, cz: number) =>
          cx === 0 && cz === 0
            ? { sections: new Map([[0, section]]), blockEntities: beMap }
            : null,
        getState: (x: number, y: number, z: number) =>
          x < 0 || x > 15 || y < 0 || y > 15 || z < 0 || z > 15 ? 0 : ids[(y << 8) | (z << 4) | x],
        getBiome: () => 0,
        getLight: () => 0xff,
      },
      registry: {
        resolve: (key: string) => {
          let s = cache.get(key);
          if (!s) cache.set(key, (s = stateFor(key)));
          return s;
        },
      },
      atlas: { get: (id: string) => (used.add(id), SPRITE) },
      biomes: { tint: () => [1, 1, 1] as const },
      states: [],
    } as unknown as MeshContext,
  };
}

/** Every sprite the mesher asked the atlas for — what actually reached the geometry. */
let used = new Set<string>();

function spritesUsed(blockKey: string, bes: Array<Record<string, unknown>>): Set<string> {
  used = new Set();
  const { ctx } = worldOf(blockKey, bes);
  meshSection(ctx, 0, 0, 0);
  return used;
}

const DOMUM_BE = {
  id: 'domum_ornamentum:materially_retexturable', x: 5, y: 5, z: 5,
  textureData: { 'minecraft:block/oak_planks': 'minecraft:birch_planks' },
};

test('a block with no block entity draws its model texture', () => {
  const s = spritesUsed('domum_ornamentum:plain', []);
  assert.ok(s.has('block/oak_planks'), `expected oak, got ${[...s]}`);
  assert.ok(!s.has('minecraft:block/birch_planks'));
});

// The bug, stated: 28 blocks drew oak because the block entity was never consulted.
test('a block entity carrying textureData changes the sprite the mesher draws with', () => {
  const s = spritesUsed('domum_ornamentum:plain', [DOMUM_BE]);
  assert.ok(s.has('minecraft:block/birch_planks'), `expected birch, got ${[...s]}`);
  assert.ok(!s.has('block/oak_planks'), 'and the template texture is gone');
});

test('a block entity at a DIFFERENT position does not retexture this block', () => {
  const s = spritesUsed('domum_ornamentum:plain', [{ ...DOMUM_BE, x: 6 }]);
  assert.ok(s.has('block/oak_planks'), 'the neighbour block entity must not leak across');
});

test('a block entity in another section is not applied to this one', () => {
  const s = spritesUsed('domum_ornamentum:plain', [{ ...DOMUM_BE, y: 21 }]);
  assert.ok(s.has('block/oak_planks'));
});

test('an ordinary block entity leaves its block alone', () => {
  const s = spritesUsed('domum_ornamentum:plain', [{ id: 'minecraft:chest', x: 5, y: 5, z: 5 }]);
  assert.ok(s.has('block/oak_planks'));
});

test('the material is resolved through the registry, not guessed from the name', () => {
  // `minecraft:birch_planks` names the BLOCK; its texture is whatever its model resolves
  // to. The stub above deliberately gives it a namespaced sprite the naive
  // `block/<name>` guess would not produce.
  const s = spritesUsed('domum_ornamentum:plain', [DOMUM_BE]);
  assert.ok(s.has('minecraft:block/birch_planks'));
  assert.ok(!s.has('block/birch_planks'), 'the guessed path is not what gets used');
});
