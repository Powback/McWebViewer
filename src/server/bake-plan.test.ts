/**
 * The bake-staleness decision.
 *
 * The failure this guards against is silent: a state the bundle lacks is drawn as nothing,
 * so a wrong "up to date" here is a world with holes in it and no error anywhere. The
 * other direction costs a needless bake, which is cheap but not free on a host that also
 * runs the server — so "nothing changed" must genuinely mean no bake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAKE_FORMAT, planBake, type BundleInventory, type WorldInventory } from './bake-plan.js';

function world(over: Partial<WorldInventory> = {}): WorldInventory {
  return {
    states: ['minecraft:air', 'minecraft:stone', 'computercraft:turtle_normal[facing=north,waterlogged=false]'],
    biomes: ['minecraft:plains'],
    entityTypes: ['minecraft:cow'],
    regions: ['r.-1.0.mca'],
    ...over,
  };
}

function bundle(over: Partial<BundleInventory> = {}): BundleInventory {
  return {
    version: BAKE_FORMAT,
    states: {
      'minecraft:air': 1,
      'minecraft:stone': 1,
      'computercraft:turtle_normal[facing=north,waterlogged=false]': 1,
    },
    biomes: { 'minecraft:plains': 1 },
    entityTypes: ['minecraft:cow'],
    regions: ['r.-1.0.mca'],
    ...over,
  };
}

test('a bundle that covers the world is not re-baked', () => {
  const plan = planBake(world(), bundle());
  assert.equal(plan.needed, false);
  assert.deepEqual(plan.reasons, []);
  assert.deepEqual(plan.missingStates, []);
});

test('no bundle at all means bake, and every state is missing', () => {
  const plan = planBake(world(), null);
  assert.equal(plan.needed, true);
  assert.equal(plan.missingStates.length, 3);
});

test('a block the world gained since the bake forces one, and is named', () => {
  // The reference failure: turtles built a stone-brick tower after the bake.
  const w = world({
    states: [...world().states, 'minecraft:stone_bricks',
      'minecraft:stone_brick_wall[east=low,north=none,south=none,up=true,waterlogged=false,west=none]'],
  });
  const plan = planBake(w, bundle());
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.missingStates, [
    'minecraft:stone_bricks',
    'minecraft:stone_brick_wall[east=low,north=none,south=none,up=true,waterlogged=false,west=none]',
  ]);
  assert.equal(plan.reasons.length, 1);
  assert.match(plan.reasons[0], /2 states not in bundle: minecraft:stone_bricks/);
});

test('a new ORIENTATION of a known block is a new state — a turtle turning south counts', () => {
  const w = world({
    states: [...world().states, 'computercraft:turtle_normal[facing=south,waterlogged=false]'],
  });
  assert.equal(planBake(w, bundle()).needed, true);
});

test('states the bundle has but the world no longer does are NOT a reason to bake', () => {
  const b = bundle({ states: { ...bundle().states, 'minecraft:gold_block': 1 } });
  assert.equal(planBake(world(), b).needed, false);
});

test('the reason line names a few examples and counts the rest', () => {
  const extra = Array.from({ length: 9 }, (_, i) => `mod:block_${i}`);
  const plan = planBake(world({ states: [...world().states, ...extra] }), bundle());
  assert.match(plan.reasons[0], /9 states not in bundle: mod:block_0, mod:block_1, mod:block_2, mod:block_3, \+5 more/);
});

test('a new biome or entity type is a reason too — their tints and sprites live in the bake', () => {
  assert.equal(planBake(world({ biomes: ['minecraft:plains', 'minecraft:desert'] }), bundle()).needed, true);
  assert.equal(planBake(world({ entityTypes: ['minecraft:cow', 'minecraft:bee'] }), bundle()).needed, true);
});

test('a bundle from before entity types were recorded is baked once to record them', () => {
  const b = bundle();
  delete b.entityTypes;
  const plan = planBake(world(), b);
  assert.equal(plan.needed, true);
  assert.match(plan.reasons[0], /predates entity-type tracking/);
});

test('a different region set is a different bundle', () => {
  assert.equal(planBake(world({ regions: ['r.-1.0.mca', 'r.-2.0.mca'] }), bundle()).needed, true);
  // Same set, different order: not a change.
  assert.equal(
    planBake(world({ regions: ['r.-2.0.mca', 'r.-1.0.mca'] }),
      bundle({ regions: ['r.-1.0.mca', 'r.-2.0.mca'] })).needed,
    false,
  );
});

test('prototype names are not mistaken for baked states', () => {
  // `'constructor' in {}` is true; a block called that must still count as missing.
  const plan = planBake(world({ states: ['constructor'] }), bundle());
  assert.deepEqual(plan.missingStates, ['constructor']);
});

test('a bundle written by an older baker format is baked once even with nothing new in the world', () => {
  // The world is fully covered; only the baker's own rules changed (e.g. monitors gained
  // their screen overlay). Set comparison alone would never notice.
  const plan = planBake(world(), bundle({ version: 1 }));
  assert.equal(plan.needed, true);
  assert.match(plan.reasons.join(';'), /bundle format 1 predates/);
  assert.deepEqual(plan.missingStates, []);
  // ...and a bundle with no version at all is the oldest kind.
  assert.equal(planBake(world(), bundle({ version: undefined })).needed, true);
  // A current bundle that covers the world stays put.
  assert.equal(planBake(world(), bundle({ version: BAKE_FORMAT })).needed, false);
});
