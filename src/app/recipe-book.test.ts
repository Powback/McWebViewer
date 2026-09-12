/**
 * The recipe browser's logic, and the honesty rules it has to keep.
 *
 * Run against the REAL baked bundle where it exists, so "search finds andesite alloy" means
 * it found it among 12,488 real recipes from 130 real jars, not among three fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { searchRecipes, describeRecipe, ingredientLabel, shortId, type RecipeBundleView } from './recipe-book.js';
import type { Recipe } from '../assets/recipes.js';

const BUNDLE = '.cache/baked/recipes.json';
const have = existsSync(BUNDLE);
const bundle: RecipeBundleView | null = have
  ? (JSON.parse(readFileSync(BUNDLE, 'utf8')) as RecipeBundleView)
  : null;
const needBundle = { skip: have ? false : 'run npm run bake-assets' };

// ---------------------------------------------------------------------------
// Labels.

test('a namespaced id reads as words', () => {
  assert.equal(shortId('create:andesite_alloy'), 'andesite alloy');
  assert.equal(shortId('minecraft:stick'), 'stick');
});

test('a TAG is labelled as a tag, never as one arbitrary item', () => {
  // Showing a member would be a plausible lie about what the recipe accepts.
  assert.equal(ingredientLabel({ kind: 'tag', id: 'c:stones' }), '#stones');
  assert.equal(ingredientLabel({ kind: 'item', id: 'minecraft:stone' }), 'stone');
});

test('a fluid says so, and carries its amount', () => {
  assert.equal(ingredientLabel({ kind: 'fluid', id: 'minecraft:water', amount: 250 }),
    '250 water (fluid)');
});

test('a chance output shows its probability, so a by-product is not read as certain', () => {
  const r: Recipe = {
    id: 'create:crushing/x', type: 'create:crushing',
    inputs: [{ kind: 'tag', id: 'c:raw_materials/nickel' }],
    outputs: [{ id: 'create:crushed_raw_nickel', count: 1 }, { id: 'create:experience_nugget', count: 1, chance: 0.75 }],
  };
  const text = describeRecipe(r);
  assert.match(text, /75%/, 'a 0.75-chance by-product must not read as guaranteed');
  assert.match(text, /crushing/);
});

test('a count above one is shown; a count of one is not noise', () => {
  const one: Recipe = { id: 'a:b', type: 't', inputs: [], outputs: [{ id: 'x:y', count: 1 }] };
  const four: Recipe = { id: 'a:b', type: 't', inputs: [], outputs: [{ id: 'x:y', count: 4 }] };
  assert.doesNotMatch(describeRecipe(one), /1x/);
  assert.match(describeRecipe(four), /4x/);
});

// ---------------------------------------------------------------------------
// Search, over the real bundle.

test('an empty query shows nothing rather than all 12,000 recipes', () => {
  const stub: RecipeBundleView = {
    recipes: [{ id: 'a:b', type: 't', inputs: [], outputs: [{ id: 'x:y', count: 1 }] }],
    madeBy: {}, usedIn: {}, stats: { files: 1, parsed: 1, unreadable: 0, types: 1 },
  };
  assert.deepEqual(searchRecipes(stub, ''), []);
  assert.deepEqual(searchRecipes(stub, '   '), []);
});

test('searching a VANILLA item finds it', needBundle, () => {
  const hits = searchRecipes(bundle!, 'stick');
  assert.ok(hits.length > 0, 'no recipe found for stick');
  const first = bundle!.recipes[hits[0]];
  assert.ok(first.outputs.some((o) => o.id.includes('stick')),
    `top hit ${first.id} does not output a stick`);
});

test('searching a MODDED item finds it — the genericity claim, in the UI', needBundle, () => {
  const hits = searchRecipes(bundle!, 'andesite alloy');
  assert.ok(hits.length > 0, 'no recipe found for Create andesite alloy');
  const first = bundle!.recipes[hits[0]];
  assert.ok(first.outputs.some((o) => o.id === 'create:andesite_alloy'),
    `top hit ${first.id} does not output andesite alloy`);
});

test('an exact name outranks a partial one', needBundle, () => {
  // "stone" matches hundreds of ids; the block itself must not be buried under
  // `stone_bricks`, `stone_slab`, `blackstone`...
  const hits = searchRecipes(bundle!, 'stone');
  assert.ok(hits.length > 0);
  const top = bundle!.recipes[hits[0]];
  assert.ok(top.outputs.some((o) => shortId(o.id) === 'stone' || o.id === 'minecraft:stone'),
    `top hit for "stone" was ${top.id}, which is not stone itself`);
});

test('a search that matches nothing returns nothing, not everything', needBundle, () => {
  assert.deepEqual(searchRecipes(bundle!, 'zzzzz-not-an-item'), []);
});

test('results are capped, so the panel cannot be asked to draw thousands of rows', needBundle, () => {
  const hits = searchRecipes(bundle!, 'a', 20);
  assert.ok(hits.length <= 20, `${hits.length} results came back past the cap`);
});

test('every search hit is a real index into the bundle', needBundle, () => {
  for (const q of ['stone', 'ingot', 'andesite', 'planks']) {
    for (const i of searchRecipes(bundle!, q)) {
      assert.ok(bundle!.recipes[i], `search returned out-of-range index ${i} for "${q}"`);
    }
  }
});

test('describeRecipe never renders an empty recipe as blank', needBundle, () => {
  // Every row must say something; a blank line in the list looks like a bug.
  for (const i of searchRecipes(bundle!, 'ingot', 40)) {
    const text = describeRecipe(bundle!.recipes[i]);
    assert.ok(text.trim().length > 3, `empty description for ${bundle!.recipes[i].id}`);
  }
});
