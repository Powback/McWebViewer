/**
 * What ends up in each hand.
 *
 * The whole reason this is a separate function: `Inventory` is ONE list keyed by slot, with
 * the hotbar, armour and off hand all in it, so telling the off hand apart is a slot-number
 * question — and getting it wrong shows a confidently wrong item rather than nothing.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { handsFrom, isBlockItem, type Stack } from './held-item.js';
import type { StateSource } from './mesher.js';

const stacks: Stack[] = [
  { slot: 0, id: 'minecraft:stone', count: 64 },
  { slot: 2, id: 'minecraft:diamond_pickaxe', count: 1 },
  { slot: 40, id: 'minecraft:shield', count: 1 },
];

test('the selected hotbar slot is the main hand', () => {
  assert.equal(handsFrom(stacks, 0, 40).main, 'minecraft:stone');
  assert.equal(handsFrom(stacks, 2, 40).main, 'minecraft:diamond_pickaxe');
});

test('slot 40 is the off hand — the number the harness extracted', () => {
  assert.equal(handsFrom(stacks, 0, 40).off, 'minecraft:shield');
});

test('an empty selected slot means an empty hand, not the previous item', () => {
  assert.equal(handsFrom(stacks, 5, 40).main, null);
});

test('without the extracted slot number the off hand is EMPTY, never guessed', () => {
  // A wrong slot would show the wrong item as if it were fact. Nothing is the honest answer.
  assert.equal(handsFrom(stacks, 0, undefined).off, null);
});

test('a zero-count stack is not held', () => {
  const odd: Stack[] = [{ slot: 0, id: 'minecraft:stone', count: 0 }];
  assert.equal(handsFrom(odd, 0, 40).main, null);
});

test('slot 40 is what the real extraction produced', { skip: existsSync('public/physics.json') ? false : 'no physics.json' }, () => {
  const p = JSON.parse(readFileSync('public/physics.json', 'utf8')) as { player: { offhandSlot?: number } };
  assert.equal(p.player.offhandSlot, 40,
    'Inventory.SLOT_OFFHAND changed; the off hand would be read from the wrong slot');
});

test('a block is meshed, an item is not — asked of the REGISTRY, not the name', () => {
  // `create:shaft` is both a block id and an item id; only the registry can tell.
  const states = {
    resolve: (key: string) => ({ quads: key === 'minecraft:stone' ? [{}] : [] }),
  } as unknown as StateSource;
  assert.equal(isBlockItem('minecraft:stone', states), true);
  assert.equal(isBlockItem('minecraft:stick', states), false);
  assert.equal(isBlockItem('minecraft:stone', null), false);
});
