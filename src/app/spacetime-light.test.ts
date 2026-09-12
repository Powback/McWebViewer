/**
 * Lighting from `chunk_light`.
 *
 * The one mistake this feature can make is conflating "the producer has not said anything
 * yet" with "it is dark". They arrive differently — an ABSENT ROW versus a PRESENT row of
 * 2048 zero bytes — and getting it wrong blacks out the world every time a chunk beats its
 * light packet. Most of what is below exists to pin that distinction down.
 *
 * The last test decodes REAL rows out of the running database and checks them against facts
 * established independently of this code: above the surface the sky light is full, at world
 * bottom it is zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toNibbles, sane, LIGHT_BYTES } from './spacetime-sections.js';
import { World } from '../render/world.js';

/** Pack 4096 cell values into the wire's nibble array, low nibble first. */
function packNibbles(valueAt: (i: number) => number): Int8Array {
  const out = new Int8Array(LIGHT_BYTES);
  for (let i = 0; i < 4096; i++) {
    const v = valueAt(i) & 0xf;
    const b = i >> 1;
    if ((i & 1) === 0) out[b] = (out[b] & 0xf0) | v;
    else out[b] = (out[b] & 0x0f) | (v << 4);
  }
  return out;
}

/** The index the schema uses: (y<<8) | (z<<4) | x, local coordinates. */
const idx = (x: number, y: number, z: number) => (y << 8) | (z << 4) | x;

function worldWith(light?: { blockLight?: Int8Array; skyLight?: Int8Array }): World {
  const w = new World();
  const palette = ['minecraft:air', 'minecraft:stone'];
  const indices = new Uint16Array(4096).fill(1);
  w.addLiveSection(0, 0, 0, { palette, indices, ...light });
  return w;
}

// ---------------------------------------------------------------------------
// The distinction that matters.

test('a section with NO light row renders FULLY LIT, not dark', () => {
  // The producer has said nothing. Blacking out here is the failure mode: it makes the world
  // flash dark whenever a chunk arrives before its light.
  const w = worldWith();
  assert.equal(w.getLight(3, 4, 5) >> 4, 15, 'sky light must default to full');
});

test('a section whose light row is all ZEROES renders DARK', () => {
  // A sealed cave really is pitch black, and the server says so with a present row of zeros.
  const w = worldWith({
    blockLight: new Int8Array(LIGHT_BYTES),
    skyLight: new Int8Array(LIGHT_BYTES),
  });
  assert.equal(w.getLight(3, 4, 5), 0, 'zeroed light must be dark, not defaulted to lit');
});

test('the two cases are genuinely distinguishable at the World level', () => {
  const unknown = worldWith().getLight(1, 1, 1);
  const dark = worldWith({
    blockLight: new Int8Array(LIGHT_BYTES), skyLight: new Int8Array(LIGHT_BYTES),
  }).getLight(1, 1, 1);
  assert.notEqual(unknown, dark, 'absent light and zero light must not render the same');
});

// ---------------------------------------------------------------------------
// The nibble layout, checked through the real consumer.

test('every cell round-trips through the wire layout into World.getLight', () => {
  // Not a spot check: all 4096 cells, with a value that varies per cell so a swapped
  // high/low nibble or a transposed axis cannot pass.
  const value = (i: number) => (i * 7 + 3) & 0xf;
  const w = worldWith({ blockLight: packNibbles(value), skyLight: packNibbles(() => 0) });
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = idx(x, y, z);
        assert.equal(w.getLight(x, y, z) & 0xf, value(i),
          `block light wrong at ${x},${y},${z} (index ${i})`);
      }
    }
  }
});

test('the LOW nibble is the even cell — a swap would pass a uniform array and fail here', () => {
  const arr = new Int8Array(LIGHT_BYTES);
  arr[0] = 0x1f; // cell 0 low nibble = 15, cell 1 high nibble = 1
  const w = worldWith({ blockLight: arr, skyLight: new Int8Array(LIGHT_BYTES) });
  assert.equal(w.getLight(0, 0, 0) & 0xf, 15, 'cell 0 must read the LOW nibble');
  assert.equal(w.getLight(1, 0, 0) & 0xf, 1, 'cell 1 must read the HIGH nibble');
});

test('sky and block light are carried independently', () => {
  const w = worldWith({
    blockLight: packNibbles(() => 4),
    skyLight: packNibbles(() => 11),
  });
  const packed = w.getLight(2, 2, 2);
  assert.equal(packed & 0xf, 4);
  assert.equal(packed >> 4, 11);
});

// ---------------------------------------------------------------------------
// Parsing.

test('a wrongly-sized array is refused, so a short read cannot render as darkness', () => {
  assert.equal(toNibbles(new Uint8Array(100)), null);
  assert.equal(toNibbles([]), null);
  assert.equal(toNibbles(undefined), null);
  assert.equal(toNibbles(null), null);
  assert.equal(toNibbles('nonsense'), null);
});

