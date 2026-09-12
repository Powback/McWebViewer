/**
 * Secondary entity layers.
 *
 * Every case here was chosen by measuring the live world first, and the tests that assert
 * a layer is ABSENT matter as much as the ones that assert it is present: 0 of 713 entities
 * wear armour and 0 of 33 wolves and cats are tamed, so armour and collar layers would be
 * invisible work. What is covered is what was counted: 28 sheep, 31 wolves, 5 horses.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

import {
  appearanceOf, appearanceTextures, assetPathOf, defaultVariantTexture, texturePathOf,
  variantIdsIn, variantLookup, villagerOverlayTextures, wolfCoatTextures, SHEEP_RGB,
} from './entity-layers.js';

// ---------------------------------------------------------------------------
// Sheep

test('an unsheared sheep gains a wool layer over its body', () => {
  const a = appearanceOf('minecraft:sheep', { Sheared: 0, Color: 0 });
  assert.equal(a.layers.length, 2, 'base body plus wool');
  assert.equal(a.layers[0].model, null, 'the first layer is the base model');
  assert.equal(a.layers[1].model, 'minecraft:sheep#fur');
  assert.match(a.layers[1].texture ?? '', /sheep_fur\.png$/);
});

// The bug, stated: a sheep with no fur layer is indistinguishable from a sheared one, which
// is why 28 broken sheep looked like 28 ordinary sheep.
test('a SHEARED sheep gains nothing, and is not the same appearance as a woolly one', () => {
  const shorn = appearanceOf('minecraft:sheep', { Sheared: 1, Color: 0 });
  const woolly = appearanceOf('minecraft:sheep', { Sheared: 0, Color: 0 });
  assert.equal(shorn.layers.length, 1);
  assert.equal(shorn.key, '', 'a shorn sheep is the plain base model');
  assert.notEqual(shorn.key, woolly.key);
});

test('wool colour comes from the Color byte, and each colour is its own cache key', () => {
  const white = appearanceOf('minecraft:sheep', { Color: 0 });
  const black = appearanceOf('minecraft:sheep', { Color: 15 });
  assert.deepEqual(white.layers[1].tint, SHEEP_RGB[0]);
  assert.deepEqual(black.layers[1].tint, SHEEP_RGB[15]);
  assert.notEqual(white.key, black.key,
    'two colours must not share a mesh, or every sheep in the world is one colour');
});

test('a missing or out-of-range Color falls back to white rather than to nothing', () => {
  assert.deepEqual(appearanceOf('minecraft:sheep', {}).layers[1].tint, SHEEP_RGB[0]);
  assert.deepEqual(appearanceOf('minecraft:sheep', { Color: 99 }).layers[1].tint, SHEEP_RGB[0]);
});

// The measurement that earned its keep: white WOOL is not white DYE.
test('white wool is the sheep grey, not pure white', () => {
  const [r, g, b] = SHEEP_RGB[0];
  assert.ok(r < 0.95 && g < 0.95 && b < 0.95, `white wool should be darkened, got ${r},${g},${b}`);
  assert.equal(r, g, 'and it is a neutral grey');
  assert.equal(g, b);
});

// ---------------------------------------------------------------------------
// Wolf — a base-texture swap, not an added layer

const WOLF_VARIANTS: Record<string, Record<string, unknown>> = {
  'minecraft:woods': {
    wild_texture: 'minecraft:entity/wolf/wolf_woods',
    tame_texture: 'minecraft:entity/wolf/wolf_woods_tame',
    angry_texture: 'minecraft:entity/wolf/wolf_woods_angry',
  },
  // The vanilla default, and the reason a name convention cannot be used: its wild texture
  // is `wolf`, NOT `wolf_pale`.
  'minecraft:pale': {
    wild_texture: 'minecraft:entity/wolf/wolf',
    tame_texture: 'minecraft:entity/wolf/wolf_tame',
    angry_texture: 'minecraft:entity/wolf/wolf_angry',
  },
};
const ctx = { variant: (_r: string, id: string) => WOLF_VARIANTS[id] ?? null };

test('a wolf takes its coat from the variant datapack entry, replacing the base texture', () => {
  const a = appearanceOf('minecraft:wolf', { variant: 'minecraft:woods' }, ctx);
  assert.equal(a.layers.length, 1, 'a coat is a texture swap, not an extra layer');
  assert.equal(a.layers[0].model, null);
  assert.equal(a.layers[0].texture, 'assets/minecraft/textures/entity/wolf/wolf_woods.png');
});

test("the pale variant resolves to wolf.png — the convention a name guess would have broken", () => {
  const a = appearanceOf('minecraft:wolf', { variant: 'minecraft:pale' }, ctx);
  assert.equal(a.layers[0].texture, 'assets/minecraft/textures/entity/wolf/wolf.png');
  assert.ok(!/wolf_pale/.test(a.layers[0].texture ?? ''), 'never wolf_pale');
});

test('a tamed wolf takes the tame coat and an angry one the angry coat', () => {
  const wild = appearanceOf('minecraft:wolf', { variant: 'minecraft:woods' }, ctx);
  const tame = appearanceOf('minecraft:wolf', { variant: 'minecraft:woods', Owner: 'x' }, ctx);
  const angry = appearanceOf('minecraft:wolf', { variant: 'minecraft:woods', AngerTime: 40 }, ctx);
  assert.match(tame.layers[0].texture ?? '', /wolf_woods_tame/);
  assert.match(angry.layers[0].texture ?? '', /wolf_woods_angry/);
  assert.equal(new Set([wild.key, tame.key, angry.key]).size, 3, 'three distinct meshes');
});

test('an unknown variant, or no variant table at all, leaves the wolf as it was', () => {
  assert.equal(appearanceOf('minecraft:wolf', { variant: 'mod:unknown' }, ctx).key, '');
  assert.equal(appearanceOf('minecraft:wolf', { variant: 'minecraft:woods' }).key, '',
    'with no datapack lookup installed the rule must not fire');
});

test('a modded variant works with no code change, which is the point of reading the JSON', () => {
  const modded = {
    variant: (_r: string, id: string) =>
      id === 'somemod:azure' ? { wild_texture: 'somemod:entity/wolf/azure' } : null,
  };
  const a = appearanceOf('minecraft:wolf', { variant: 'somemod:azure' }, modded);
  assert.equal(a.layers[0].texture, 'assets/somemod/textures/entity/wolf/azure.png');
});

// ---------------------------------------------------------------------------
// Horse

test('a horse takes its coat from the low byte of Variant, not always white', () => {
  // The five variants actually in the live world.
  const coats = [258, 261, 769, 1026, 1029].map(
    (v) => appearanceOf('minecraft:horse', { Variant: v }).layers[0].texture,
  );
  assert.deepEqual(coats.map((c) => c?.match(/horse_(\w+)\.png/)?.[1]),
    ['chestnut', 'gray', 'creamy', 'chestnut', 'gray']);
});

test('markings in the high byte do not change the coat', () => {
  const a = appearanceOf('minecraft:horse', { Variant: 2 });
  const b = appearanceOf('minecraft:horse', { Variant: 2 + (4 << 8) });
  assert.equal(a.layers[0].texture, b.layers[0].texture);
});

test('an unknown coat index leaves the horse alone rather than drawing nothing', () => {
  assert.equal(appearanceOf('minecraft:horse', { Variant: 99 }).key, '');
});

// ---------------------------------------------------------------------------
// Entities with no rule, and the ones deliberately left out

test('an ordinary mob has one base layer and an empty key, so it shares one mesh', () => {
  for (const type of ['minecraft:cow', 'minecraft:chicken', 'minecraft:creeper']) {
    const a = appearanceOf(type, { Color: 3, Variant: 7 });
    assert.equal(a.key, '', `${type} should not gain an appearance`);
    assert.equal(a.layers.length, 1);
  }
});

// Measured 0 of 713, so these must NOT quietly grow geometry; if someone adds them later
// this test should be updated with the number that justified it.
test('armour, collars and saddles are not drawn — measured 0 in the world', () => {
  const armoured = appearanceOf('minecraft:zombie', {
    ArmorItems: [{ id: 'minecraft:iron_boots' }, {}, {}, { id: 'minecraft:iron_helmet' }],
  });
  assert.equal(armoured.layers.length, 1);
  const tamedWolf = appearanceOf('minecraft:wolf', { Owner: 'x', CollarColor: 14 }, ctx);
  assert.ok(tamedWolf.layers.every((l) => !/collar/.test(l.texture ?? '')));
  const saddled = appearanceOf('minecraft:horse', { Variant: 2, SaddleItem: { id: 'minecraft:saddle' } });
  assert.ok(saddled.layers.every((l) => !/saddle/.test(l.texture ?? '')));
});

// ---------------------------------------------------------------------------
// Paths, and the bake

test('a resource id becomes the asset path the pack stack holds', () => {
  assert.equal(texturePathOf('minecraft:entity/wolf/wolf_woods'),
    'assets/minecraft/textures/entity/wolf/wolf_woods.png');
  assert.equal(texturePathOf('entity/sheep/sheep_fur'),
    'assets/minecraft/textures/entity/sheep/sheep_fur.png', 'a bare path defaults to minecraft');
});

test('variant ids are read back out of datapack paths, namespace included', () => {
  const ids = variantIdsIn('wolf_variant', [
    'data/minecraft/wolf_variant/woods.json',
    'data/somemod/wolf_variant/azure.json',
    'data/minecraft/tags/cat_variant/default_spawns.json',
    'data/minecraft/wolf_variant/readme.txt',
  ]);
  assert.deepEqual(ids.sort(), ['minecraft:woods', 'somemod:azure']);
});

test('variantLookup asks for the path the datapack actually uses', () => {
  const seen: string[] = [];
  const look = variantLookup((p) => { seen.push(p); return undefined; });
  look('wolf_variant', 'minecraft:woods');
  look('wolf_variant', 'somemod:azure');
  assert.deepEqual(seen, [
    'data/minecraft/wolf_variant/woods.json',
    'data/somemod/wolf_variant/azure.json',
  ]);
});

// The destroy_stage / fluid trap: geometry that samples a sprite nothing put in the atlas.
test('every texture an appearance can ask for is offered to the bake', () => {
  const baked = new Set(appearanceTextures());
  for (const v of [0, 1, 2, 3, 4, 5, 6]) {
    const tex = appearanceOf('minecraft:horse', { Variant: v }).layers[0].texture;
    assert.ok(tex && baked.has(tex), `horse coat ${v} (${tex}) must be baked`);
  }
  const wool = appearanceOf('minecraft:sheep', { Color: 0 }).layers[1].texture;
  assert.ok(wool && baked.has(wool), 'the wool texture must be baked');
});

test('wolf coat textures for the bake cover wild, tame and angry for every variant', () => {
  const texts = wolfCoatTextures(Object.keys(WOLF_VARIANTS), (_r, id) => WOLF_VARIANTS[id] ?? null);
  for (const want of ['wolf_woods.png', 'wolf_woods_tame.png', 'wolf_woods_angry.png', 'wolf.png']) {
    assert.ok(texts.some((t) => t.endsWith(want)), `${want} must be baked`);
  }
});

// ---------------------------------------------------------------------------
// Against the real game

const PHYSICS = 'harness/out/physics.json';

test('the wool colours match the running game, not a remembered table', { skip: !existsSync(PHYSICS) }, () => {
  const dyes = JSON.parse(readFileSync(PHYSICS, 'utf8')).dyes as
    Record<string, { id: number; rgb: number; sheep?: number[] }>;
  let checked = 0;
  const wrong: string[] = [];
  for (const [name, row] of Object.entries(dyes)) {
    if (!row.sheep) continue;
    checked++;
    const ours = SHEEP_RGB[row.id];
    if (!ours) { wrong.push(`${name}: no entry for id ${row.id}`); continue; }
    for (let i = 0; i < 3; i++) {
      if (Math.abs(ours[i] - row.sheep[i]) > 0.0005) {
        wrong.push(`${name}: ${ours.join(',')} != ${row.sheep.map((v) => v.toFixed(4)).join(',')}`);
        break;
      }
    }
  }
  assert.equal(checked, 16, 'all sixteen dyes should have been extracted');
  assert.deepEqual(wrong, []);
});

test('the sheep table really does differ from the dye table', { skip: !existsSync(PHYSICS) }, () => {
  const dyes = JSON.parse(readFileSync(PHYSICS, 'utf8')).dyes as
    Record<string, { id: number; rgb: number; sheep?: number[] }>;
  const white = dyes.white;
  const dyeRgb = [(white.rgb >> 16) & 0xff, (white.rgb >> 8) & 0xff, white.rgb & 0xff].map((v) => v / 255);
  assert.ok(Math.abs(dyeRgb[0] - SHEEP_RGB[0][0]) > 0.05,
    'taking the DYE colour for white wool would have been wrong on 24 of the 28 sheep here');
});

// ---------------------------------------------------------------------------
// The tint actually reaching the vertex buffer.
//
// `appearanceOf` putting an RGB on a layer is only half the job: if `meshEntityQuads` drops
// it, every sheep renders white and the tests above still pass. This runs the real geometry
// path and reads the colour buffer back — decoding the unorm8 the narrowed vertex format
// stores, which is the other thing that could silently go wrong.

import { buildEntityQuads, meshEntityQuads, makeEntityModelSet } from './entity-geometry.js';
import type { EntityIndex, EntityModels } from './entity-geometry.js';
import type { TextureAtlas } from './atlas.js';

const CUBE = {
  texWidth: 16, texHeight: 16,
  parts: {
    body: {
      pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number],
      cubes: [{
        from: [0, 0, 0] as [number, number, number], to: [8, 8, 8] as [number, number, number],
        size: [8, 8, 8] as [number, number, number], uv: [0, 0] as [number, number],
        grow: 0, growXYZ: [0, 0, 0] as [number, number, number], mirror: false,
      }],
    },
  },
};

const MODELS = { 'test:base#main': CUBE, 'test:over#main': CUBE } as unknown as EntityModels;
const INDEX = {
  'test:mob': { renderer: '', model: 'test:base#main', texture: 'assets/test/textures/entity/base.png' },
} as unknown as EntityIndex;

const ATLAS = {
  get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1 }),
} as unknown as TextureAtlas;

/** Brightest vertex colour in the mesh, decoded from the unorm8 the format stores. */
function brightest(mesh: ReturnType<typeof meshEntityQuads>): [number, number, number] {
  const c = mesh.layers.cutout!.colors;
  let best: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < c.length; i += 4) {
    const v: [number, number, number] = [c[i] / 255, c[i + 1] / 255, c[i + 2] / 255];
    if (v[0] + v[1] + v[2] > best[0] + best[1] + best[2]) best = v;
  }
  return best;
}

