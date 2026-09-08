/**
 * Chunk streaming, exercised against synthetic region files through the real header
 * parser and chunk decoder.
 *
 * The properties that matter are the ones a screenshot would not show:
 *  - nothing outside the load radius is fetched (that IS the load-time win);
 *  - the nearest chunk arrives first;
 *  - chunks stored next to each other in the file share a request;
 *  - a chunk that moved in the file between the index read and the fetch is detected
 *    (the decoded xPos/zPos disagree) and re-read through a fresh index, never handed to
 *    the world as the wrong chunk;
 *  - moving the camera unloads what fell behind and loads what came into range.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zlibSync } from 'fflate';
import { SECTOR } from '../core/region.js';
import type { RangeFetch } from './region-sync.js';
import { ChunkStreamer, parseStreamParam, type StreamHooks } from './chunk-stream.js';
import type { NbtCompound } from '../core/nbt.js';

// ---------------------------------------------------------------------------
// Fixtures: the smallest NBT writer the real reader accepts, for int and string tags.

function writeNbt(fields: Record<string, number | string>): Uint8Array {
  const bytes: number[] = [10, 0, 0];
  const putStr = (s: string) => {
    bytes.push((s.length >> 8) & 0xff, s.length & 0xff);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0x7f);
  };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') {
      bytes.push(3); // TAG_Int
      putStr(k);
      bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    } else {
      bytes.push(8); // TAG_String
      putStr(k);
      putStr(v);
    }
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

function noise(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let seed = 0x2545f491;
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    out += alphabet[(seed >>> 9) & 63];
  }
  return out;
}

interface FakeChunk { lx: number; lz: number; payload: Uint8Array; timestamp?: number }

/** A real .mca: header then zlib chunks from sector 2, in the order given. */
function buildRegion(chunks: FakeChunk[]): Uint8Array {
  const sectors: Uint8Array[] = [];
  const loc = new DataView(new ArrayBuffer(SECTOR));
  const ts = new DataView(new ArrayBuffer(SECTOR));
  for (const c of chunks) {
    const body = zlibSync(c.payload);
    const framed = new Uint8Array(Math.ceil((5 + body.length) / SECTOR) * SECTOR);
    new DataView(framed.buffer).setInt32(0, body.length + 1);
    framed[4] = 2;
    framed.set(body, 5);
    const offset = 2 + sectors.reduce((n, s) => n + s.byteLength / SECTOR, 0);
    const index = c.lx + c.lz * 32;
    loc.setUint32(index * 4, (offset << 8) | (framed.byteLength / SECTOR));
    ts.setInt32(index * 4, c.timestamp ?? 1);
    sectors.push(framed);
  }
  const out = new Uint8Array(SECTOR * 2 + sectors.reduce((n, s) => n + s.byteLength, 0));
  out.set(new Uint8Array(loc.buffer), 0);
  out.set(new Uint8Array(ts.buffer), SECTOR);
  let o = SECTOR * 2;
  for (const s of sectors) { out.set(s, o); o += s.byteLength; }
  return out;
}

/** Chunk (cx, cz) of region r.0.0 as a fixture, with a payload big enough to span sectors. */
function chunk(cx: number, cz: number, pad = 0): FakeChunk {
  return { lx: cx & 31, lz: cz & 31, payload: writeNbt({ xPos: cx, zPos: cz, Status: 'minecraft:full', pad: noise(pad) }) };
}

function fetcherFor(files: Map<string, Uint8Array>) {
  const state = { bytes: 0, calls: 0, ranges: [] as Array<[number, number]> };
  const fetchRange: RangeFetch = async (name, start, end) => {
    const f = files.get(name);
    if (!f) return null;
    const slice = f.subarray(start, Math.min(end + 1, f.byteLength));
    state.bytes += slice.byteLength;
    state.calls++;
    state.ranges.push([start, end]);
    return slice;
  };
  return { fetchRange, state };
}

/** Let the streamer's fetch promises settle. */
async function settle(s: ChunkStreamer) {
  for (let i = 0; i < 50 && !s.idle; i++) await new Promise((r) => setTimeout(r, 2));
}

