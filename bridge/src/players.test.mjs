/**
 * Tests for the console-output parsers.
 *
 * RCON returns the text a human would read, so these formats are the closest thing the
 * live tier has to a wire protocol — and the failure mode of getting one subtly wrong is
 * a player drawn at NaN, which in three.js quietly removes the whole mesh rather than
 * erroring. Pinning the real strings down is cheaper than debugging that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPlayerName, parseDimension, parsePlayerList, parsePos, parseRotation,
} from './players.mjs';

test('parsePlayerList reads the vanilla `list` reply', () => {
  assert.deepEqual(
    parsePlayerList('There are 2 of a max of 20 players online: Alice, Bob'),
    ['Alice', 'Bob'],
  );
  assert.deepEqual(
    parsePlayerList('There are 1 of a max of 20 players online: Notch_99'),
    ['Notch_99'],
  );
});

test('parsePlayerList returns nothing for an empty server', () => {
  // The real reply keeps the colon and a trailing space; the empty tail must not
  // become a one-element list containing ''.
  assert.deepEqual(parsePlayerList('There are 0 of a max of 20 players online: '), []);
  assert.deepEqual(parsePlayerList('There are 0 of a max of 20 players online:'), []);
});

test('parsePlayerList survives output it does not recognise', () => {
  assert.deepEqual(parsePlayerList(''), []);
  assert.deepEqual(parsePlayerList('Unknown or incomplete command'), []);
  assert.deepEqual(parsePlayerList(undefined), []);
  assert.deepEqual(parsePlayerList(null), []);
});

test('parsePlayerList drops anything that is not a legal username', () => {
  // Names are interpolated straight into the next command, so this is a security
  // boundary, not tidiness: a name is attacker-controlled on any open server.
  // 'Bob\nsay pwned' would become a second command line if it reached `data get entity
  // <name> Pos`. It is dropped; the legitimate name beside it still comes through.
  const hostile = 'There are 3 of a max of 20 players online: Alice, Bob\nsay pwned, C@rl';
  assert.deepEqual(parsePlayerList(hostile), ['Alice']);
  assert.equal(isValidPlayerName('Alice'), true);
  assert.equal(isValidPlayerName('a'.repeat(17)), false);
  assert.equal(isValidPlayerName('Bob Smith'), false);
  assert.equal(isValidPlayerName('run say hi'), false);
  assert.equal(isValidPlayerName(''), false);
  assert.equal(isValidPlayerName(undefined), false);
});

test('parsePos reads the doubles out of a Pos tag', () => {
  assert.deepEqual(
    parsePos('Alice has the following entity data: [12.5d, 64.0d, -3.2d]'),
    [12.5, 64, -3.2],
  );
  // Whole numbers come back without a decimal point on some paths.
  assert.deepEqual(parsePos('X has the following entity data: [0d, 70d, 0d]'), [0, 70, 0]);
});

test('parsePos refuses anything that is not three finite numbers', () => {
  assert.equal(parsePos('No entity was found'), null);
  assert.equal(parsePos('X has the following entity data: [1.0d, 2.0d]'), null);
  assert.equal(parsePos('X has the following entity data: [1.0d, 2.0d, 3.0d, 4.0d]'), null);
  assert.equal(parsePos('X has the following entity data: [a, b, c]'), null);
  assert.equal(parsePos(''), null);
  assert.equal(parsePos(undefined), null);
});

test('parseRotation reads yaw and pitch as degrees', () => {
  assert.deepEqual(
    parseRotation('Alice has the following entity data: [90.0f, 0.5f]'),
    { yaw: 90, pitch: 0.5 },
  );
  assert.deepEqual(
    parseRotation('Alice has the following entity data: [-179.25f, -12.0f]'),
    { yaw: -179.25, pitch: -12 },
  );
  assert.equal(parseRotation('No entity was found'), null);
});

test('parseDimension pulls the resource location out of the quoted string', () => {
  assert.equal(
    parseDimension('Alice has the following entity data: "minecraft:overworld"'),
    'minecraft:overworld',
  );
  assert.equal(
    parseDimension('Alice has the following entity data: "minecraft:the_nether"'),
    'minecraft:the_nether',
  );
  assert.equal(parseDimension('No entity was found'), null);
  assert.equal(parseDimension(undefined), null);
});
