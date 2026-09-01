/**
 * Tests for the incremental region sync.
 *
 * The two properties worth pinning down are the ones whose failure is invisible rather
 * than loud:
 *
 *  - reporting a chunk as changed when it did not change costs a full re-mesh of a
 *    24-section column every flush, which turns a live view into a stutter;
 *  - NOT reporting one that did change means the turtle never moves on screen, and there
 *    is nothing in the UI to say so.
 *
 * Region files are synthesised here rather than read from the world, so the test does not
 * depend on a live server's bytes and cannot write to one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zlibSync } from 'fflate';
import { SECTOR, decodeChunkPayload, parseRegionHeader } from '../core/region.js';
import {
  RegionWatcher, diffSections, invalidatedSections, regionCoords, type RangeFetch,
} from './region-sync.js';
import type { ChunkColumn, StoredSection } from '../render/world.js';

// ---------------------------------------------------------------------------
// Fixtures.
//
// The repo has an NBT reader and no writer, so this is the smallest writer that produces
// something the real reader accepts: a root compound of string tags. Deliberately the
// real format rather than a stub, so these tests exercise the actual decode path.

function writeNbtForTest(fields: Record<string, string>): Uint8Array {
  const bytes: number[] = [10, 0, 0]; // TAG_Compound, root name ''
  const put = (s: string) => {
    bytes.push((s.length >> 8) & 0xff, s.length & 0xff);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0x7f);
  };
  for (const [k, v] of Object.entries(fields)) {
    bytes.push(8); // TAG_String
    put(k);
    put(v);
  }
  bytes.push(0); // TAG_End
  return Uint8Array.from(bytes);
}

/**
 * Padding that does not compress away. `'y'.repeat(n)` deflates to almost nothing, which
 * would leave every fixture one sector long and quietly stop the size-change tests from
 * testing anything.
 */
function noise(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let seed = 0x2545f491;
  let out = '';
  for (let i = 0; i < n; i++) {
    // Math.imul, not `*`: 32-bit LCG state times a 30-bit multiplier exceeds 2^53, and
    // float rounding turns the sequence periodic — which compresses, defeating the point.
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    out += alphabet[(seed >>> 9) & 63];
  }
  return out;
}

// A minimal but REAL .mca file: header, then zlib-compressed NBT at sector 2.

interface FakeChunk {
  index: number;
  timestamp: number;
  payload: Uint8Array;
}

