/**
 * Tests for the flush guard.
 *
 * These are the tests that matter most in this repo, because the thing they protect is
 * not a rendering artefact — it is a live server that a turtle fleet depends on, and that
 * fleet has already been destroyed once by a server that could not tick. Every safety
 * property in flush-timer.mjs's header has a test here, so "we forgot the floor" or "the
 * timer kept running after everyone left" fails in CI rather than in the world.
 *
 * Time is injected, so these run instantly and deterministically rather than sleeping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOOR_MS, MAX_MS, RECOVER_AFTER, FlushTimer, clampInterval } from './flush-timer.mjs';

/**
 * A fake clock. `schedule` records the pending callback instead of arming a real timer;
 * `advance()` runs it. Flush durations are scripted so each test can say exactly how
 * slow the server was pretending to be.
 */
function harness({ enabled = true, intervalMs = 5000, durations = [], fail = () => false } = {}) {
  let now = 0;
  let pending = null;
  let nextId = 1;
  const logs = [];
  let calls = 0;

  const timer = new FlushTimer({
    enabled,
    intervalMs,
    flush: async () => {
      const d = durations[Math.min(calls, durations.length - 1)] ?? 10;
      const failing = fail(calls);
      calls++;
      now += d;
      if (failing) throw new Error('rcon timeout');
    },
    log: (m) => logs.push(m),
    now: () => now,
    schedule: (fn, ms) => {
      pending = { fn, ms, id: nextId++ };
      return pending.id;
    },
    cancel: (id) => {
      if (pending?.id === id) pending = null;
    },
  });

  return {
    timer,
    logs,
    get calls() { return calls; },
    get pending() { return pending; },
    /** Fire the pending timer callback and let its async work settle. */
    async tick() {
      assert.ok(pending, 'expected a scheduled flush');
      const { fn } = pending;
      pending = null;
      fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('does nothing at all when not enabled, however many viewers connect', async () => {
  const h = harness({ enabled: false });
  h.timer.setClients(5);
  assert.equal(h.timer.running, false);
  assert.equal(h.pending, null);
  assert.equal(h.calls, 0);
});

test('zero viewers means zero flushes', async () => {
  const h = harness();
  h.timer.setClients(0);
  assert.equal(h.timer.running, false, 'must not arm with nobody watching');

  h.timer.setClients(1);
  assert.equal(h.timer.running, true);
  await h.tick();
  assert.equal(h.calls, 1);

  h.timer.setClients(0);
  assert.equal(h.timer.running, false, 'must disarm when the last viewer leaves');
  assert.equal(h.pending, null, 'no callback may survive the last disconnect');
});

test('the first flush is one interval AFTER connect, never immediate', () => {
  // A browser in a reconnect loop would otherwise become a flush loop.
  const h = harness({ intervalMs: 5000 });
  h.timer.setClients(1);
  assert.equal(h.calls, 0);
  assert.equal(h.pending.ms, 5000);
});

test('the 2s floor cannot be configured away', () => {
  assert.equal(clampInterval(500), FLOOR_MS);
  assert.equal(clampInterval(0), FLOOR_MS);
  assert.equal(clampInterval(-1), FLOOR_MS);
  assert.equal(clampInterval(NaN), 5000);
  assert.equal(clampInterval(1999), FLOOR_MS);
  assert.equal(clampInterval(2001), 2001);

  const h = harness({ intervalMs: 100 });
  assert.equal(h.timer.intervalMs, FLOOR_MS, 'a 100 ms request must become the floor');
});

test('one slow flush doubles the interval and says so', async () => {
  const h = harness({ intervalMs: 5000, durations: [50, 2500, 20] });
  h.timer.setClients(1);
  await h.tick();
  assert.equal(h.timer.intervalMs, 5000, 'a fast flush must not change the cadence');

  await h.tick(); // 2500 ms > slowMs (1000)
  assert.equal(h.timer.intervalMs, 10_000);
  assert.match(h.logs.join('\n'), /backing off 5000 ms -> 10000 ms/);
  assert.equal(h.pending.ms, 10_000, 'the new cadence must be what is actually rearmed');
});

test('a failed flush backs off too — a server that will not answer is a struggling one', async () => {
  const h = harness({ intervalMs: 5000, durations: [10], fail: (n) => n === 0 });
  h.timer.setClients(1);
  await h.tick();
  assert.equal(h.timer.intervalMs, 10_000);
  assert.match(h.logs.join('\n'), /flush failed: rcon timeout/);
});

test('back-off is bounded, and never stops flushing entirely', async () => {
  const h = harness({ intervalMs: 5000, durations: [9999] });
  h.timer.setClients(1);
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.timer.intervalMs, MAX_MS);
  assert.ok(h.timer.running, 'even fully backed off, the timer stays armed');
});

test('recovery needs a run of fast flushes, not just one', async () => {
  const durations = [2500, ...Array.from({ length: 20 }, () => 10)];
  const h = harness({ intervalMs: 5000, durations });
  h.timer.setClients(1);
  await h.tick(); // slow -> 10000
  assert.equal(h.timer.intervalMs, 10_000);

  for (let i = 0; i < RECOVER_AFTER - 1; i++) await h.tick();
  assert.equal(h.timer.intervalMs, 10_000, 'must not ease back on the first fast flush');

  await h.tick();
  assert.equal(h.timer.intervalMs, 5000);
  assert.match(h.logs.join('\n'), /easing back 10000 ms -> 5000 ms/);
});

test('recovery never overshoots below the configured base', async () => {
  const h = harness({ intervalMs: 3000, durations: Array.from({ length: 40 }, () => 5) });
  h.timer.setClients(1);
  for (let i = 0; i < 30; i++) await h.tick();
  assert.equal(h.timer.intervalMs, 3000);
});