test('a layer tint is multiplied into the vertex colours, not dropped', () => {
  const set = makeEntityModelSet(MODELS, INDEX);
  const plain = meshEntityQuads(buildEntityQuads(set, 'test:mob', ATLAS)!, ATLAS);
  const tinted = meshEntityQuads(buildEntityQuads(set, 'test:mob', ATLAS, {
    key: 't', layers: [{ model: null, texture: null, tint: [0.2, 0.4, 0.8] }],
  })!, ATLAS);
  const [pr, pg, pb] = brightest(plain);
  const [tr, tg, tb] = brightest(tinted);
  assert.ok(Math.abs(pr - 1) < 0.01, `untinted geometry keeps full shade, got ${pr}`);
  // Vanilla's top-face shade is 1.0, so the brightest vertex is the tint itself.
  assert.ok(Math.abs(tr - 0.2) < 0.01, `red ${tr} should be 0.2`);
  assert.ok(Math.abs(tg - 0.4) < 0.01, `green ${tg} should be 0.4`);
  assert.ok(Math.abs(tb - 0.8) < 0.01, `blue ${tb} should be 0.8`);
  assert.ok(pg > tg && pb > tb, 'and the tint darkens rather than brightens here');
});

test('a second layer adds geometry, and only that layer is tinted', () => {
  const set = makeEntityModelSet(MODELS, INDEX);
  const one = buildEntityQuads(set, 'test:mob', ATLAS)!;
  const two = buildEntityQuads(set, 'test:mob', ATLAS, {
    key: 't',
    layers: [
      { model: null, texture: null, tint: null },
      { model: 'test:over#main', texture: null, tint: [0, 0, 0] },
    ],
  })!;
  assert.equal(two.length, one.length * 2, 'the overlay doubles the quad count');
  assert.equal(two.filter((q) => q.tint).length, one.length, 'exactly the overlay is tinted');
  assert.ok(two.slice(0, one.length).every((q) => !q.tint), 'the base layer keeps its own colour');
});