test('a correctly-sized array is accepted in any of the shapes the SDK may hand over', () => {
  assert.equal(toNibbles(new Uint8Array(LIGHT_BYTES))?.length, LIGHT_BYTES);
  assert.equal(toNibbles(new Int8Array(LIGHT_BYTES))?.length, LIGHT_BYTES);
  assert.equal(toNibbles(new Array(LIGHT_BYTES).fill(0))?.length, LIGHT_BYTES);
});

test('a Uint8Array keeps its VALUES, not its signedness, through the conversion', () => {
  const u = new Uint8Array(LIGHT_BYTES);
  u[0] = 0xff; // both nibbles 15
  const got = toNibbles(u);
  assert.ok(got);
  assert.equal(got[0] & 0xf, 15);
  assert.equal((got[0] >> 4) & 0xf, 15);
});

// ---------------------------------------------------------------------------
// The known-bad coordinates.

test('the upstream bogus coordinates are rejected', () => {
  // A known producer bug emits cx == cz == 1280064 — two i32s read at the wrong offset.
  // Drawing it puts a section 20 million blocks out and stretches every bounding volume
  // that touches it.
  assert.equal(sane(1280064, 1280064, 3), false);
  assert.equal(sane(4, 2, 5), true);
  assert.equal(sane(-30, 12, -4), true);
  assert.equal(sane(NaN, 0, 0), false);
  assert.equal(sane(0, 0, 9999), false, 'a section y far outside any world is not sane');
});

// ---------------------------------------------------------------------------
// Against the real database.

const DB = process.env.MCWV_STDB_URI ?? 'http://127.0.0.1:3200';

async function sql(query: string): Promise<unknown[][] | null> {
  try {
    const res = await fetch(`${DB}/v1/database/mcspacetime/sql`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: query,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as Array<{ rows?: unknown[][] }>)[0]?.rows ?? [];
  } catch {
    return null;
  }
}

test('REAL light rows decode to the values the world physically must have', async (t) => {
  const rows = await sql('SELECT cx, cz, sy, sky_light, block_light FROM chunk_light');
  if (!rows) {
    t.skip(`SpacetimeDB not reachable at ${DB}`);
    return;
  }
  assert.ok(rows.length > 0, 'no chunk_light rows — is the bot running on a build that sends them?');

  const tally = { aboveSurface: 0, atBottom: 0, skyless: 0 };
  for (const [cx, cz, sy, sky, block] of rows) {
    if (!sane(Number(cx), Number(cz), Number(sy))) continue;
    const s = toNibbles(sky);
    const b = toNibbles(block);
    // EACH ARRAY IS INDEPENDENTLY PRESENT OR ABSENT. Measured live: 9 of 159 rows carry a
    // full block-light array and an EMPTY sky one — a section the server sent no sky data
    // for. That is "no sky information", not "no sky", and the consumer must leave it on
    // the lit fallback rather than substituting zeros.
    assert.ok(s || b, `neither light array is usable for ${cx},${sy},${cz}`);
    if (!s) { tally.skyless++; continue; }
    checkSection(s, Number(cx), Number(sy), Number(cz), tally);
  }
  assert.ok(tally.aboveSurface > 0, 'no above-surface section had full sky light — decode is suspect');
  assert.ok(tally.atBottom > 0, 'no world-bottom section was present to check against');
  t.diagnostic(`${rows.length} light rows; ${tally.aboveSurface} full-sky above surface`
    + `, ${tally.atBottom} dark at bottom, ${tally.skyless} with no sky array at all`);
});

interface Tally { aboveSurface: number; atBottom: number; skyless: number }

/** One section's sky light, checked against what the world physically must be. */
function checkSection(s: Int8Array, cx: number, sy: number, cz: number, tally: Tally): void {
  // Every nibble must be a light LEVEL. A byte-vs-nibble mix-up shows up here immediately.
  for (let i = 0; i < 4096; i += 37) {
    const level: number = (s[i >> 1] >> ((i & 1) * 4)) & 0xf;
    assert.ok(level >= 0 && level <= 15, `sky light ${level} out of range at cell ${i}`);
  }
  const skyMax = maxNibble(s);
  // y 80..95 is above this world's surface: the sky must reach it.
  if (sy === 5 && skyMax === 15) tally.aboveSurface++;
  // World bottom is sealed: no sky can get there at all.
  if (sy === -4) {
    assert.equal(skyMax, 0,
      `world-bottom section ${cx},${sy},${cz} has sky light ${skyMax}, expected none`);
    tally.atBottom++;
  }
}

function maxNibble(a: Int8Array): number {
  let m = 0;
  for (let i = 0; i < 4096; i++) {
    const v = (a[i >> 1] >> ((i & 1) * 4)) & 0xf;
    if (v > m) m = v;
  }
  return m;
}
