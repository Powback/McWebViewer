/**
 * Recipe parsing, checked against the REAL baked bundle wherever possible.
 *
 * The claim being tested is that recipes are generic across mods for free — so the tests
 * that matter most are the ones run over all 130 jars' worth of output: that vanilla and
 * modded recipes both parse, that the indexes actually resolve, and that the coverage
 * number is real rather than achieved by dropping what did not fit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  readIngredient, readOutput, parseRecipe, recipeIdFromPath, itemsOf,
} from './recipes.js';
import type { RecipeBundle } from '../server/recipe-bake.js';

const BUNDLE = '.cache/baked/recipes.json';
const have = existsSync(BUNDLE);
const bundle: RecipeBundle | null = have
  ? (JSON.parse(readFileSync(BUNDLE, 'utf8')) as RecipeBundle)
  : null;
const needBundle = { skip: have ? false : 'run npm run bake-assets' };

// ---------------------------------------------------------------------------
// Ingredient and result shapes, as the jars actually spell them.

test('an ingredient parses in every shape the jars use', () => {
  assert.deepEqual(readIngredient({ item: 'minecraft:stone' }), [{ kind: 'item', id: 'minecraft:stone', amount: undefined }]);
  assert.deepEqual(readIngredient({ tag: 'c:stones' }), [{ kind: 'tag', id: 'c:stones', amount: undefined }]);
  assert.deepEqual(readIngredient('minecraft:stick'), [{ kind: 'item', id: 'minecraft:stick' }]);
  // Create's fluid ingredients carry millibuckets.
  assert.deepEqual(readIngredient({ type: 'neoforge:single', amount: 250, fluid: 'minecraft:water' }),
    [{ kind: 'fluid', id: 'minecraft:water', amount: 250 }]);
});

test('alternatives flatten to one list, because they are ONE input slot', () => {
  const got = readIngredient([{ item: 'a:x' }, { tag: 'b:y' }]);
  assert.equal(got.length, 2);
  assert.equal(got[0].kind, 'item');
  assert.equal(got[1].kind, 'tag');
});

test('a NeoForge `value` wrapper is unwrapped', () => {
  assert.deepEqual(readIngredient({ type: 'neoforge:tag', value: { tag: 'c:milk' } }),
    [{ kind: 'tag', id: 'c:milk', amount: undefined }]);
});

test('1.21 spells a result item `id`, and older/modded ones `item` — both work', () => {
  assert.deepEqual(readOutput({ id: 'create:tea', amount: 500 }), [{ id: 'create:tea', count: 500, chance: undefined }]);
  assert.deepEqual(readOutput({ item: 'minecraft:stone', count: 4 }), [{ id: 'minecraft:stone', count: 4, chance: undefined }]);
  assert.deepEqual(readOutput('minecraft:stick'), [{ id: 'minecraft:stick', count: 1 }]);
});

test('a chance output keeps its probability — a Create by-product is not certain', () => {
  const [o] = readOutput({ id: 'create:crushed_raw_nickel', chance: 0.75 });
  assert.equal(o.chance, 0.75);
});

test('a recipe id comes from its path, and only from a real recipe path', () => {
  assert.equal(recipeIdFromPath('data/create/recipe/mixing/tea.json'), 'create:mixing/tea');
  // The advancement that UNLOCKS a recipe is a different file with a different schema, and
  // there are thousands of them. Matching loosely swamps the real recipes with junk.
  assert.equal(recipeIdFromPath('data/create/advancement/recipes/mixing/tea.json'), null);
  assert.equal(recipeIdFromPath('assets/create/models/block/x.json'), null);
});

// ---------------------------------------------------------------------------
// Whole recipes.

test('a shaped recipe keeps its pattern AND its key, so a grid can be drawn', () => {
  const r = parseRecipe('x:y', {
    type: 'minecraft:crafting_shaped',
    key: { '#': { item: 'minecraft:acacia_planks' } },
    pattern: ['# #', '###'],
    result: { id: 'minecraft:acacia_boat', count: 1 },
  });
  assert.ok(r);
  assert.deepEqual(r.pattern, ['# #', '###']);
  assert.equal(r.key!['#'][0].id, 'minecraft:acacia_planks');
  assert.equal(r.outputs[0].id, 'minecraft:acacia_boat');
});

test('mod-specific processing fields do not stop a recipe being read', () => {
  // `heat_requirement`, `processing_time` and `neoforge:conditions` are unbounded and
  // mod-defined; they are extra fields, not obstacles.
  const r = parseRecipe('create:mixing/tea', {
    type: 'create:mixing',
    heat_requirement: 'heated',
    'neoforge:conditions': [{ type: 'neoforge:not' }],
    ingredients: [{ tag: 'minecraft:leaves' }],
    results: [{ amount: 500, id: 'create:tea' }],
  });
  assert.ok(r);
  assert.equal(r.type, 'create:mixing');
  assert.equal(r.inputs[0].id, 'minecraft:leaves');
  assert.equal(r.outputs[0].count, 500);
});

test('a recipe with neither input nor output is REFUSED, not recorded as empty', () => {
  // This is what keeps the coverage number honest: an unreadable recipe must be counted as
  // unreadable, not stored as a recipe that makes nothing from nothing.
  assert.equal(parseRecipe('x:y', { type: 'ae2:matter_cannon', ammo: [], weight: 1 }), null);
  assert.equal(parseRecipe('x:y', {}), null);
  assert.equal(parseRecipe('x:y', null), null);
});

test('tags stay tags — expanding one needs files this does not have', () => {
  const r = parseRecipe('x:y', { type: 't', ingredients: [{ tag: 'c:stones' }], result: 'a:b' })!;
  assert.equal(r.inputs[0].kind, 'tag');
  assert.deepEqual(itemsOf(r).inputs, ['#c:stones'], 'a tag must be distinguishable from an item');
});

// ---------------------------------------------------------------------------
// The real bundle, across all 130 jars.

test('the bake read the overwhelming majority of real recipes', needBundle, () => {
  const s = bundle!.stats;
  assert.ok(s.files > 10000, `only ${s.files} recipe files found across the jars`);
  const pct = (s.parsed / s.files) * 100;
  assert.ok(pct > 95, `only ${pct.toFixed(1)}% of recipes were readable`);
  assert.equal(s.parsed, bundle!.recipes.length);
  // The gap must be NAMED, not silently absorbed.
  assert.equal(
    Object.values(s.unreadableTypes).reduce((a, b) => a + b, 0), s.unreadable,
    'the unreadable count and the per-type breakdown disagree',
  );
});

test('both vanilla and MODDED recipes are present — this is the genericity claim', needBundle, () => {
  const ns = new Set(bundle!.recipes.map((r) => r.id.split(':')[0]));
  assert.ok(ns.has('minecraft'), 'no vanilla recipes');
  assert.ok(ns.size > 20, `only ${ns.size} namespaces produced recipes`);
  const types = new Set(bundle!.recipes.map((r) => r.type));
  assert.ok([...types].some((t) => t.startsWith('create:')), 'no Create recipe types');
  assert.ok(types.size > 40, `only ${types.size} recipe types`);
});

test('every recipe in the bundle actually has something to show', needBundle, () => {
  for (const r of bundle!.recipes) {
    assert.ok(r.inputs.length || r.outputs.length, `${r.id} has neither inputs nor outputs`);
    assert.ok(r.id.includes(':'), `${r.id} is not a namespaced id`);
  }
});

test('the indexes resolve to recipes that really do make and use the thing', needBundle, () => {
  let checked = 0;
  for (const [item, idxs] of Object.entries(bundle!.madeBy).slice(0, 300)) {
    for (const i of idxs) {
      const r = bundle!.recipes[i];
      assert.ok(r, `madeBy[${item}] points at a missing recipe ${i}`);
      assert.ok(r.outputs.some((o) => o.id === item),
        `${r.id} is indexed as making ${item} but does not output it`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} index entries checked`);
});

test('a known vanilla recipe is present and correct end to end', needBundle, () => {
  const sticks = bundle!.recipes.filter((r) => r.id === 'minecraft:stick');
  assert.ok(sticks.length > 0, 'the stick recipe is missing from a bake of the vanilla jar');
  const r = sticks[0];
  assert.ok(r.outputs.some((o) => o.id === 'minecraft:stick'));
  assert.ok(r.inputs.length > 0);
});