test('a layer whose texture is not in the atlas is skipped, not drawn untextured', () => {
  const set = makeEntityModelSet(MODELS, INDEX);
  const sparse = {
    get: (id: string) => (id === 'test:entity/base'
      ? { u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1 } : undefined),
  } as unknown as TextureAtlas;
  const quads = buildEntityQuads(set, 'test:mob', sparse, {
    key: 't',
    layers: [
      { model: null, texture: null, tint: null },
      { model: 'test:over#main', texture: 'assets/test/textures/entity/absent.png', tint: null },
    ],
  })!;
  const base = buildEntityQuads(set, 'test:mob', sparse)!;
  assert.equal(quads.length, base.length, 'the unbaked layer contributes nothing');
});

// ---------------------------------------------------------------------------
// Villager robes and horse markings.
//
// These are coplanar with the body — the same model, a mostly-transparent texture, drawn
// after. No inflate: the entity material leaves `depthFunc` at three.js's default
// LessEqualDepth, so the later submission wins the depth test, which is exactly how vanilla
// layers them. The alternative (nudging the geometry outward) would have been a guess.

test('every villager gets its biome robe, employed or not', () => {
  // Measured: 5 of this world's 7 villagers are unemployed, so a profession-only rule
  // would have changed nothing for five of them.
  const a = appearanceOf('minecraft:villager', {
    VillagerData: { type: 'minecraft:plains', profession: 'minecraft:none', level: 1 },
  });
  assert.equal(a.layers.length, 2, 'base plus the biome robe');
  assert.match(a.layers[1].texture ?? '', /villager\/type\/plains\.png$/);
});

