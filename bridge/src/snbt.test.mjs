/**
 * Tests for the SNBT reader.
 *
 * Every string here is either a real reply captured from the live server or a shape the
 * format allows. The failure this guards is quiet: a parser that throws on one item's
 * components makes the whole inventory read as empty, and an empty inventory looks
 * exactly like an inventory that genuinely is empty.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksTruncated, parseDataGet, parseSnbt, RCON_REPLY_LIMIT } from './snbt.mjs';

test('parses the inventory reply captured from the live server', () => {
  const real = 'webviewer has the following entity data: '
    + '[{count: 64, Slot: 0b, id: "minecraft:stone"}, {count: 1, Slot: 1b, '
    + 'id: "minecraft:diamond_sword"}, {count: 32, Slot: 2b, id: "minecraft:oak_log"}]';
  assert.deepEqual(parseDataGet(real), [
    { count: 64, Slot: 0, id: 'minecraft:stone' },
    { count: 1, Slot: 1, id: 'minecraft:diamond_sword' },
    { count: 32, Slot: 2, id: 'minecraft:oak_log' },
  ]);
});

test('parses the scalar replies the state poll uses', () => {
  assert.equal(parseDataGet('webviewer has the following entity data: 20.0f'), 20);
  assert.equal(parseDataGet('webviewer has the following entity data: 20'), 20);
  assert.equal(parseDataGet('webviewer has the following entity data: 7'), 7);
  assert.deepEqual(
    parseDataGet('webviewer has the following entity data: [-480.0d, 65.0d, 64.0d]'),
    [-480, 65, 64],
  );
  assert.equal(
    parseDataGet('webviewer has the following entity data: "minecraft:overworld"'),
    'minecraft:overworld',
  );
});

test('parses a block reply, which is how container contents are read', () => {
  const real = '-480, 64, 64 has the following block data: '
    + '{x: -480, y: 64, Items: [], z: 64, id: "minecraft:barrel"}';
  assert.deepEqual(parseDataGet(real), {
    x: -480, y: 64, Items: [], z: 64, id: 'minecraft:barrel',
  });
});

test('every numeric suffix the format uses is dropped', () => {
  assert.deepEqual(parseSnbt('{b: 1b, s: 2s, l: 3L, f: 1.5f, d: 2.0d, i: 42}'), {
    b: 1, s: 2, l: 3, f: 1.5, d: 2, i: 42,
  });
  assert.deepEqual(parseSnbt('[-1.0E-4d, +5b, .5f]'), [-0.0001, 5, 0.5]);
});

test('typed arrays lose only their prefix', () => {
  assert.deepEqual(parseSnbt('[B; 1b, 2b, 3b]'), [1, 2, 3]);
  assert.deepEqual(parseSnbt('[I; 10, 20]'), [10, 20]);
  assert.deepEqual(parseSnbt('[L; 1L, 2L]'), [1, 2]);
});

test('handles quoting, escapes and booleans', () => {
  assert.deepEqual(parseSnbt('{a: "x\\"y", b: \'single\', c: true, d: false}'), {
    a: 'x"y', b: 'single', c: true, d: false,
  });
  // A quoted key, which modded components use freely.
  assert.deepEqual(parseSnbt('{"neoforge:attachments": {x: 1}}'), {
    'neoforge:attachments': { x: 1 },
  });
});

test('handles the nesting a modded item component tree actually has', () => {
  const s = '{count: 1, Slot: 0b, id: "create:wrench", components: '
    + '{"minecraft:custom_data": {foo: [{a: 1b}, {b: "two"}]}, "minecraft:damage": 3}}';
  const v = parseSnbt(s);
  assert.equal(v.components['minecraft:damage'], 3);
  assert.deepEqual(v.components['minecraft:custom_data'].foo, [{ a: 1 }, { b: 'two' }]);
});

test('empty compounds and lists', () => {
  assert.deepEqual(parseSnbt('{}'), {});
  assert.deepEqual(parseSnbt('[]'), []);
  assert.deepEqual(parseSnbt('{a: {}, b: []}'), { a: {}, b: [] });
});

test('unresolvable replies return null rather than throwing', () => {
  assert.equal(parseDataGet('No entity was found'), null);
  assert.equal(parseDataGet(''), null);
  assert.equal(parseDataGet(undefined), null);
  assert.equal(parseDataGet('webviewer has the following entity data: '), null);
});

test('a TRUNCATED reply parses to null, not to half an inventory', () => {
  // This is the important one. Vanilla RCON caps at 4096 bytes and cuts mid-token, so a
  // large inventory arrives as invalid SNBT. Half an inventory silently rendered as the
  // whole thing is worse than no inventory at all.
  const cut = 'webviewer has the following entity data: [{count: 64, Slot: 0b, id: "minecr';
  assert.equal(parseDataGet(cut), null);
  assert.equal(looksTruncated('x'.repeat(RCON_REPLY_LIMIT)), true);
  assert.equal(looksTruncated('x'.repeat(RCON_REPLY_LIMIT - 1)), false);
});

test('malformed input throws from parseSnbt but not from parseDataGet', () => {
  assert.throws(() => parseSnbt('{a: 1'), /SNBT/);
  assert.equal(parseDataGet('x has the following entity data: {a: 1'), null);
});
