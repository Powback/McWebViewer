/**
 * The join between `computercraft dump` and the region's block entities.
 *
 * What is pinned down: which block entities count as computers, that labels and kinds come
 * out of real-shaped NBT, that ONLY turtles are hidden and only at their saved block, that
 * the hidden set is spelt the way the mesher reads it, and the two yaw conventions agree —
 * a turtle at rest faces the way its block says, a turtle in motion the way it went.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChunkColumn } from '../render/world.js';
import type { NbtCompound } from '../core/nbt.js';
import {
  ComputerRegistry, blockIndexOf, changedSections, classifyBlockEntity, facingYawDeg,
  headingYawDeg, sectionKeyOf, turtleIdOf, turtleKey, turtleTagText,
} from './computer-registry.js';

/** A column holding just the given block entities; nothing else is read. */
function column(bes: NbtCompound[]): ChunkColumn {
  const blockEntities = new Map<number, NbtCompound>();
  bes.forEach((be, i) => blockEntities.set(i, be));
  return { x: 0, z: 0, minSection: -4, sections: new Map(), blockEntities, status: 'full' };
}

/** Shaped like the reference server's turtle block entity, trimmed. */
const D37: NbtCompound = {
  id: 'computercraft:turtle_normal', ComputerId: 57, Label: 'D37', On: 1,
  x: -466, y: 62, z: 30, Fuel: 1607,
};
const HQ: NbtCompound = { id: 'computercraft:computer_normal', ComputerId: 62, On: 1, x: -480, y: 64, z: 75 };
const MODEM: NbtCompound = { id: 'computercraft:wireless_modem_normal', x: 1, y: 2, z: 3 };

const states = new Map<string, string>([
  ['-466,62,30', 'computercraft:turtle_normal[facing=south,waterlogged=false]'],
  ['-480,64,75', 'computercraft:computer_normal[facing=north,state=on]'],
]);
const stateAt = (x: number, y: number, z: number) => states.get(`${x},${y},${z}`);

test('only turtles and computers have an id; peripherals do not', () => {
  assert.equal(classifyBlockEntity('computercraft:turtle_normal'), 'turtle');
  assert.equal(classifyBlockEntity('computercraft:turtle_advanced'), 'turtle');
  assert.equal(classifyBlockEntity('computercraft:computer_advanced'), 'computer');
  assert.equal(classifyBlockEntity('computercraft:wired_modem_full'), null);
  assert.equal(classifyBlockEntity('minecraft:chest'), null);
});

test('absorbing a column yields kind, label, saved block and facing, by id', () => {
  const r = new ComputerRegistry();
  assert.deepEqual(r.absorb(column([D37, HQ, MODEM]), stateAt), [57, 62]);
  assert.deepEqual(r.get(57), {
    id: 57, kind: 'turtle', blockId: 'computercraft:turtle_normal', label: 'D37', on: true,
    pos: [-466, 62, 30], facingYawDeg: 180,
  });
  assert.equal(r.kindOf(62), 'computer');
  assert.equal(r.kindOf(999), 'unknown');
  assert.equal(r.labelFor(57), 'D37 #57');
  assert.equal(r.labelFor(62), '#62');
  assert.equal(r.labelFor(999), '#999');
});

test('re-absorbing the same column reports no change; a moved turtle reports its id', () => {
  const r = new ComputerRegistry();
  r.absorb(column([D37]), stateAt);
  assert.deepEqual(r.absorb(column([D37]), stateAt), []);
  assert.deepEqual(r.absorb(column([{ ...D37, y: 63 }]), stateAt), [57]);
  assert.deepEqual(r.get(57)?.pos, [-466, 63, 30]);
});

