/**
 * Two claims a screenshot cannot make, because both are about time:
 *
 *   - a save-file entity refreshed only when the server flushes is REPOSITIONED with a
 *     bounded slide and then held still, not glided across a gap it never walked, and not
 *     flagged STALE merely for being between flushes;
 *   - a thing that DROPS OUT of a refresh is held — briefly for a dropped item that was
 *     picked up, far longer and flagged STALE for a mob that may only have wandered out of
 *     a loaded chunk — and then forgotten, so ghosts do not accumulate over a session.
 *
 * Plus the decode: the fields the renderer keys off (uuid, type, pos, yaw, item, block,
 * name) come off real NBT shapes correctly, and a malformed entity is dropped rather than
 * drawn at NaN.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntityTracks, decodeEntities, type EntitySample } from './entity-tracks.js';
import type { NbtCompound } from '../core/nbt.js';

const uuid = (n: number) => new Int32Array([n, 0, 0, 0]);

function sample(over: Partial<EntitySample> & { uuid: string }): EntitySample {
  return {
    type: 'minecraft:cow',
    pos: [0, 64, 0],
    yawDeg: 0,
    name: null,
    item: null,
    block: null,
    appearance: { key: '', layers: [{ model: null, texture: null, tint: null }] },
    held: [],
    facing: null,
    rotation: null,
    ...over,
  };
}

// --- decode ----------------------------------------------------------------

test('decodeEntities reads pos, yaw, uuid, item and block off real NBT shapes', () => {
  const root: NbtCompound = {
    Entities: [
      { id: 'minecraft:cow', Pos: [-476.3, 64, 78.1], Rotation: [309.2, 0], UUID: uuid(1) },
      {
        id: 'minecraft:item', Pos: [1, 65, 2], Rotation: [186, 0], UUID: uuid(2),
        Item: { id: 'minecraft:egg', count: 3 },
      },
      {
        id: 'minecraft:falling_block', Pos: [10.5, 70, 20.5], Rotation: [0, 0], UUID: uuid(3),
        BlockState: { Name: 'minecraft:sand' },
      },
    ],
  } as unknown as NbtCompound;

  const out = decodeEntities(root);
  assert.equal(out.length, 3);
  const cow = out.find((e) => e.type === 'minecraft:cow')!;
  assert.deepEqual(cow.pos, [-476.3, 64, 78.1]);
  assert.equal(cow.yawDeg, 309.2);
  assert.equal(cow.uuid, '1_0_0_0');
  const item = out.find((e) => e.type === 'minecraft:item')!;
  assert.deepEqual(item.item, { id: 'minecraft:egg', count: 3 });
  const fb = out.find((e) => e.type === 'minecraft:falling_block')!;
  assert.equal(fb.block, 'minecraft:sand');
});

test('decodeEntities drops an entity with no Pos or no UUID rather than drawing NaN', () => {
  const root = {
    Entities: [
      { id: 'minecraft:cow', Rotation: [0, 0], UUID: uuid(1) }, // no Pos
      { id: 'minecraft:cow', Pos: [0, 0, 0] },                  // no UUID
      { id: 'minecraft:cow', Pos: [1, 2, 3], UUID: uuid(9) },   // fine
    ],
  } as unknown as NbtCompound;
  const out = decodeEntities(root);
  assert.equal(out.length, 1);
  assert.equal(out[0].uuid, '9_0_0_0');
});

test('CustomName is read as plain text from a JSON component or bare string', () => {
  const root = {
    Entities: [
      { id: 'minecraft:cow', Pos: [0, 0, 0], UUID: uuid(1), CustomName: '{"text":"Bessie"}' },
      { id: 'minecraft:cow', Pos: [0, 0, 0], UUID: uuid(2), CustomName: 'Daisy' },
    ],
  } as unknown as NbtCompound;
  const out = decodeEntities(root);
  assert.equal(out.find((e) => e.uuid === '1_0_0_0')!.name, 'Bessie');
  assert.equal(out.find((e) => e.uuid === '2_0_0_0')!.name, 'Daisy');
});

// --- tracker ---------------------------------------------------------------

test('a new entity is drawn immediately at its position', () => {
  const t = new EntityTracks({ holdMs: 30000 });
  t.ingest([sample({ uuid: 'a', pos: [5, 64, 5] })], 0);
  const [p] = t.poses(16);
  assert.deepEqual(p.pos.map(Math.round), [5, 64, 5]);
  assert.equal(p.stale, false);
});

test('a small move slides over a few frames rather than teleporting, then settles', () => {
  const t = new EntityTracks({ holdMs: 30000 });
  t.ingest([sample({ uuid: 'a', pos: [0, 64, 0] })], 0);
  t.poses(0);
  t.ingest([sample({ uuid: 'a', pos: [3, 64, 0] })], 5000); // 3 blocks in the next flush
  // First frame after the sample must not already be at the target (it slides).
  const first = t.poses(5016)[0];
  assert.ok(first.pos[0] > 0 && first.pos[0] < 3, `slid partway, got ${first.pos[0]}`);
  // Within a second (8 blocks/s budget) it has arrived and holds.
  let pose = first;
  for (let f = 5032; f <= 6000; f += 16) pose = t.poses(f)[0];
  assert.ok(Math.abs(pose.pos[0] - 3) < 0.01, `settled at target, got ${pose.pos[0]}`);
});

test('a move past the snap distance teleports rather than gliding', () => {
  const t = new EntityTracks({ holdMs: 30000 });
  t.ingest([sample({ uuid: 'a', pos: [0, 64, 0] })], 0);
  t.poses(0);
  t.ingest([sample({ uuid: 'a', pos: [40, 64, 0] })], 5000);
  const first = t.poses(5016)[0];
  assert.deepEqual(first.pos.map(Math.round), [40, 64, 0]);
});

test('an item that drops out of a refresh is held briefly then forgotten', () => {
  const t = new EntityTracks({ holdMs: 500 });
  t.ingest([sample({ uuid: 'i', type: 'minecraft:item', pos: [1, 64, 1] })], 0);
  t.ingest([], 1000); // gone from the next flush
  const held = t.poses(1100);
  assert.equal(held.length, 1, 'held through the grace');
  assert.equal(held[0].stale, true);
  assert.deepEqual(held[0].pos, [1, 64, 1], 'held exactly at last reading');
  const gone = t.poses(1600); // past holdMs
  assert.equal(gone.length, 0, 'forgotten after the grace');
  assert.equal(t.size, 0);
});

test('a mob that drops out is held STALE far longer, then expires', () => {
  const t = new EntityTracks({ holdMs: 30000 });
  t.ingest([sample({ uuid: 'm', pos: [2, 64, 2] })], 0);
  t.ingest([sample({ uuid: 'm', pos: [2, 64, 2] })], 5000);
  t.ingest([], 10000); // wandered out of a loaded chunk / despawned
  const stale = t.poses(20000);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].stale, true);
  assert.deepEqual(stale[0].pos, [2, 64, 2]);
  assert.equal(t.poses(41000).length, 0, 'expired after holdMs of being lost');
});

test('a mob that reappears is tracked again, not left STALE', () => {
  const t = new EntityTracks({ holdMs: 30000 });
  t.ingest([sample({ uuid: 'm', pos: [0, 64, 0] })], 0);
  t.ingest([], 5000);
  t.poses(6000);
  t.ingest([sample({ uuid: 'm', pos: [1, 64, 0] })], 10000);
  let pose = t.poses(10016)[0];
  for (let f = 10032; f <= 11000; f += 16) pose = t.poses(f)[0];
  assert.equal(pose.stale, false);
  assert.ok(Math.abs(pose.pos[0] - 1) < 0.01, `tracking again, got ${pose.pos[0]}`);
});