function harness(files: Map<string, Uint8Array>, opts: Partial<ConstructorParameters<typeof ChunkStreamer>[2]> = {}) {
  const { fetchRange, state } = fetcherFor(files);
  const arrived: Array<[number, number]> = [];
  const unloaded: Array<[number, number]> = [];
  const roots = new Map<string, NbtCompound>();
  let clock = 0;
  const hooks: StreamHooks = {
    fetchRange,
    onChunk: (root, cx, cz) => { arrived.push([cx, cz]); roots.set(`${cx},${cz}`, root); },
    onUnload: (cx, cz) => unloaded.push([cx, cz]),
    now: () => clock,
  };
  const streamer = new ChunkStreamer([...files.keys()], hooks, opts);
  return { streamer, state, arrived, unloaded, roots, tick: (ms: number) => { clock += ms; } };
}

const R = 'r.0.0.mca';

// ---------------------------------------------------------------------------

test('only chunks inside the load radius are fetched, and the nearest arrives first', async () => {
  // A row of chunks along x at z=0; the camera sits over chunk 10.
  const files = new Map([[R, buildRegion(Array.from({ length: 32 }, (_, i) => chunk(i, 0, 3000)))]]);
  const h = harness(files, { loadRadius: 3, concurrency: 1, coalesceGap: 0 });
  await h.streamer.start(10 * 16 + 8, 8);
  await settle(h.streamer);

  const xs = h.arrived.map(([cx]) => cx).sort((a, b) => a - b);
  assert.deepEqual(xs, [7, 8, 9, 10, 11, 12, 13], 'chunks 7..13 are within 3 chunks of chunk 10');
  assert.equal(h.arrived[0][0], 10, 'the chunk under the camera comes first');
  // The whole file is 32 chunks; we read 1 header + 7 chunks' worth, nowhere near all of it.
  const file = files.get(R)!;
  assert.ok(h.state.bytes < file.byteLength / 3, `read ${h.state.bytes} of ${file.byteLength} bytes`);
  assert.equal(h.streamer.stats.loaded, 7);
});

test('chunks adjacent in the file are fetched with one request', async () => {
  // Stored in the order 5,6,7,8 — contiguous — so a wide gap coalesces all four.
  const files = new Map([[R, buildRegion([chunk(5, 0), chunk(6, 0), chunk(7, 0), chunk(8, 0)])]]);
  const h = harness(files, { loadRadius: 4, concurrency: 1, coalesceGap: 16 * 1024 });
  await h.streamer.start(6 * 16 + 8, 8);
  await settle(h.streamer);
  assert.equal(h.arrived.length, 4);
  // 1 header read + 1 coalesced body read.
  assert.equal(h.state.calls, 2, `expected header + one batch, got ranges ${JSON.stringify(h.state.ranges)}`);
});

test('a decoded chunk whose coordinates disagree with the index is never delivered', async () => {
  // The index says chunk 3 is at sector 2, but the bytes there (written after the header
  // was read) hold chunk 4 — what a `save-all flush` between two Range reads looks like.
  const before = buildRegion([chunk(3, 0), chunk(4, 0)]);
  const after = buildRegion([chunk(4, 0), chunk(3, 0)]);
  const files = new Map([[R, before]]);
  const h = harness(files, { loadRadius: 1, concurrency: 1, coalesceGap: 0 });
  // Serve the OLD header, then swap the file under the streamer before the body read.
  const inner = h.streamer['hooks'].fetchRange;
  let headerReads = 0;
  h.streamer['hooks'].fetchRange = async (name, start, end) => {
    if (start === 0) { headerReads++; if (headerReads === 1) { const r = await inner(name, start, end); files.set(R, after); return r; } }
    return inner(name, start, end);
  };
  await h.streamer.start(3 * 16 + 8, 8);
  await settle(h.streamer);
  await settle(h.streamer);
  for (const [cx, cz] of h.arrived) {
    const root = h.roots.get(`${cx},${cz}`)!;
    assert.equal(root.xPos, cx, 'delivered chunk carries the coordinates it was filed under');
    assert.equal(root.zPos, cz);
  }
  assert.ok(headerReads >= 2, 'the mismatch forced an index refresh');
  assert.ok(h.arrived.some(([cx]) => cx === 3), 'chunk 3 arrived through the fresh index');
});

