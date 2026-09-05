/**
 * `holdLost`: the tracker's behaviour for turtles that leave `computercraft dump`.
 *
 * A player who leaves the roster is gone and the track is dropped. A turtle that leaves the
 * dump was unloaded or broken and is still where it was — so its pose must be HELD at the
 * last reading exactly, flagged STALE, and must resume tracking if it comes back. This is
 * what makes "the drones look stuck" a statement the screen can be honest about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerTracks } from './player-tracks.js';

const DIM = 'minecraft:overworld';
const entry = (name: string, x: number) => ({ name, pos: [x, 64, 0] as const, yawDeg: 0, dimension: DIM });

test('default: a track the roster stops listing is dropped once played out', () => {
  const t = new PlayerTracks(DIM);
  t.ingest([entry('#1', 0)], 0);
  t.ingest([entry('#1', 2)], 1000);
  t.ingest([], 2000);
  t.poses(2100);
  const late = t.poses(6000);
  assert.equal(late.length, 0);
});

test('holdLost: a lost turtle is held EXACTLY at its last reading and marked STALE', () => {
  const t = new PlayerTracks(DIM, { holdLost: true });
  t.ingest([entry('#1', 0)], 0);
  t.ingest([entry('#1', 2)], 1000);   // moving +2 blocks/s
  t.ingest([], 2000);                 // gone from the dump
  const early = t.poses(2100);
  assert.equal(early.length, 1);
  const late = t.poses(6000);
  assert.equal(late.length, 1, 'still drawn');
  assert.deepEqual(late[0].pos, [2, 64, 0], 'no dead reckoning past the last reading');
  assert.equal(late[0].stale, true);
  assert.deepEqual(t.names(), ['#1']);
});

test('holdLost: a turtle that comes back is tracked again', () => {
  const t = new PlayerTracks(DIM, { holdLost: true });
  t.ingest([entry('#1', 0)], 0);
  t.ingest([], 1000);
  t.poses(4000);
  t.ingest([entry('#1', 10)], 5000);
  t.ingest([entry('#1', 12)], 6000);
  // Chase the target across a few frames; a snap over 4 blocks is allowed, then it tracks.
  // The render clock sits ~1.08 s behind, so at 7.3 s the pose is the 6 s reading plus up to
  // 350 ms of dead reckoning at 2 blocks/s — between 12 and 12.7, never back at the old 0.
  let pose = t.poses(7100)[0];
  for (let f = 7116; f <= 7300; f += 16) pose = t.poses(f)[0];
  assert.equal(pose.stale, false);
  assert.ok(pose.pos[0] >= 10 && pose.pos[0] <= 12.7, `tracking the fresh readings, got ${pose.pos[0]}`);
});

test('holdLost: a lost turtle does not stop the others being tracked normally', () => {
  const t = new PlayerTracks(DIM, { holdLost: true });
  t.ingest([entry('#1', 0), entry('#2', 0)], 0);
  t.ingest([entry('#2', 1)], 1000);
  t.ingest([entry('#2', 2)], 2000);
  const poses = t.poses(2200);
  const one = poses.find((p) => p.name === '#1')!;
  const two = poses.find((p) => p.name === '#2')!;
  assert.deepEqual(one.pos, [0, 64, 0]);
  assert.ok(two.pos[0] > 0);
});
