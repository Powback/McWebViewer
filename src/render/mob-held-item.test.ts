/**
 * The item in a mob's hand.
 *
 * Measured before building: 30 of the live world's 801 entities carry one — 23 skeletons
 * with bows, 4 zombified piglins with golden swords, 3 pillagers with crossbows, all in the
 * main hand. All three mobs have a `right_arm` part and all three items have baked icons.
 *
 * The interesting half is the hand position, which is derived from the model rather than
 * written down, so a modded humanoid with a differently-placed arm still gets it right.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  armPartOf, handOffset, heldItemPosition, heldItemsOf,
} from './mob-held-item.js';

const HUMANOID = {
  right_arm: { pos: [-5, 2, 0] as [number, number, number] },
  left_arm: { pos: [5, 2, 0] as [number, number, number] },
  head: { pos: [0, 24, 0] as [number, number, number] },
};

// ---------------------------------------------------------------------------
// Reading the NBT

test('a main-hand item is read from HandItems slot 0', () => {
  const held = heldItemsOf({ HandItems: [{ id: 'minecraft:bow', count: 1 }, {}] });
  assert.deepEqual(held, [{ id: 'minecraft:bow', slot: 0 }]);
});

test('both hands are read, in vanilla order', () => {
  const held = heldItemsOf({
    HandItems: [{ id: 'minecraft:golden_sword' }, { id: 'minecraft:shield' }],
  });
  assert.deepEqual(held.map((h) => [h.slot, h.id]), [
    [0, 'minecraft:golden_sword'], [1, 'minecraft:shield'],
  ]);
});

test('empty hands, a missing array and junk all yield nothing', () => {
  assert.deepEqual(heldItemsOf({ HandItems: [{}, {}] }), []);
  assert.deepEqual(heldItemsOf({}), []);
  assert.deepEqual(heldItemsOf({ HandItems: 'nonsense' }), []);
  assert.deepEqual(heldItemsOf({ HandItems: [{ count: 1 }] }), [], 'a stack with no id is not an item');
});

// ---------------------------------------------------------------------------
// Where the hand is

// The number that proves the chain: a vanilla shoulder is at y=1.375 and an arm is 0.625
// long, so the hand is at 0.75. Getting the root flip or the rotation order wrong moves it.
test('the vanilla humanoid hand lands an arm-length below the shoulder', () => {
  const off = handOffset(armPartOf(HUMANOID, 'right'), 'right');
  assert.ok(off);
  const [x, y, z] = off;
  assert.ok(Math.abs(x - 0.375) < 1e-9, `x ${x}`);
  assert.ok(Math.abs(y - 0.75) < 1e-9, `y ${y} — the shoulder is at 1.375`);
  assert.ok(Math.abs(z - -0.125) < 1e-9, `z ${z}`);
});

test('the left hand mirrors the right across the body', () => {
  const r = handOffset(armPartOf(HUMANOID, 'right'), 'right')!;
  const l = handOffset(armPartOf(HUMANOID, 'left'), 'left')!;
  assert.ok(Math.abs(r[0] + l[0]) < 1e-9, 'mirrored in x');
  assert.equal(r[1], l[1], 'at the same height');
  assert.equal(r[2], l[2], 'and the same depth');
});

// This is the part that makes it generic rather than a table of vanilla numbers.
test('a model whose arm sits elsewhere puts the item elsewhere', () => {
  const tall = { right_arm: { pos: [-7, 10, 1] as [number, number, number] } };
  const a = handOffset(armPartOf(HUMANOID, 'right'), 'right')!;
  const b = handOffset(armPartOf(tall, 'right'), 'right')!;
  assert.notDeepEqual(a, b);
  assert.ok(Math.abs(b[0] - (a[0] + 2 / 16)) < 1e-9, 'two pixels further out');
  assert.ok(Math.abs(b[1] - (a[1] - 8 / 16)) < 1e-9, 'eight pixels higher on the model');
});

// A spider has no arms, and vanilla draws it holding nothing.
test('a model with no arm holds nothing', () => {
  assert.equal(armPartOf({ body: { pos: [0, 0, 0] } }, 'right'), undefined);
  assert.equal(handOffset(undefined, 'right'), null);
  assert.equal(handOffset(armPartOf(undefined, 'right'), 'right'), null);
});

// ---------------------------------------------------------------------------
// Turning with the mob

test('the item turns with the mob instead of staying on one side of the world', () => {
  const off: [number, number, number] = [0.375, 0.75, -0.125];
  const at0 = heldItemPosition([10, 64, 10], 0, off);
  const at180 = heldItemPosition([10, 64, 10], 180, off);
  assert.ok(Math.abs(at0[0] - 10.375) < 1e-9, 'facing 0, the hand is at +x');
  assert.ok(Math.abs(at180[0] - 9.625) < 1e-9, 'turned around, it is at -x');
  assert.equal(at0[1], at180[1], 'and never changes height');
});

test('a quarter turn swaps the x and z offsets, as a Y rotation must', () => {
  const p = heldItemPosition([0, 0, 0], 90, [1, 0, 0]);
  assert.ok(Math.abs(p[0]) < 1e-9, `x ${p[0]}`);
  assert.ok(Math.abs(p[2] - -1) < 1e-9, `z ${p[2]}`);
});

test('the offset is applied relative to the mob, wherever it stands', () => {
  const off: [number, number, number] = [0.375, 0.75, -0.125];
  const a = heldItemPosition([0, 0, 0], 37, off);
  const b = heldItemPosition([100, -20, 3], 37, off);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs((b[i] - a[i]) - [100, -20, 3][i]) < 1e-9, `axis ${i} should just translate`);
  }
});

test('the height offset is never rotated away', () => {
  for (const yaw of [0, 45, 90, 137, 180, 270, 359]) {
    const p = heldItemPosition([0, 64, 0], yaw, [0.375, 0.75, -0.125]);
    assert.ok(Math.abs(p[1] - 64.75) < 1e-9, `yaw ${yaw} moved the item vertically`);
  }
});