function buildRegion(chunks: FakeChunk[]): Uint8Array {
  const sectors: Uint8Array[] = [];
  const loc = new DataView(new ArrayBuffer(SECTOR));
  const ts = new DataView(new ArrayBuffer(SECTOR));

  for (const c of chunks) {
    const body = zlibSync(c.payload);
    const framed = new Uint8Array(Math.ceil((5 + body.length) / SECTOR) * SECTOR);
    new DataView(framed.buffer).setInt32(0, body.length + 1);
    framed[4] = 2; // zlib
    framed.set(body, 5);
    const offset = 2 + sectors.reduce((n, s) => n + s.byteLength / SECTOR, 0);
    loc.setUint32(c.index * 4, (offset << 8) | (framed.byteLength / SECTOR));
    ts.setInt32(c.index * 4, c.timestamp);
    sectors.push(framed);
  }

  const total = SECTOR * 2 + sectors.reduce((n, s) => n + s.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(new Uint8Array(loc.buffer), 0);
  out.set(new Uint8Array(ts.buffer), SECTOR);
  let o = SECTOR * 2;
  for (const s of sectors) {
    out.set(s, o);
    o += s.byteLength;
  }
  return out;
}

/** A `RangeFetch` over an in-memory file, counting bytes so cheapness is testable. */
function fetcherFor(files: Map<string, Uint8Array>) {
  const state = { bytes: 0, calls: 0 };
  const fetchRange: RangeFetch = async (name, start, end) => {
    const f = files.get(name);
    if (!f) return null;
    const slice = f.subarray(start, Math.min(end + 1, f.byteLength));
    state.bytes += slice.byteLength;
    state.calls++;
    return slice;
  };
  return { fetchRange, state };
}

const NAME = 'r.-1.0.mca';

// ---------------------------------------------------------------------------

test('regionCoords parses the filename both signs of it', () => {
  assert.deepEqual(regionCoords('r.-1.0.mca'), [-1, 0]);
  assert.deepEqual(regionCoords('r.0.0.mca'), [0, 0]);
  assert.deepEqual(regionCoords('/dev/region/r.-2.-3.mca'), [-2, -3]);
});

test('a region round-trips through parseRegionHeader and decodeChunkPayload', () => {
  const nbt = writeNbtForTest({ Status: 'minecraft:full' });
  const file = buildRegion([{ index: 5, timestamp: 111, payload: nbt }]);

  const header = parseRegionHeader(file.subarray(0, SECTOR * 2));
  assert.equal(header.length, 1);
  assert.equal(header[0].localX, 5);
  assert.equal(header[0].localZ, 0);
  assert.equal(header[0].timestamp, 111);

  const { sectorOffset, sectorCount } = header[0];
  const sectors = file.subarray(sectorOffset * SECTOR, (sectorOffset + sectorCount) * SECTOR);
  const root = decodeChunkPayload(sectors);
  assert.equal(root?.Status, 'minecraft:full');
});

test('parseRegionHeader refuses a truncated header rather than reading garbage', () => {
  assert.throws(() => parseRegionHeader(new Uint8Array(100)), /header too small/i);
});

test('the first poll reports nothing — it establishes the baseline', async () => {
  const files = new Map([[NAME, buildRegion([{ index: 0, timestamp: 1, payload: writeNbtForTest({}) }])]]);
  const { fetchRange } = fetcherFor(files);
  const w = new RegionWatcher(fetchRange, [NAME]);
  assert.deepEqual(await w.poll(), []);
});

test('a changed timestamp reports exactly that chunk, at world coordinates', async () => {
  const files = new Map([[NAME, buildRegion([
    { index: 0, timestamp: 1, payload: writeNbtForTest({ v: 'a' }) },
    { index: 33, timestamp: 1, payload: writeNbtForTest({ v: 'b' }) },
  ])]]);
  const { fetchRange } = fetcherFor(files);
  const w = new RegionWatcher(fetchRange, [NAME]);
  await w.prime();
  assert.deepEqual(await w.poll(), [], 'nothing changed yet');

  files.set(NAME, buildRegion([
    { index: 0, timestamp: 1, payload: writeNbtForTest({ v: 'a' }) },
    { index: 33, timestamp: 2, payload: writeNbtForTest({ v: 'B' }) },
  ]));
  const changed = await w.poll();
  assert.equal(changed.length, 1);
  // index 33 -> localX 1, localZ 1, in region (-1, 0) -> world chunk (-31, 1).
  assert.equal(changed[0].cx, -31);
  assert.equal(changed[0].cz, 1);
  assert.equal(changed[0].root.v, 'B');
});

test('a chunk rewritten in place with the same timestamp is still caught', async () => {
  // Two saves inside one second share a timestamp; the sector layout still moves when
  // the compressed size crosses a 4 KB boundary. Watching only the clock would miss it.
  const small = writeNbtForTest({ v: 'x' });
  const big = writeNbtForTest({ v: noise(9000) });
  const files = new Map([[NAME, buildRegion([{ index: 0, timestamp: 7, payload: small }])]]);
  const { fetchRange } = fetcherFor(files);
  const w = new RegionWatcher(fetchRange, [NAME]);
  await w.prime();

  files.set(NAME, buildRegion([{ index: 0, timestamp: 7, payload: big }]));
  assert.equal((await w.poll()).length, 1);
});

test('polling an unchanged region costs one 8 KB header read, not the whole file', async () => {
  const payload = writeNbtForTest({ pad: noise(40_000) });
  const files = new Map([[NAME, buildRegion([{ index: 0, timestamp: 1, payload }])]]);
  const { fetchRange, state } = fetcherFor(files);
  const w = new RegionWatcher(fetchRange, [NAME]);
  await w.prime();
  const before = state.bytes;

  await w.poll();
  assert.equal(state.bytes - before, SECTOR * 2, 'an idle poll must read only the header');
  assert.ok(files.get(NAME)!.byteLength > SECTOR * 4, 'the file under test is much larger');
});

test('a chunk that fails to decode is recorded, not thrown, and does not stop the sync', async () => {
  const files = new Map([[NAME, buildRegion([
    { index: 0, timestamp: 1, payload: writeNbtForTest({ v: 'a' }) },
    { index: 1, timestamp: 1, payload: writeNbtForTest({ v: 'b' }) },
  ])]]);
  const { fetchRange } = fetcherFor(files);
  const w = new RegionWatcher(fetchRange, [NAME]);
  await w.prime();

  // Corrupt chunk 0's compressed body; chunk 1 must still come through.
  const next = buildRegion([
    { index: 0, timestamp: 2, payload: writeNbtForTest({ v: 'a' }) },
    { index: 1, timestamp: 2, payload: writeNbtForTest({ v: 'B' }) },
  ]);
  next.fill(0xff, SECTOR * 2 + 8, SECTOR * 2 + 40);
  files.set(NAME, next);

  const changed = await w.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].root.v, 'B');
  assert.equal(w.failures.size, 1);
});

