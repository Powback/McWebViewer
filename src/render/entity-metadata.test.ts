/**
 * Entity appearance from SpacetimeDB metadata.
 *
 * The blobs below are REAL — copied out of the live mirror, not invented — so the tests fail
 * if the wire shape changes rather than only if my reading of it does:
 *
 *   sheep      {"9":8.0,"17":1,"19":4}
 *   horse      {"9":53.0,"17":1,"20":2}
 *   villager   {"9":20.0,"17":1,"20":[2,5,3]}
 *   creeper    {"9":20.0,"17":1,"19":true}
 *   parrot     {"9":6.0,"17":1,"21":3}
 *   item       [1, []]            <- the none case
 *
 * The index shift is the thing to keep in view: on this pack sheep colour is 19, not the 17
 * every protocol reference lists, because two mods add fields to `LivingEntity`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  metadataOffset, nameForId, nbtFromMetadata, parseAppearance, setMetadataOffset,
  type VariantTable,
} from './entity-metadata.js';

const CAT: VariantTable = {
  'minecraft:tabby': { id: 0 }, 'minecraft:black': { id: 1 },
  'minecraft:siamese': { id: 3 }, 'minecraft:calico': { id: 5 },
};
const VILLAGER_TYPE: VariantTable = { 'minecraft:desert': { id: 0 }, 'minecraft:plains': { id: 2 } };
const VILLAGER_PROF: VariantTable = { 'minecraft:cleric': { id: 4 }, 'minecraft:farmer': { id: 5 } };
const ctx = {
  registry: (n: string) => ({
    cat_variant: CAT, villager_type: VILLAGER_TYPE, villager_profession: VILLAGER_PROF,
  } as Record<string, VariantTable>)[n],
};

function reset() { setMetadataOffset(2); }

// ---------------------------------------------------------------------------
// The column

test('the column is a tagged option, and the none case is not data', () => {
  assert.deepEqual(parseAppearance([0, '{"19":4}']), { '19': 4 });
  assert.equal(parseAppearance([1, []]), null, 'an item-shaped entity carries nothing');
  assert.equal(parseAppearance(null), null);
  assert.equal(parseAppearance(''), null);
});

test('a malformed payload is absent, not an exception', () => {
  assert.equal(parseAppearance([0, 'not json']), null);
  assert.equal(parseAppearance([0, '[1,2,3]']), null, 'an array is not a scalar map');
  assert.equal(parseAppearance([0, '"a string"']), null);
});

// ---------------------------------------------------------------------------
// The shift — the whole reason this is not a copied index table

test('the offset is applied once, and changing it moves every rule together', () => {
  reset();
  assert.equal(metadataOffset(), 2);
  // The real sheep blob: colour lives at 19 on this pack.
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '9': 8, '17': 1, '19': 4 }, ctx),
    { Color: 4, Sheared: 0 });
  // A pack with no shift puts it at vanilla's 17.
  setMetadataOffset(0);
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '17': 4 }, ctx), { Color: 4, Sheared: 0 });
  // And with the wrong offset the field is simply absent rather than misread.
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '19': 4 }, ctx), {});
  reset();
});

// ---------------------------------------------------------------------------
// Sheep — one byte carrying two facts

test('a sheep colour is the low nibble and shearing the 0x10 bit', () => {
  reset();
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '19': 4 }, ctx), { Color: 4, Sheared: 0 });
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '19': 15 }, ctx), { Color: 15, Sheared: 0 });
  // 0x10 | 14 — the mcspacetime README's own example
  assert.deepEqual(nbtFromMetadata('minecraft:sheep', { '19': 30 }, ctx), { Color: 14, Sheared: 1 });
});

// The property the wire semantics demand, and the one most easily got backwards.
test('a WHITE sheep sends no colour at all, and must not become "no appearance"', () => {
  reset();
  // Only the fields that differ from the class defaults are sent; white is the default.
  const nbt = nbtFromMetadata('minecraft:sheep', { '9': 8, '17': 1 }, ctx);
  assert.deepEqual(nbt, {}, 'nothing to override');
  // And the shared rule then supplies the default, which is what makes it render white
  // rather than not render.
});

// ---------------------------------------------------------------------------
// The other rules

test('a horse variant is the same packed int the NBT carries, needing no registry', () => {
  reset();
  assert.deepEqual(nbtFromMetadata('minecraft:horse', { '9': 53, '17': 1, '20': 2 }, {}),
    { Variant: 2 }, 'and it works with no registry at all');
});

test('a villager resolves its type and profession through the registry ids', () => {
  reset();
  assert.deepEqual(nbtFromMetadata('minecraft:villager', { '20': [2, 5, 3] }, ctx),
    { VillagerData: { type: 'minecraft:plains', profession: 'minecraft:farmer', level: 3 } });
});

test('a registry id is NOT its position — calico is id 5 while sitting fourth', () => {
  assert.equal(nameForId(ctx, 'cat_variant', 5), 'minecraft:calico');
  assert.equal(nameForId(ctx, 'cat_variant', 3), 'minecraft:siamese');
  assert.equal(nameForId(ctx, 'cat_variant', 99), null, 'an unknown id resolves to nothing');
});

test('a cat resolves its coat through the registry', () => {
  reset();
  assert.deepEqual(nbtFromMetadata('minecraft:cat', { '21': 3 }, ctx), { variant: 'minecraft:siamese' });
});

test('without the registry a variant is left alone rather than guessed', () => {
  reset();
  assert.deepEqual(nbtFromMetadata('minecraft:cat', { '21': 3 }, {}), {});
  assert.deepEqual(nbtFromMetadata('minecraft:villager', { '20': [2, 5, 3] }, {}), {});
});

test('a wolf gives up its collar but not its coat, and says so by omission', () => {
  reset();
  // The coat is a datapack registry the mirror does not carry; only the collar is reachable.
  assert.deepEqual(nbtFromMetadata('minecraft:wolf', { '22': 11 }, ctx), { CollarColor: 11 });
  assert.equal('variant' in nbtFromMetadata('minecraft:wolf', { '22': 11, '24': 2 }, ctx), false);
});

test('an entity with no rule yields nothing rather than a partial guess', () => {
  reset();
  for (const t of ['minecraft:creeper', 'minecraft:panda', 'somemod:thing', 'minecraft:item']) {
    assert.deepEqual(nbtFromMetadata(t, { '19': 1, '22': 4 }, ctx), {}, t);
  }
});

test('a blob with only health and flags produces nothing to override', () => {
  reset();
  // Every live mob carries index 9 (health) and 17 (Mob flags); neither is appearance.
  for (const t of ['minecraft:sheep', 'minecraft:horse', 'minecraft:cat']) {
    assert.deepEqual(nbtFromMetadata(t, { '9': 20, '17': 1 }, ctx), {}, t);
  }
});