test('an employed villager also gets a profession robe and a rank badge', () => {
  const a = appearanceOf('minecraft:villager', {
    VillagerData: { type: 'minecraft:plains', profession: 'minecraft:shepherd', level: 1 },
  });
  assert.deepEqual(a.layers.slice(1).map((l) => l.texture?.match(/villager\/(.+)\.png$/)?.[1]), [
    'type/plains', 'profession/shepherd', 'profession_level/stone',
  ]);
});

// Vanilla's own exception, and this world has exactly one nitwit to justify carrying it.
test('a nitwit wears the robe but no rank badge', () => {
  const a = appearanceOf('minecraft:villager', {
    VillagerData: { type: 'minecraft:plains', profession: 'minecraft:nitwit', level: 1 },
  });
  assert.ok(a.layers.some((l) => /profession\/nitwit/.test(l.texture ?? '')));
  assert.ok(!a.layers.some((l) => /profession_level/.test(l.texture ?? '')),
    'a nitwit has no rank to badge');
});

test('the rank badge follows the trading level', () => {
  const badge = (level: number) => appearanceOf('minecraft:villager', {
    VillagerData: { type: 'minecraft:plains', profession: 'minecraft:farmer', level },
  }).layers.at(-1)?.texture?.match(/profession_level\/(\w+)\./)?.[1];
  assert.deepEqual([1, 2, 3, 4, 5].map(badge), ['stone', 'iron', 'gold', 'emerald', 'diamond']);
  assert.equal(badge(99), 'diamond', 'an out-of-range level clamps rather than vanishing');
});

