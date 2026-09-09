/**
 * The camera's opening point comes from level.dat's Data.SpawnX/Y/Z. These build real
 * NBT bytes — the tag layout the game writes — and run them through the real reader,
 * gzipped as the server writes the file and raw as a copy might arrive.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gzipSync } from 'fflate';
import { readSpawn } from './world-spawn.js';

// Minimal NBT writer for the shapes this test needs: root compound "" > compound "Data".
function str(s: string): number[] {
  const b = [...new TextEncoder().encode(s)];
  return [b.length >> 8, b.length & 0xff, ...b];
}
function int(name: string, v: number): number[] {
  return [3, ...str(name), (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function levelDat(fields: number[][], extraData: number[][] = []): Uint8Array {
  return new Uint8Array([
    10, ...str(''),               // TAG_Compound ""
    10, ...str('Data'),           //   TAG_Compound "Data"
    ...fields.flat(),
    ...extraData.flat(),
    0,                            //   TAG_End
    0,                            // TAG_End
  ]);
}

test('reads Data.SpawnX/Y/Z from a gzipped level.dat', () => {
  const raw = levelDat([int('SpawnX', 64), int('SpawnY', 69), int('SpawnZ', 36), int('DayTime', 1000)]);
  assert.deepEqual(readSpawn(gzipSync(raw)), { x: 64, y: 69, z: 36 });
});

test('accepts an uncompressed copy and negative coordinates', () => {
  const raw = levelDat([int('SpawnX', -480), int('SpawnY', 63), int('SpawnZ', -12)]);
  assert.deepEqual(readSpawn(raw), { x: -480, y: 63, z: -12 });
});

test('a world with no spawn tag yields null rather than a guess', () => {
  assert.equal(readSpawn(levelDat([int('DayTime', 5)])), null);
});

test('garbage yields null, not a throw', () => {
  assert.equal(readSpawn(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), null);
  assert.equal(readSpawn(new Uint8Array([9, 9, 9])), null);
});
