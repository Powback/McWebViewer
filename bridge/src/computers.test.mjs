/**
 * The `computercraft dump` poll: parsing the real console table, and the guard rails.
 *
 * The parse is tested against the bytes the reference server actually returns (ANSI resets
 * and all), because RCON hands back console text and console text is not a protocol. The
 * poller is tested with a fake command runner and an instant sleep, so the properties that
 * protect the server — floor, no overlap, latch-off on an unknown command, failures reported
 * not swallowed — are asserted rather than hoped for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TURTLE_FLOOR_MS, TurtlePoller, isUnknownCommand, parseComputerDump,
} from './computers.mjs';

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/** Verbatim shape of the reference server's reply, ANSI resets included. */
const DUMP = [
  'Computer | On | Position',
  `${RESET}==============================`,
  `${RESET}#62      | Y  | -480, 64, 75`,
  `${RESET}#47      | Y  | -478, 64, 75`,
  `${RESET}#55      | N  | -440, 114, 25`,
  `${RESET}#37      | Y  | -458, 81, -2`,
  `${RESET}`,
].join('\n');

test('parses the real table: ids, on-flag, negative coordinates, resets stripped', () => {
  const { computers, skipped } = parseComputerDump(DUMP);
  assert.deepEqual(computers, [
    { id: 62, on: true, x: -480, y: 64, z: 75 },
    { id: 47, on: true, x: -478, y: 64, z: 75 },
    { id: 55, on: false, x: -440, y: 114, z: 25 },
    { id: 37, on: true, x: -458, y: 81, z: -2 },
  ]);
  assert.equal(skipped, 0);
});

test('a row it does not understand is counted, never guessed at', () => {
  const { computers, skipped } = parseComputerDump(
    `${DUMP}\n#99      | Y  | (no position)\nsomething else entirely`,
  );
  assert.equal(computers.length, 4);
  assert.equal(skipped, 2);
});

test('non-text and empty replies parse to nothing', () => {
  assert.deepEqual(parseComputerDump(undefined), { computers: [], skipped: 0 });
  assert.deepEqual(parseComputerDump(''), { computers: [], skipped: 0 });
  assert.deepEqual(parseComputerDump('Computer | On | Position\n====='), { computers: [], skipped: 0 });
});

test('the server saying it has no such command is recognised', () => {
  assert.equal(isUnknownCommand('Unknown or incomplete command, see below for error'), true);
  assert.equal(isUnknownCommand(DUMP), false);
});

function harness({ replies, intervalMs = 1000 }) {
  const emitted = [];
  const logged = [];
  const commands = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const poller = new TurtlePoller({
    intervalMs,
    run: async (cmd) => {
      commands.push(cmd);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next ?? DUMP;
    },
    emit: (m) => emitted.push(m),
    log: (m) => logged.push(m),
    sleep: async () => {},
  });
  return { poller, emitted, logged, commands, maxInFlight: () => maxInFlight };
}

test('the interval is floored, and 0 disables', () => {
  assert.equal(new TurtlePoller({ intervalMs: 100, run: async () => '', emit: () => {} }).intervalMs, TURTLE_FLOOR_MS);
  const off = new TurtlePoller({ intervalMs: 0, run: async () => '', emit: () => {} });
  assert.equal(off.enabled, false);
  assert.equal(off.available, false);
});

test('one poll issues exactly one command and broadcasts the roster', async () => {
  const h = harness({ replies: [DUMP] });
  await h.poller.once();
  assert.deepEqual(h.commands, ['computercraft dump']);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].t, 'turtles');
  assert.equal(h.emitted[0].list.length, 4);
  assert.equal(h.poller.available, true);
  assert.equal(h.poller.count, 4);
});

test('the loop runs only while asked, one poll at a time, and a second loop() is a no-op', async () => {
  const h = harness({ replies: [] });
  let ticks = 0;
  const shouldRun = () => ticks++ < 5;
  const a = h.poller.loop(shouldRun);
  const b = h.poller.loop(shouldRun);
  await Promise.all([a, b]);
  assert.equal(h.commands.length, 5);
  assert.equal(h.maxInFlight(), 1, 'never two dumps in flight');
  assert.equal(h.poller.running, false);
});

test('an unknown command latches the poller OFF and says so once', async () => {
  const h = harness({ replies: ['Unknown or incomplete command, see below for error\n...<--[HERE]'] });
  let ticks = 0;
  await h.poller.loop(() => ticks++ < 50);
  assert.equal(h.commands.length, 1, 'stopped asking after the first refusal');
  assert.equal(h.poller.available, false);
  assert.match(h.poller.reason, /does not know 'computercraft dump'/);
  assert.equal(h.emitted.filter((m) => m.t === 'status').length, 1);
  // And it stays off: a later loop() does nothing.
  await h.poller.loop(() => true);
  assert.equal(h.commands.length, 1);
});

test('failures are reported on the first and every tenth, and recovery is announced', async () => {
  const replies = Array.from({ length: 12 }, () => new Error('rcon timeout'));
  replies.push(DUMP);
  const h = harness({ replies });
  for (let i = 0; i < 13; i++) await h.poller.once();
  const errors = h.emitted.filter((m) => m.t === 'pollError');
  assert.deepEqual(errors.map((m) => m.failures), [1, 10]);
  assert.equal(errors[0].scope, 'turtle');
  assert.equal(h.logged.filter((l) => /FAILED/.test(l)).length, 12, 'every failure is logged');
  assert.equal(h.poller.failures, 0);
  assert.ok(h.emitted.some((m) => m.t === 'status' && /recovered after 12/.test(m.message)));
  assert.equal(h.emitted.at(-1).t, 'turtles');
});

test('a reply with rows we cannot read at all is a failure, not an empty fleet', async () => {
  const h = harness({ replies: ['garbage\nmore garbage'] });
  await h.poller.once();
  assert.equal(h.emitted.filter((m) => m.t === 'turtles').length, 0);
  assert.equal(h.poller.failures, 1);
});

test('HQ labels are folded into each row, and left off when HQ has none', async () => {
  const emitted = [];
  const poller = new TurtlePoller({
    intervalMs: 1000,
    run: async () => DUMP,
    emit: (m) => emitted.push(m),
    // #62 has a name and a line; #47 has a name only; #55 and #37 are unknown to HQ.
    labelFor: (id) => ({
      62: { name: 'D38', label: 'building' },
      47: { name: 'D4', label: null },
    })[id] ?? null,
    sleep: async () => {},
  });
  await poller.once();
  const rows = emitted[0].list;
  assert.deepEqual(rows.find((r) => r.id === 62), { id: 62, on: true, x: -480, y: 64, z: 75, name: 'D38', label: 'building' });
  assert.deepEqual(rows.find((r) => r.id === 47), { id: 47, on: true, x: -478, y: 64, z: 75, name: 'D4' });
  assert.deepEqual(rows.find((r) => r.id === 55), { id: 55, on: false, x: -440, y: 114, z: 25 });
});