test('a modded profession becomes its own texture path with no code change', () => {
  const a = appearanceOf('minecraft:villager', {
    VillagerData: { type: 'somemod:volcanic', profession: 'somemod:smelter', level: 2 },
  });
  assert.match(a.layers[1].texture ?? '', /^assets\/somemod\/textures\/entity\/villager\/type\/volcanic\.png$/);
  assert.match(a.layers[2].texture ?? '', /^assets\/somemod\/textures\/entity\/villager\/profession\/smelter\.png$/);
});

test('a villager with no VillagerData is left alone', () => {
  assert.equal(appearanceOf('minecraft:villager', {}).key, '');
});

test('a horse wears its markings over its coat, in that order', () => {
  const a = appearanceOf('minecraft:horse', { Variant: 2 + (4 << 8) });
  assert.equal(a.layers.length, 2);
  assert.match(a.layers[0].texture ?? '', /horse_chestnut\.png$/);
  assert.match(a.layers[1].texture ?? '', /horse_markings_blackdots\.png$/);
});

test('markings index 0 means none, so a plain horse gets one layer', () => {
  const a = appearanceOf('minecraft:horse', { Variant: 2 });
  assert.equal(a.layers.length, 1);
});

test('the five live horses each get the coat and markings their Variant names', () => {
  const got = [258, 261, 769, 1026, 1029].map((v) => {
    const l = appearanceOf('minecraft:horse', { Variant: v }).layers;
    return [l[0].texture?.match(/horse_(\w+)\.png/)?.[1], l[1]?.texture?.match(/markings_(\w+)\./)?.[1]];
  });
  assert.deepEqual(got, [
    ['chestnut', 'white'], ['gray', 'white'], ['creamy', 'whitedots'],
    ['chestnut', 'blackdots'], ['gray', 'blackdots'],
  ]);
});

