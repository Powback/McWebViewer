/**
 * Native players and computers, and the source toggle.
 *
 * The rule being enforced: in spacetime mode nothing may come from the bridge. Anything the
 * module cannot serve must be VISIBLY absent, never silently backfilled — a mode selector
 * that quietly keeps the old feeds running is worse than no selector, because it looks like
 * it worked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toPlayer, toComputer, type PlayerRow, type BlockEntityRow } from './spacetime-native.js';
import { otherSource, urlForSource, toggleLabel } from './source-toggle.js';
import { resolveSource } from './world-source.js';

// ---------------------------------------------------------------------------
// Players.

function playerRow(over: Partial<PlayerRow> = {}): PlayerRow {
  return { uuid: 'u', name: 'Steve', online: true, x: 1.5, y: 64, z: -2.5, yaw: 90, pitch: 10, ...over };
}

test('an online player becomes the same roster shape the bridge produced', () => {
  const p = toPlayer(playerRow(), 'minecraft:overworld');
  assert.ok(p);
  assert.equal(p.name, 'Steve');
  assert.deepEqual(p.pos, [1.5, 64, -2.5]);
  assert.equal(p.yaw, 90);
  assert.equal(p.dimension, 'minecraft:overworld');
});

test('an OFFLINE player is not drawn — the row outlives the logout', () => {
  // The module keeps the row so a name still resolves; drawing it leaves a body standing
  // where someone logged out.
  assert.equal(toPlayer(playerRow({ online: false }), 'minecraft:overworld'), null);
});

test('a non-finite position is refused, as it is on every other path', () => {
  assert.equal(toPlayer(playerRow({ x: NaN }), null), null);
  assert.equal(toPlayer(playerRow({ name: '' }), null), null);
});

test('the dimension is carried through rather than assumed to be the overworld', () => {
  // The `player` table has no dimension; it comes from `bot_status`. Defaulting to overworld
  // would draw every player in the wrong world the moment the bot went to the Nether.
  assert.equal(toPlayer(playerRow(), 'minecraft:the_nether')!.dimension, 'minecraft:the_nether');
  assert.equal(toPlayer(playerRow(), null)!.dimension, null);
});

// ---------------------------------------------------------------------------
// Computers, from block entities.

function beRow(over: Partial<BlockEntityRow> = {}): BlockEntityRow {
  return { x: 10, y: 64, z: -3, typeName: 'computercraft:turtle_normal', computerId: 37, ...over };
}

test('a block entity carrying a computer id becomes a computer', () => {
  const c = toComputer(beRow({ label: 'D37', on: true }));
  assert.ok(c);
  assert.equal(c.id, 37);
  assert.equal(c.on, true);
  assert.deepEqual(c.pos, [10, 64, -3]);
  assert.equal(c.label, 'D37');
});

test('an ordinary block entity is NOT a computer', () => {
  assert.equal(toComputer(beRow({ typeName: 'minecraft:chest', computerId: null })), null);
  assert.equal(toComputer(beRow({ computerId: undefined })), null);
});

test('the test is the computer id, not the block name — so a modded computer works too', () => {
  // Same structural rule the save-file path uses. A mod that adds its own computer block is
  // picked up without ever being named in this codebase.
  const c = toComputer(beRow({ typeName: 'somemod:fancy_turtle', computerId: 5 }));
  assert.ok(c);
  assert.equal(c.id, 5);
});

test('computer id 0 is a real computer, not a falsy miss', () => {
  // The classic bug in this shape: `if (!id)` drops computer 0.
  const c = toComputer(beRow({ computerId: 0 }));
  assert.ok(c, 'computer 0 was dropped');
  assert.equal(c.id, 0);
});

test('a non-integer block position is refused rather than placed somewhere plausible', () => {
  assert.equal(toComputer(beRow({ x: 1.5 })), null);
});

test('an empty label is omitted, not rendered as an empty name tag', () => {
  assert.equal(toComputer(beRow({ label: '' }))!.label, undefined);
});

// ---------------------------------------------------------------------------
// The toggle.

test('the toggle targets the other source', () => {
  assert.equal(otherSource('bridge'), 'spacetime');
  assert.equal(otherSource('spacetime'), 'bridge');
});

test('switching preserves every other URL parameter', () => {
  // Losing `?auto=1` or a chosen shaderpack would make the toggle feel like a page reset.
  const got = urlForSource('http://host/?auto=1&shader=sildurs&source=bridge', 'spacetime');
  const u = new URL(got);
  assert.equal(u.searchParams.get('source'), 'spacetime');
  assert.equal(u.searchParams.get('auto'), '1');
  assert.equal(u.searchParams.get('shader'), 'sildurs');
});

test('switching adds the parameter when the URL had none', () => {
  const u = new URL(urlForSource('http://host/', 'spacetime'));
  assert.equal(u.searchParams.get('source'), 'spacetime');
});

test('the URL the toggle writes is what the resolver then reads — they compose', () => {
  // The toggle deliberately writes the TOP of the existing precedence chain rather than
  // adding a fourth rule. This checks the two halves actually agree.
  const href = urlForSource('http://host/?source=bridge', 'spacetime');
  const search = new URL(href).search;
  const resolved = resolveSource(search, { source: 'bridge' });
  assert.equal(resolved.kind, 'spacetime');
  assert.equal(resolved.origin, 'url', 'the toggle must win over the deployed config');
});

test('the label names the current source and the button explains the reload', () => {
  const { label, title } = toggleLabel(resolveSource('?source=spacetime', null));
  assert.match(label, /spacetime/);
  assert.match(title, /reload/i, 'the button must say the switch reloads, not pretend it is free');
});

test('before the source resolves the toggle says so rather than guessing', () => {
  const { label } = toggleLabel(null);
  assert.doesNotMatch(label, /bridge|spacetime/,
    'an unresolved source must not display as either one');
});