test('moving the camera unloads what fell behind and loads what came into range', async () => {
  const files = new Map([[R, buildRegion(Array.from({ length: 32 }, (_, i) => chunk(i, 0)))]]);
  const h = harness(files, { loadRadius: 2, unloadRadius: 4, concurrency: 2, coalesceGap: 0, moveThreshold: 16, debounceMs: 100 });
  await h.streamer.start(4 * 16 + 8, 8);
  await settle(h.streamer);
  assert.deepEqual(h.arrived.map(([cx]) => cx).sort((a, b) => a - b), [2, 3, 4, 5, 6]);

  // Fly to chunk 20. Before the debounce elapses nothing is re-prioritised...
  h.streamer.setCamera(20 * 16 + 8, 8);
  await settle(h.streamer);
  assert.equal(h.arrived.length, 5, 'no refetch inside the debounce window');
  // ...and after it, the old ring is unloaded and the new one arrives nearest-first.
  h.tick(200);
  h.streamer.setCamera(20 * 16 + 8, 8);
  await settle(h.streamer);
  assert.deepEqual(h.unloaded.map(([cx]) => cx).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
  const fresh = h.arrived.slice(5).map(([cx]) => cx);
  assert.deepEqual([...fresh].sort((a, b) => a - b), [18, 19, 20, 21, 22]);
  assert.equal(fresh[0], 20);
  assert.equal(h.streamer.stats.loaded, 5);
});

test('isSettled: loaded, absent, out-of-range and failed chunks do not hold up meshing; wanted ones do', async () => {
  const files = new Map([[R, buildRegion([chunk(0, 0), chunk(1, 0), chunk(2, 0)])]]);
  const h = harness(files, { loadRadius: 1, concurrency: 1, coalesceGap: 0 });
  // Read only the index: nothing fetched yet.
  await h.streamer.refreshIndex();
  h.streamer['cam'] = { x: 8, z: 8 };
  assert.equal(h.streamer.isSettled(0, 0), false, 'wanted and not yet loaded');
  assert.equal(h.streamer.isSettled(2, 0), true, 'outside the load radius: will not arrive');
  assert.equal(h.streamer.isSettled(7, 7), true, 'the world has no such chunk');
  await h.streamer.start(8, 8);
  await settle(h.streamer);
  assert.equal(h.streamer.isSettled(0, 0), true, 'loaded now');
  assert.equal(h.streamer.isSettled(1, 0), true);
});

test('an unreadable chunk is counted as a failure and retried only after an index refresh', async () => {
  const good = buildRegion([chunk(0, 0)]);
  const broken = new Uint8Array(good);
  broken[SECTOR * 2 + 4] = 9; // an unknown compression id
  const files = new Map<string, Uint8Array>([[R, broken]]);
  const h = harness(files, { loadRadius: 1, concurrency: 1 });
  await h.streamer.start(8, 8);
  await settle(h.streamer);
  assert.equal(h.arrived.length, 0);
  assert.equal(h.streamer.stats.failures, 1);
  assert.equal(h.streamer.isSettled(0, 0), true, 'a failed chunk must not defer its neighbours forever');
  const calls = h.state.calls;
  h.streamer.setCamera(8, 8);
  await settle(h.streamer);
  assert.equal(h.state.calls, calls, 'not hammered on every frame');
  files.set(R, good);
  await h.streamer.refreshIndex();
  h.streamer.setCamera(8, 8);
  await settle(h.streamer);
  assert.equal(h.arrived.length, 1, 'eligible again once the index was re-read');
});

test('parseStreamParam: default on, explicit off, a number is the radius', () => {
  assert.deepEqual(parseStreamParam(null), { enabled: true });
  assert.deepEqual(parseStreamParam(''), { enabled: true });
  assert.deepEqual(parseStreamParam('0'), { enabled: false });
  assert.deepEqual(parseStreamParam('off'), { enabled: false });
  assert.deepEqual(parseStreamParam('12'), { enabled: true, loadRadius: 12 });
  assert.deepEqual(parseStreamParam('junk'), { enabled: true });
});