test('villager robes are found in the pack for the bake, and nothing else is', () => {
  const found = villagerOverlayTextures([
    'assets/minecraft/textures/entity/villager/type/plains.png',
    'assets/minecraft/textures/entity/villager/profession/shepherd.png',
    'assets/somemod/textures/entity/villager/profession/smelter.png',
    'assets/minecraft/textures/entity/villager/profession/shepherd.png.mcmeta',
    'assets/minecraft/textures/entity/villager/villager.png',
    'assets/minecraft/textures/entity/wolf/wolf.png',
  ]);
  assert.deepEqual(found.sort(), [
    'assets/minecraft/textures/entity/villager/profession/shepherd.png',
    'assets/minecraft/textures/entity/villager/type/plains.png',
    'assets/somemod/textures/entity/villager/profession/smelter.png',
  ]);
});

test('the horse markings and rank badges are offered to the bake', () => {
  const baked = new Set(appearanceTextures());
  for (const v of [1, 2, 3, 4]) {
    const tex = appearanceOf('minecraft:horse', { Variant: (v << 8) }).layers[1].texture;
    assert.ok(tex && baked.has(tex), `markings ${v} (${tex}) must be baked`);
  }
  for (const badge of ['stone', 'iron', 'gold', 'emerald', 'diamond']) {
    assert.ok([...baked].some((t) => t.endsWith(`profession_level/${badge}.png`)), `${badge} badge`);
  }
});

test('overlays are coplanar with the body — the layers share one model deliberately', () => {
  const a = appearanceOf('minecraft:villager', {
    VillagerData: { type: 'minecraft:plains', profession: 'minecraft:farmer', level: 1 },
  });
  assert.ok(a.layers.every((l) => l.model === null),
    'every villager layer is the villager model; only the texture differs');
});

// ---------------------------------------------------------------------------
// Mobs whose whole skin is a registry entry.
//
// Cats and frogs work like wolves, but their variants are a BUILT-IN registry rather than a
// datapack, so there is no JSON to read and the mapping is extracted from the running game.
// The effect of not having it was total rather than cosmetic: the entity index could not
// pick one texture for a cat, left it null, and `geometryFor` then refused to draw the mob
// at all — 2 cats invisible, and every cat in any world.

const REGISTRY_VARIANTS: Record<string, Record<string, unknown>> = {
  'minecraft:persian': { texture: 'minecraft:textures/entity/cat/persian.png' },
  'minecraft:tabby': { texture: 'minecraft:textures/entity/cat/tabby.png' },
};
const catCtx = {
  variant: (r: string, id: string) => (r === 'cat_variant' ? REGISTRY_VARIANTS[id] ?? null : null),
  variantIds: (r: string) => (r === 'cat_variant' ? Object.keys(REGISTRY_VARIANTS) : []),
};

test('a cat takes the coat its variant names', () => {
  const a = appearanceOf('minecraft:cat', { variant: 'minecraft:persian' }, catCtx);
  assert.equal(a.layers.length, 1, 'the coat replaces the base texture, it is not an overlay');
  assert.equal(a.layers[0].texture, 'assets/minecraft/textures/entity/cat/persian.png');
});

test('two cat variants are different meshes', () => {
  const a = appearanceOf('minecraft:cat', { variant: 'minecraft:persian' }, catCtx);
  const b = appearanceOf('minecraft:cat', { variant: 'minecraft:tabby' }, catCtx);
  assert.notEqual(a.key, b.key);
});

test('an unknown cat variant leaves the mob on its default coat', () => {
  assert.equal(appearanceOf('minecraft:cat', { variant: 'mod:unknown' }, catCtx).key, '');
});

// The registry spells its texture differently from the datapack, and conflating the two
// produces `assets/minecraft/textures/textures/...`.
test('a registry texture path is converted, not double-prefixed', () => {
  assert.equal(assetPathOf('minecraft:textures/entity/cat/tabby.png'),
    'assets/minecraft/textures/entity/cat/tabby.png');
  assert.equal(assetPathOf('somemod:textures/entity/x.png'), 'assets/somemod/textures/entity/x.png');
  assert.ok(!assetPathOf('minecraft:textures/entity/cat/tabby.png').includes('textures/textures'));
});

// This is the part that makes the mob drawable at all, before any per-entity rule runs.
test('a variant-textured type gets a stand-in texture so it is not refused outright', () => {
  const def = defaultVariantTexture('minecraft:cat', catCtx);
  assert.ok(def, 'a cat must have some texture to be drawable');
  assert.match(def, /^assets\/minecraft\/textures\/entity\/cat\/\w+\.png$/);
});

test('a type with a fixed texture asks for no stand-in', () => {
  assert.equal(defaultVariantTexture('minecraft:cow', catCtx), null);
  assert.equal(defaultVariantTexture('minecraft:cat', {}), null, 'and none is invented without a registry');
});
