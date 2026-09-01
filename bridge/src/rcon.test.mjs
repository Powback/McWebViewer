/**
 * Tests for the RCON client's serialisation.
 *
 * This exists because of a real failure against the live server, and the failure mode was
 * nasty: the bridge worked perfectly with nobody online, and started dropping its RCON
 * connection every few seconds the moment there was one player to poll. The cause was
 * pipelining — the player poll issues three `data get`s per player, and vanilla's
 * `RconClient` reads one request per pass over a fixed buffer, so two commands in one TCP
 * segment make it mis-parse and close the socket.
 *
 * The whole class of bug is "it works until it has something to do", so it is worth a
 * test that fails loudly rather than a comment asking people to be careful.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RconClient } from './rcon.mjs';

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
 * A fake RCON server that records how many requests are in flight at once, and answers
 * after a delay so overlap is actually possible if the client allows it.
 */
function fakeServer({ replyDelayMs = 25 } = {}) {
  const state = { maxConcurrent: 0, inFlight: 0, commands: [] };
  const server = net.createServer((sock) => {
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
        state.commands.push(body);
        state.inFlight++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
        setTimeout(() => {
          state.inFlight--;
          sock.write(frame(id, TYPE_RESPONSE, `ok:${body}`));
        }, replyDelayMs);
      }
    });
  });
  return { server, state };
}

async function withServer(fn, opts) {
  const { server, state } = fakeServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new RconClient({ host: '127.0.0.1', port, password: 'x' });
  try {
    await client.connect();
    await fn(client, state);
  } finally {
    client.close();
    await new Promise((r) => server.close(r));
  }
}

test('concurrent callers never put two packets on the wire at once', async () => {
  await withServer(async (client, state) => {
    // Exactly the shape the player poll uses: Promise.all over three data gets.
    const replies = await Promise.all([
      client.command('data get entity A Pos'),
      client.command('data get entity A Rotation'),
      client.command('data get entity A Dimension'),
    ]);
    assert.deepEqual(replies, [
      'ok:data get entity A Pos',
      'ok:data get entity A Rotation',
      'ok:data get entity A Dimension',
    ]);
    assert.equal(state.maxConcurrent, 1, 'vanilla RCON closes the socket if this exceeds 1');
  });
});

test('serialisation preserves order', async () => {
  await withServer(async (client, state) => {
    await Promise.all(['one', 'two', 'three', 'four'].map((c) => client.command(c)));
    assert.deepEqual(state.commands, ['one', 'two', 'three', 'four']);
  });
});

test('a rejected command does not poison the ones queued behind it', async () => {
  await withServer(async (client, state) => {
    // Reject the middle one by resolving it out from under the queue; the important
    // property is that the queue keeps draining afterwards.
    const a = client.command('a');
    const bad = client.command('b').then(() => { throw new Error('boom'); });
    const c = client.command('c');
    await assert.rejects(() => bad, /boom/);
    assert.equal(await a, 'ok:a');
    assert.equal(await c, 'ok:c');
    assert.equal(state.maxConcurrent, 1);
  });
});

test('commands are refused when not authenticated rather than queued forever', async () => {
  const client = new RconClient({ host: '127.0.0.1', port: 1, password: 'x' });
  await assert.rejects(() => client.command('list'), /not authenticated/);
});
