/**
 * Tests for chat parsing and the log tail.
 *
 * The line formats are real, copied from this server's own latest.log. The tail is tested
 * against a real file because the bugs in a tailer are all about partial reads and
 * rotation, which a mocked filesystem hides.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatLog, parseLogLine } from './chat-log.mjs';

const TS = '[31Aug2026 21:43:07.459] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]';

test('parses the bot saying something — the real captured line', () => {
  assert.deepEqual(
    parseLogLine(`${TS}: [Not Secure] [webviewer] hello from the viewer`),
    { kind: 'say', from: 'webviewer', text: 'hello from the viewer' },
  );
});

test('parses ordinary player chat, signed or not', () => {
  assert.deepEqual(parseLogLine(`${TS}: [Not Secure] <Powback> hey`),
    { kind: 'chat', from: 'Powback', text: 'hey' });
  assert.deepEqual(parseLogLine(`${TS}: <Powback> hey`),
    { kind: 'chat', from: 'Powback', text: 'hey' });
});

test('parses joins, leaves and deaths', () => {
  assert.deepEqual(parseLogLine(`${TS}: webviewer joined the game`),
    { kind: 'system', from: null, text: 'webviewer joined the game' });
  assert.deepEqual(parseLogLine(`${TS}: webviewer was slain by Zombie`),
    { kind: 'system', from: null, text: 'webviewer was slain by Zombie' });
  assert.deepEqual(parseLogLine(`${TS}: webviewer fell from a high place`),
    { kind: 'system', from: null, text: 'webviewer fell from a high place' });
});

test('ignores the mod noise that makes up most of the log', () => {
  assert.equal(parseLogLine(`${TS}: Thread RCON Client /192.168.192.4 started`), null);
  assert.equal(parseLogLine(`${TS}: [Rcon: Saved the game]`), null);
  assert.equal(parseLogLine(
    '[31Aug2026 21:33:34.069] [Server thread/INFO] [DistantHorizons.../]: Player [webviewer] joined.',
  ), null);
  assert.equal(parseLogLine(''), null);
  assert.equal(parseLogLine(undefined), null);
});

test('a mod logging the <name> shape is not chat', () => {
  // Captured for real: this reached the chat window as `<EMI> ...` before the logger was
  // checked. Anything not logged by MinecraftServer itself is not chat.
  const emi = "[31Aug2026 22:13:59.001] [Server thread/WARN] [EMI/]: [EMI] Can't send EMI"
    + " packet to FakePlayer['webviewer'/10928, l='ServerLevel[world]'] <x> y";
  assert.equal(parseLogLine(emi), null);
  const dh = '[31Aug2026 22:13:59.001] [Server thread/INFO] [DistantHorizons/]: <Bob> hi';
  assert.equal(parseLogLine(dh), null);
});

/** Wait for a predicate, so the tests do not race a 20 ms poll. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('tails a live file, and starts at the end rather than replaying history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcwv-chat-'));
  const path = join(dir, 'latest.log');
  writeFileSync(path, `${TS}: [Not Secure] <Old> history\n`);
  const got = [];
  const tail = new ChatLog(path, (m) => got.push(m), { pollMs: 20 });
  try {
    await tail.start();
    assert.equal(tail.available, true);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, [], 'backlog is not chat');

    appendFileSync(path, `${TS}: [Not Secure] <New> live one\n`);
    assert.ok(await until(() => got.length === 1));
    assert.equal(got[0].text, 'live one');
  } finally {
    tail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a line written in two pieces is not split into two messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcwv-chat-'));
  const path = join(dir, 'latest.log');
  writeFileSync(path, '');
  const got = [];
  const tail = new ChatLog(path, (m) => got.push(m), { pollMs: 20 });
  try {
    await tail.start();
    appendFileSync(path, `${TS}: [Not Secure] <A> half a mes`);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, [], 'a partial line must be held, not parsed');
    appendFileSync(path, 'sage\n');
    assert.ok(await until(() => got.length === 1));
    assert.equal(got[0].text, 'half a message');
  } finally {
    tail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('log rotation resets the offset instead of stalling forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcwv-chat-'));
  const path = join(dir, 'latest.log');
  writeFileSync(path, 'x'.repeat(5000));
  const got = [];
  const tail = new ChatLog(path, (m) => got.push(m), { pollMs: 20 });
  try {
    await tail.start();
    writeFileSync(path, `${TS}: [Not Secure] <A> after rotation\n`);   // now much shorter
    assert.ok(await until(() => got.length === 1), 'a shrunk file must re-seek to 0');
    assert.equal(got[0].text, 'after rotation');
  } finally {
    tail.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing log file disables chat rather than crashing the bridge', async () => {
  const tail = new ChatLog('/nonexistent/latest.log', () => {}, { pollMs: 20 });
  await tail.start();
  assert.equal(tail.available, false);
  tail.stop();
});
