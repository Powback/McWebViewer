/**
 * The browser's side of the roster message.
 *
 * `readPlayers` is the last gate between the wire and a three.js transform, and it has two
 * jobs that pull in opposite directions. It must never let a NaN through — three responds
 * to a NaN position by dropping the whole mesh, which looks exactly like "the feature does
 * not work" — and it must never drop a record without saying so, because a player that
 * quietly disappears is indistinguishable from one who logged out.
 *
 * So it returns the count as well as the players, and the caller puts it on screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readComputers, readPlayers } from './live.js';

const ok = { name: 'Ada', pos: [1.5, 64, -2.5], yaw: 90, pitch: 3, dimension: 'minecraft:overworld' };

test('a well-formed roster comes through unchanged', () => {
  const { players, rejected } = readPlayers([ok]);

  assert.equal(rejected, 0);
  assert.deepEqual(players, [{
    name: 'Ada', pos: [1.5, 64, -2.5], yaw: 90, pitch: 3, dimension: 'minecraft:overworld',
  }]);
});

test('a record that cannot be drawn is dropped AND counted', () => {
  const { players, rejected } = readPlayers([
    ok,
    { ...ok, name: 'Bad', pos: [1, 'x', 3] },        // not three finite numbers
    { ...ok, name: 'Short', pos: [1, 2] },           // not three of anything
    { ...ok, name: 42 },                             // not a name
    { ...ok, name: 'NaN', pos: [1, Number.NaN, 3] }, // the one that silently kills a mesh
  ]);

  assert.deepEqual(players.map((p) => p.name), ['Ada']);
  assert.equal(rejected, 4, 'every drop has to be countable, or none of them are reportable');
});

/**
 * A dimension the bridge could not read arrives as null and stays null.
 *
 * Defaulting it to the dimension on screen is the plausible-looking substitution this
 * project keeps paying for: it would draw a nether player standing in the overworld, at
 * coordinates that are wrong by a factor of eight, with nothing anywhere saying so.
 */
test('an unreadable dimension stays null rather than becoming the one on screen', () => {
  const { players, rejected } = readPlayers([{ ...ok, dimension: null }]);

  assert.equal(rejected, 0, 'the player is still usable — we just do not know where');
  assert.equal(players[0].dimension, null);
});

test('a message that is not a list at all yields nothing and claims nothing', () => {
  assert.deepEqual(readPlayers(undefined), { players: [], rejected: 0 });
  assert.deepEqual(readPlayers('everyone'), { players: [], rejected: 0 });
});

/**
 * `readComputers` is the turtle equivalent, with one addition: the HQ activity fields.
 * A block position must be integers (a turtle occupies a whole block); the label fields
 * are additive and only carried when they are non-empty strings.
 */
test('a computer row keeps integer positions and carries HQ name/label when present', () => {
  const { computers, rejected } = readComputers([
    { id: 57, on: true, x: -466, y: 63, z: 30, name: 'D37', label: 'fetching wood' },
    { id: 62, on: false, x: -480, y: 64, z: 75 },          // no HQ data — still drawn
    { id: 63, on: true, x: -1, y: 2, z: 3, name: '', label: '' }, // empty strings dropped
  ]);
  assert.equal(rejected, 0);
  assert.deepEqual(computers[0], { id: 57, on: true, pos: [-466, 63, 30], name: 'D37', label: 'fetching wood' });
  assert.deepEqual(computers[1], { id: 62, on: false, pos: [-480, 64, 75] });
  assert.deepEqual(computers[2], { id: 63, on: true, pos: [-1, 2, 3] }, 'blank name/label are not carried');
});

test('a computer at a non-integer or missing block is dropped and counted', () => {
  const { computers, rejected } = readComputers([
    { id: 1, on: true, x: 0.5, y: 64, z: 0 },   // fractional — not a block
    { id: 2, on: true, x: 1, z: 3 },            // no y
    { on: true, x: 1, y: 2, z: 3 },             // no id
    { id: 5, on: true, x: 1, y: 2, z: 3 },      // good
  ]);
  assert.deepEqual(computers.map((c) => c.id), [5]);
  assert.equal(rejected, 3);
  assert.deepEqual(readComputers(undefined), { computers: [], rejected: 0 });
});
