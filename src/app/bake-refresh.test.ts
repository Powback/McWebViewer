/**
 * The bake-refresh poll policy, driven by a fake clock.
 *
 * What is being pinned down: a page that never polls while it has nothing missing, one
 * that does not hammer the server when the missing thing is unfixable, and one that does
 * pick up a new bake in bounded time when there is one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BakeRefresh } from './bake-refresh.js';

test('nothing missing: never due, however long it runs', () => {
  const r = new BakeRefresh('t0', 10, 60);
  for (let t = 0; t < 10_000; t += 7) assert.equal(r.due(t, 0), false);
});

test('something missing: first poll one interval later, not at once', () => {
  const r = new BakeRefresh('t0', 10, 60);
  assert.equal(r.due(100, 3), false, 'noticing is not polling');
  assert.equal(r.due(105, 3), false);
  assert.equal(r.due(110, 3), true);
});

test('a poll in flight suppresses the next until it is released', () => {
  const r = new BakeRefresh('t0', 10, 60);
  r.due(0, 1);
  assert.equal(r.due(10, 1), true);
  r.inFlight = true;
  assert.equal(r.due(100, 1), false);
  r.inFlight = false;
  assert.equal(r.due(100, 1), true);
});

test('while nothing changes the interval doubles to the ceiling', () => {
  const r = new BakeRefresh('t0', 10, 60);
  const polls: number[] = [];
  for (let t = 0; t <= 400; t++) if (r.due(t, 1)) polls.push(t);
  // first at 10; then waits of 20, 40, 60, 60, 60 ...
  assert.deepEqual(polls.slice(0, 6), [10, 30, 70, 130, 190, 250]);
});

test('adopting a new bundle resets the back-off and the identity', () => {
  const r = new BakeRefresh('t0', 10, 60);
  for (let t = 0; t <= 200; t++) r.due(t, 1);       // backed off to the ceiling
  assert.equal(r.isNew('t0'), false);
  assert.equal(r.isNew('t1'), true);
  r.adopt('t1');
  assert.equal(r.isNew('t1'), false);
  assert.equal(r.due(300, 1), false, 'fresh start: one short interval first');
  assert.equal(r.due(310, 1), true, 'and then the SHORT interval again, not the ceiling');
});

test('the missing count dropping to zero mid-way stops polling and forgets the back-off', () => {
  const r = new BakeRefresh('t0', 10, 60);
  for (let t = 0; t <= 200; t++) r.due(t, 1);
  assert.equal(r.due(201, 0), false);
  // Something new goes missing later: the short interval applies again.
  assert.equal(r.due(300, 2), false);
  assert.equal(r.due(310, 2), true);
});
