/**
 * Held-item display transforms.
 *
 * Vanilla positions a held item with the `display` block of its model — `rotation` in
 * degrees, `translation` in sixteenths of a block, `scale` as a multiplier — and everything
 * inherits it through `parent`. `item/handheld` rolls a sword 55 degrees, which is what makes
 * it sit diagonally in a fist instead of flat; `item/generated` only lifts and shrinks.
 *
 * The bake carried none of this, so both the player's held item and every mob's were placed
 * by a fixed offset that read correctly rather than one derived from the model. That was
 * labelled as an approximation in the code; this is the fix for the half that is reachable.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { heldTransform, resolveItemDisplay, HELD_CONTEXTS } from './item-bake.js';
import type { Pack } from '../assets/pack.js';

/** A pack over a literal map of model JSON, so the parent walk can be driven exactly. */
function packOf(files: Record<string, unknown>): Pack {
  const enc = new TextEncoder();
  return {
    name: 'test',
    has: (p: string) => files[p] !== undefined,
    get: (p: string) => (files[p] === undefined ? undefined : enc.encode(JSON.stringify(files[p]))),
    list: (prefix: string) => Object.keys(files).filter((k) => k.startsWith(prefix)),
  };
}

const HANDHELD = {
  'assets/minecraft/models/item/golden_sword.json': { parent: 'item/handheld' },
  'assets/minecraft/models/item/handheld.json': {
    parent: 'item/generated',
    display: {
      thirdperson_righthand: { rotation: [0, -90, 55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] },
      firstperson_righthand: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
    },
  },
  'assets/minecraft/models/item/generated.json': {
    display: {
      thirdperson_righthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] },
      thirdperson_lefthand: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] },
    },
  },
};

test('an item inherits its held transform through the parent chain', () => {
  const d = resolveItemDisplay(packOf(HANDHELD), 'minecraft:golden_sword');
  assert.ok(d.thirdperson_righthand, 'a sword has a third-person transform, from item/handheld');
  assert.deepEqual(d.thirdperson_righthand.rotation, [0, -90, 55]);
});

// The 55-degree roll is the whole visible point: without it a sword lies flat in the fist.
test('the handheld roll survives resolution', () => {
  const d = resolveItemDisplay(packOf(HANDHELD), 'minecraft:golden_sword');
  assert.equal(d.thirdperson_righthand!.rotation[2], 55);
});

// Vanilla merges per context: handheld overrides only the hand contexts it defines.
test('the nearest ancestor wins per context, and the rest fall through', () => {
  const d = resolveItemDisplay(packOf(HANDHELD), 'minecraft:golden_sword');
  assert.deepEqual(d.thirdperson_righthand!.scale, [0.85, 0.85, 0.85], 'from handheld');
  assert.deepEqual(d.thirdperson_lefthand!.scale, [0.55, 0.55, 0.55], 'inherited from generated');
});

// Sixteenths of a block is vanilla's unit and nothing downstream should have to know that.
test('translation is converted out of sixteenths once, at the source', () => {
  const d = resolveItemDisplay(packOf(HANDHELD), 'minecraft:golden_sword');
  assert.deepEqual(d.thirdperson_righthand!.translation, [0, 4 / 16, 0.5 / 16]);
  assert.ok(d.thirdperson_righthand!.translation[1] < 1, 'a quarter of a block, not four blocks');
});

test('an item with no display anywhere in its chain resolves to nothing', () => {
  const bare = packOf({
    'assets/minecraft/models/item/mystery.json': { parent: 'item/plain' },
    'assets/minecraft/models/item/plain.json': { textures: { layer0: 'x' } },
  });
  assert.deepEqual(resolveItemDisplay(bare, 'minecraft:mystery'), {});
});

test('a missing model is not an error, just an item with no transform', () => {
  assert.deepEqual(resolveItemDisplay(packOf({}), 'minecraft:nothing'), {});
});

test('a modded item resolving through a vanilla parent still gets the transform', () => {
  const modded = packOf({
    ...HANDHELD,
    'assets/somemod/models/item/ruby_sword.json': { parent: 'item/handheld' },
  });
  const d = resolveItemDisplay(modded, 'somemod:ruby_sword');
  assert.deepEqual(d.thirdperson_righthand!.rotation, [0, -90, 55]);
});

test('a partial display block is filled in rather than left undefined', () => {
  const partial = packOf({
    'assets/minecraft/models/item/odd.json': {
      display: { thirdperson_righthand: { scale: [2, 2, 2] } },
    },
  });
  const t = resolveItemDisplay(partial, 'minecraft:odd').thirdperson_righthand!;
  assert.deepEqual(t.rotation, [0, 0, 0]);
  assert.deepEqual(t.translation, [0, 0, 0]);
  assert.deepEqual(t.scale, [2, 2, 2]);
});

test('an absent transform reads as the identity, so a caller never has to branch', () => {
  const id = heldTransform(undefined, 'thirdperson_righthand');
  assert.deepEqual(id.rotation, [0, 0, 0]);
  assert.deepEqual(id.scale, [1, 1, 1]);
  const d = resolveItemDisplay(packOf(HANDHELD), 'minecraft:golden_sword');
  assert.deepEqual(heldTransform(d, 'firstperson_lefthand').scale, [1, 1, 1], 'undefined context');
});

test('only the four hand contexts are carried; gui and ground are not needed here', () => {
  assert.deepEqual([...HELD_CONTEXTS].sort(), [
    'firstperson_lefthand', 'firstperson_righthand',
    'thirdperson_lefthand', 'thirdperson_righthand',
  ]);
  const withGui = packOf({
    'assets/minecraft/models/item/x.json': {
      display: { gui: { scale: [9, 9, 9] }, thirdperson_righthand: { scale: [1, 1, 1] } },
    },
  });
  const d = resolveItemDisplay(withGui, 'minecraft:x');
  assert.deepEqual(Object.keys(d), ['thirdperson_righthand']);
});
