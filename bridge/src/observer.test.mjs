/**
 * The observer's failure reporting.
 *
 * Everything here is about ONE property: a live view that has stopped working must not look
 * like a live view of a quiet server. That is the failure this codebase keeps paying for —
 * `.catch(() => {})` around the roster poll turned "RCON is broken" into "nobody moved",
 * and an unparseable `data get` turned "we could not read that player" into "that player
 * logged out". Both are plausible, both are wrong, and neither said anything.
 *
 * So each test drives a real `Observer` against a scripted RCON server and asserts on what
 * reaches the BROWSER, because that is where the lie would have landed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Observer } from './observer.mjs';

const TYPE_AUTH_RESPONSE = 2;
const TYPE_RESPONSE = 0;

function frame(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + payload.length);
  packet.writeInt32LE(10 + payload.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

/**
 * An RCON server that answers from a script.
 *
 * `reply(command)` returns the console text to send back, or the string `'DROP'` to close
 * the connection instead — which is how a poll is made to FAIL rather than to answer
 * something unhelpful.
 */
function scriptedServer(reply) {
  const commands = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (type === 3) {
          sock.write(frame(id, TYPE_AUTH_RESPONSE, ''));
          continue;
        }
        commands.push(body);
        const answer = reply(body);
        if (answer === 'DROP') sock.destroy();
        else sock.write(frame(id, TYPE_RESPONSE, answer));
      }
    });
  });
  return { server, commands };
}

/** Run one observer against a scripted server until `done(messages)` is satisfied. */
async function observe(reply, done, { timeoutMs = 4000 } = {}) {
  const { server, commands } = scriptedServer(reply);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const messages = [];
  const observer = new Observer(
    {
      host: '127.0.0.1',
      port,
      password: 'x',
      pollMs: 50,
      flushEnabled: false,
      fakePlayerEnabled: false,
      log: () => {},
    },
    (m) => messages.push(m),
  );
  try {
    await observer.start();
    observer.setClients(1);
    const deadline = Date.now() + timeoutMs;
    while (!done(messages) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return { messages, commands };
  } finally {
    observer.stop();
    await new Promise((r) => server.close(r));
  }
}

const listing = (...names) =>
  `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`;

const has = (messages, t) => messages.filter((m) => m.t === t);
const said = (messages, needle) =>
  messages.some((m) => typeof m.message === 'string' && m.message.includes(needle));

// ---------------------------------------------------------------------------

/**
 * THE ONE THIS FILE EXISTS FOR. `await this.#pollOnce().catch(() => {})` meant a failing
 * poll produced no log, no message and no change on screen: the browser went on drawing the
 * last roster it received, and a player frozen at a stale position is indistinguishable
 * from a player standing still.
 */
test('a roster poll that fails is reported to the browser, not swallowed', async () => {
  const { messages } = await observe(
    (cmd) => (cmd === 'list' ? 'DROP' : 'ok'),
    (m) => has(m, 'pollError').length > 0,
  );

  const errors = has(messages, 'pollError');
  assert.ok(errors.length, 'a failed poll has to say so');
  assert.equal(errors[0].scope, 'players');
  assert.ok(errors[0].failures >= 1);
  assert.match(String(errors[0].message), /rcon/i, 'and say what actually went wrong');
});

/**
 * A `data get` we cannot parse is not a departure. Returning null for it removes the player
 * from the roster, which on screen is exactly what logging out looks like — so the reply
 * that caused it is named instead.
 */
test('an unreadable Pos names the player and the reply, and does not draw them', async () => {
  const reply = (cmd) => {
    if (cmd === 'list') return listing('Ada');
    if (cmd.endsWith('Pos')) return 'Ada has the following entity data: <nonsense>';
    return 'Ada has the following entity data: "minecraft:overworld"';
  };
  const { messages } = await observe(reply, (m) => said(m, 'could not read Pos'));

  assert.ok(said(messages, 'could not read Pos for Ada'), 'the player is named');
  assert.ok(said(messages, 'nonsense'), 'and so is the reply that could not be read');
  const rosters = has(messages, 'players');
  assert.ok(rosters.length, 'the poll still completes for everybody else');
  assert.deepEqual(rosters.at(-1).list, [], 'but a player we cannot place is not sent');
});

/**
 * The one parse failure that is NOT a fault: the server saying the entity is gone, which is
 * what happens when somebody logs out between the `list` and the read that follows it. It
 * must stay quiet, or every logout produces an error report and the real ones get ignored.
 */
test('a player who left between list and read is not reported as a fault', async () => {
  const reply = (cmd) => (cmd === 'list' ? listing('Ada') : 'No entity was found');
  const { messages } = await observe(reply, (m) => has(m, 'players').length >= 2);

  assert.equal(said(messages, 'could not read'), false, 'a logout is not an error');
  assert.deepEqual(has(messages, 'players').at(-1).list, []);
});

/**
 * A dimension we could not read is a fact we do not have. It is passed on as null — the
 * browser refuses to draw such a player rather than assuming the dimension on screen — and
 * the failure is named here so the reason is in the log as well as on the HUD.
 */
test('an unreadable Dimension is reported and passed on as null, never guessed', async () => {
  const reply = (cmd) => {
    if (cmd === 'list') return listing('Ada');
    if (cmd.endsWith('Pos')) return 'Ada has the following entity data: [1.0d, 64.0d, 2.0d]';
    if (cmd.endsWith('Rotation')) return 'Ada has the following entity data: [90.0f, 0.0f]';
    return 'Ada has the following entity data: ???';
  };
  const { messages } = await observe(reply, (m) => said(m, 'could not read Dimension'));

  const roster = has(messages, 'players').at(-1);
  assert.equal(roster.list.length, 1, 'the player is still tracked');
  assert.equal(roster.list[0].dimension, null, 'with no dimension invented for them');
  assert.ok(said(messages, 'could not read Dimension for Ada'));
});

test('an ordinary poll emits the roster and reports nothing', async () => {
  const reply = (cmd) => {
    if (cmd === 'list') return listing('Ada');
    if (cmd.endsWith('Pos')) return 'Ada has the following entity data: [1.5d, 64.0d, -2.5d]';
    if (cmd.endsWith('Rotation')) return 'Ada has the following entity data: [90.0f, 3.0f]';
    return 'Ada has the following entity data: "minecraft:overworld"';
  };
  const { messages } = await observe(reply, (m) => has(m, 'players').length >= 2);

  assert.deepEqual(has(messages, 'players').at(-1).list, [{
    name: 'Ada',
    pos: [1.5, 64, -2.5],
    yaw: 90,
    pitch: 3,
    dimension: 'minecraft:overworld',
  }]);
  assert.equal(has(messages, 'pollError').length, 0);
  assert.equal(said(messages, 'could not read'), false);
});
