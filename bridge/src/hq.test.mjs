/**
 * The HQ label poll: choosing the line to show, parsing both endpoint shapes, and the
 * properties that keep a slow or absent brain from ever hurting the turtle stream.
 *
 * `fetch` is injected throughout, so these run with no network and no HQ — the point is
 * exactly what happens when HQ answers, answers slowly, errors, or is not there at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HqPoller, dronesOf, parseFleet, pickDetail } from './hq.mjs';

/** The reference `fleet.status` envelope, trimmed to the fields the label reads. */
const INVOKE = {
  ok: true,
  data: {
    drones: [
      { id: 57, name: 'D37', status: 'working', reported: 'mining', detail: 'searching 6 chest(s) for stone_bricks' },
      { id: 62, name: 'D38', status: 'hauling', reported: 'hauling', detail: 'build' },
      { id: 63, name: 'D39', status: 'stranded', reported: 'stuck', detail: null },
      { name: 'nameless', status: 'idle' }, // no id: cannot be joined, dropped
    ],
  },
};

test('pickDetail prefers the drone\'s own words, then the controller\'s, then status', () => {
  assert.equal(pickDetail({ detail: 'fetching wood', reported: 'mining', status: 'working' }), 'fetching wood');
  assert.equal(pickDetail({ reported: 'mining', status: 'working' }), 'mining');
  assert.equal(pickDetail({ doing: 'busy', status: 'working' }), 'busy');
  assert.equal(pickDetail({ status: 'idle' }), 'idle');
  assert.equal(pickDetail({ detail: '   ', status: 'idle' }), 'idle', 'blank is skipped');
  assert.equal(pickDetail({}), null);
});

test('the drone array is found in either endpoint envelope', () => {
  assert.equal(dronesOf(INVOKE).length, 4);
  assert.equal(dronesOf({ fleet: { drones: [{ id: 1 }] } }).length, 1);
  assert.equal(dronesOf({ drones: [{ id: 1 }, { id: 2 }] }).length, 2);
  assert.equal(dronesOf({}).length, 0);
  assert.equal(dronesOf('nope').length, 0);
});

test('parseFleet keys by id, keeps name and the chosen line, drops idless records', () => {
  const map = parseFleet(INVOKE);
  assert.equal(map.size, 3);
  assert.deepEqual(map.get(57), { name: 'D37', status: 'working', detail: 'searching 6 chest(s) for stone_bricks' });
  assert.deepEqual(map.get(63), { name: 'D39', status: 'stranded', detail: 'stuck' });
  assert.equal(map.has(undefined), false);
});

/**
 * A scripted `fetch`. Each step is one of: an Error (rejects), a response-shaped object
 * that carries its own `json()` (returned as-is, so a 502 stays a 502), or any other value
 * — including a `fleet.status` envelope, which also has an `ok` FIELD — returned as a 200
 * whose JSON body is that value.
 */
function stubFetch(sequence) {
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    if (step && typeof step.json === 'function') return step;
    return { ok: true, status: 200, json: async () => step };
  };
}

test('a good read fills the label map; labelFor folds name + line for the turtle row', async () => {
  const hq = new HqPoller({ fetch: stubFetch([INVOKE]), sleep: async () => {} });
  await hq.once();
  assert.equal(hq.available, true);
  assert.deepEqual(hq.labelFor(57), { name: 'D37', label: 'searching 6 chest(s) for stone_bricks' });
  assert.deepEqual(hq.labelFor(62), { name: 'D38', label: 'build' });
  assert.equal(hq.labelFor(999), null, 'an id HQ does not list has no label');
});

test('the last labels are RETAINED across a miss — a blip does not blank the tags', async () => {
  const hq = new HqPoller({
    fetch: stubFetch([INVOKE, new Error('ECONNREFUSED'), { ok: false, status: 502, json: async () => ({}) }]),
    sleep: async () => {},
  });
  await hq.once();                          // good
  assert.equal(hq.labelFor(57).label, 'searching 6 chest(s) for stone_bricks');
  await hq.once();                          // network error
  assert.equal(hq.labelFor(57).label, 'searching 6 chest(s) for stone_bricks', 'kept');
  await hq.once();                          // HTTP 502
  assert.equal(hq.labelFor(57).label, 'searching 6 chest(s) for stone_bricks', 'still kept');
  assert.equal(hq.failures, 2);
});

test('a slow brain is abandoned by the timeout, not waited on', async () => {
  // The stub honours the abort signal, so the timeout is what ends the call.
  const hq = new HqPoller({
    timeoutMs: 20,
    fetch: (_url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }),
    sleep: async () => {},
  });
  const t0 = Date.now();
  await hq.once();
  assert.ok(Date.now() - t0 < 500, 'returned promptly on timeout');
  assert.equal(hq.available, false);
  assert.equal(hq.labelFor(57), null);
});

test('the loop runs while asked, one call at a time, and a disabled poller does nothing', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const hq = new HqPoller({
    fetch: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); inFlight--;
      return { ok: true, status: 200, json: async () => INVOKE };
    },
    sleep: async () => {},
  });
  let ticks = 0;
  await hq.loop(() => ticks++ < 4);
  assert.equal(hq.polls, 4);
  assert.equal(maxInFlight, 1);

  const off = new HqPoller({ intervalMs: 0, fetch: async () => { throw new Error('should not be called'); } });
  assert.equal(off.enabled, false);
  await off.loop(() => true);
  assert.equal(off.polls, 0);
});

test('the interval is floored', () => {
  assert.equal(new HqPoller({ intervalMs: 100 }).intervalMs, 500);
});