test('only turtles are hidden, at their saved block, keyed the way the mesher iterates', () => {
  const r = new ComputerRegistry();
  r.absorb(column([D37, HQ]), stateAt);
  const hidden = r.hiddenBlocks([57, 62, 999]);
  assert.deepEqual([...hidden.keys()], [sectionKeyOf(-466, 62, 30)]);
  assert.deepEqual([...hidden.get(sectionKeyOf(-466, 62, 30))!], [blockIndexOf(-466, 62, 30)]);
  // The mesher's own spelling of the same block: section (x>>4, y>>4, z>>4), index (y<<8|z<<4|x) of the locals.
  assert.equal(sectionKeyOf(-466, 62, 30), '-30,3,1');
  assert.equal(blockIndexOf(-466, 62, 30), ((62 & 15) << 8) | ((30 & 15) << 4) | (-466 & 15));
});

test('the marker is the turtle\'s own block, facing north; unknown ids get a normal turtle', () => {
  const r = new ComputerRegistry();
  r.absorb(column([{ ...D37, id: 'computercraft:turtle_advanced' }]), stateAt);
  assert.equal(r.markerState(57), 'computercraft:turtle_advanced[facing=north,waterlogged=false]');
  assert.equal(r.markerState(5), 'computercraft:turtle_normal[facing=north,waterlogged=false]');
});

test('facing and heading share one convention: north 0, west 90, south 180, east 270', () => {
  assert.equal(facingYawDeg('x[facing=north,waterlogged=false]'), 0);
  assert.equal(facingYawDeg('x[facing=west]'), 90);
  assert.equal(facingYawDeg('x[facing=south]'), 180);
  assert.equal(facingYawDeg('x[facing=east]'), 270);
  assert.equal(facingYawDeg('minecraft:air'), null);
  assert.equal(facingYawDeg(undefined), null);
  const o: [number, number, number] = [0, 64, 0];
  assert.equal(headingYawDeg(o, [0, 64, -1]), 0, 'north');
  assert.equal(headingYawDeg(o, [-1, 64, 0]), 90, 'west');
  assert.equal(headingYawDeg(o, [0, 64, 1]), 180, 'south');
  assert.equal(headingYawDeg(o, [1, 64, 0]), 270, 'east');
  assert.equal(headingYawDeg(o, [0, 65, 0]), null, 'straight up keeps the old heading');
  assert.equal(headingYawDeg(undefined, o), null);
});

test('tracker keys round-trip the id and never change with the label', () => {
  assert.equal(turtleKey(57), '#57');
  assert.equal(turtleIdOf('#57'), 57);
});

test('the turtle tag reads name then activity, id only when there is no name', () => {
  assert.equal(turtleTagText('D37', 57, 'fetching wood'), 'D37 · fetching wood');
  assert.equal(turtleTagText('D37', 57, null), 'D37', 'name, no activity');
  assert.equal(turtleTagText(null, 57, 'depositing'), '#57 · depositing', 'activity, no name');
  assert.equal(turtleTagText(null, 57, null), '#57', 'nothing but the dump');
  assert.equal(turtleTagText('D37', 57, '   '), 'D37', 'blank activity is no activity');
});

test('a long activity line is truncated with an ellipsis', () => {
  const long = 'searching 6 chest(s) for stone_bricks';
  const tag = turtleTagText('D37', 57, long, 28);
  assert.ok(tag.startsWith('D37 · searching 6 chest'), tag);
  assert.ok(tag.endsWith('…'));
  // "D37 · " + at most 28 chars of activity.
  assert.ok(tag.length <= 'D37 · '.length + 28, `too long: ${tag}`);
  assert.equal(turtleTagText('D37', 57, 'fetching wood', 28), 'D37 · fetching wood', 'short lines are untouched');
});

test('changedSections names every section whose hidden set differs, and nothing else', () => {
  const a = new Map([['0,0,0', new Set([1, 2])], ['1,0,0', new Set([3])]]);
  const b = new Map([['0,0,0', new Set([1, 2])], ['1,0,0', new Set([4])], ['2,0,0', new Set([5])]]);
  assert.deepEqual(changedSections(a, b), ['1,0,0', '2,0,0']);
  assert.deepEqual(changedSections(a, a), []);
  assert.deepEqual(changedSections(new Map(), new Map()), []);
});