// ---------------------------------------------------------------------------
// diffSections

function column(sections: Record<number, { ids?: number[]; uniform?: number }>): ChunkColumn {
  const map = new Map<number, StoredSection>();
  for (const [y, s] of Object.entries(sections)) {
    map.set(Number(y), {
      y: Number(y),
      ids: s.ids ? Uint16Array.from(s.ids) : null,
      uniform: s.uniform ?? 0,
      blockLight: null,
      skyLight: null,
      biomeIds: null,
      biomeUniform: 0,
    });
  }
  return { x: 0, z: 0, minSection: 0, sections: map, blockEntities: new Map(), status: 'full' };
}

test('diffSections reports only the sections whose blocks differ', () => {
  const before = column({ 3: { ids: [1, 2, 3] }, 4: { ids: [9, 9, 9] }, 5: { uniform: 0 } });
  const after = column({ 3: { ids: [1, 2, 3] }, 4: { ids: [9, 8, 9] }, 5: { uniform: 0 } });
  assert.deepEqual(diffSections(before, after), [4]);
});

test('diffSections treats a gained or lost section as changed', () => {
  assert.deepEqual(diffSections(column({ 1: { ids: [0] } }), column({})), [1]);
  assert.deepEqual(diffSections(column({}), column({ 2: { ids: [0] } })), [2]);
});

test('diffSections compares uniform sections without materialising them', () => {
  assert.deepEqual(diffSections(column({ 0: { uniform: 5 } }), column({ 0: { uniform: 5 } })), []);
  assert.deepEqual(diffSections(column({ 0: { uniform: 5 } }), column({ 0: { uniform: 6 } })), [0]);
  // A section that became non-uniform holds different blocks even if the id list is short.
  assert.deepEqual(diffSections(column({ 0: { uniform: 5 } }), column({ 0: { ids: [5] } })), [0]);
});

test('diffSections against no previous column reports everything', () => {
  assert.deepEqual(diffSections(undefined, column({ 2: { ids: [1] }, 0: { ids: [1] } })), [0, 2]);
});

test('invalidatedSections includes all six neighbours', () => {
  // Face culling reads across section boundaries, so a block change at the edge of a
  // section changes the geometry of the section next door. Re-meshing only the changed
  // one leaves a hole where the shared face used to be culled.
  const keys = invalidatedSections(3, 4, 5);
  assert.equal(keys.length, 7);
  assert.ok(keys.includes('3,4,5'));
  for (const k of ['4,4,5', '2,4,5', '3,4,6', '3,4,4', '3,5,5', '3,3,5']) {
    assert.ok(keys.includes(k), `missing neighbour ${k}`);
  }
});
