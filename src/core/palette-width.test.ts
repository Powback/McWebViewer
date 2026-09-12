/**
 * Global-palette promotion: the rule that makes a dense section unreadable.
 *
 * Vanilla's `PalettedContainer.Strategy` has two cases. A container whose own palette fits
 * its width limit stores palette indices at `max(floor, ceillog2(len))` bits. Past that
 * limit it is PROMOTED: the same palette indices are written at the width of the game's
 * global registry instead. A reader that knows only the first case reads the right values
 * from the wrong bit offsets and produces plausible rubbish — no error, no missing block,
 * just terrain that is subtly wrong.
 *
 * The limits differ sharply and the biome one is easy to hit:
 *
 *   blocks  own palette up to 8 bits  -> promoted past 256 states
 *   biomes  own palette up to 3 bits  -> promoted past 8 biomes
 *
 * Confirmed against the mcspacetime world downloader's `block_bits`/`biome_bits`, which
 * implement the WRITING side and had to match vanilla exactly for the files to load.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  decodeChunk, paletteStats, registryBits, setRegistrySizes,
} from './chunk.js';
import { LongBits } from './nbt.js';
import type { NbtCompound } from './nbt.js';

function reset() {
  setRegistrySizes({});
  for (const k of Object.keys(paletteStats) as Array<keyof typeof paletteStats>) {
    paletteStats[k] = 0;
  }
}

/**
 * Pack `values` at `bits` each, vanilla's layout: no value straddles a long.
 *
 * `LongBits` holds each 64-bit long as a hi/lo pair of `Uint32Array` words, so this builds
 * the longs as bigints and then splits them the same way the NBT reader does.
 */
function pack(values: number[], bits: number): LongBits {
  const per = Math.floor(64 / bits);
  const n = Math.ceil(values.length / per);
  const longs = new Array<bigint>(n).fill(0n);
  for (let i = 0; i < values.length; i++) {
    const li = Math.floor(i / per);
    longs[li] |= BigInt(values[i]) << BigInt((i % per) * bits);
  }
  const words = new Uint32Array(n * 2);
  for (let i = 0; i < n; i++) {
    words[i << 1] = Number((longs[i] >> 32n) & 0xffffffffn);
    words[(i << 1) | 1] = Number(longs[i] & 0xffffffffn);
  }
  return new LongBits(words);
}

function chunkWith(palette: string[], indices: number[], bits: number): NbtCompound {
  return {
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{
      Y: 0,
      block_states: {
        palette: palette.map((name) => ({ Name: name })),
        data: pack(indices, bits),
      },
    }],
  } as unknown as NbtCompound;
}

const stateNames = (n: number) =>
  Array.from({ length: n }, (_, i) => `minecraft:stone_${i}`);

test('a small palette is read at its own width and is not promoted', () => {
  reset();
  const palette = stateNames(16); // 4 bits
  const indices = Array.from({ length: 4096 }, (_, i) => i % 16);
  const c = decodeChunk(chunkWith(palette, indices, 4));
  assert.equal(paletteStats.blocksPromoted, 0);
  const s = c.sections[0];
  assert.equal(s.palette.length, 16);
  for (let i = 0; i < 32; i++) assert.equal(s.blockIndices![i], i % 16);
});

// The bug, stated: 257 states are written at the GLOBAL width, and a reader using
// ceillog2(257) = 9 bits reads the right numbers from the wrong offsets.
test('a palette over 256 is promoted, and is read correctly only with the registry size', () => {
  const palette = stateNames(300);
  const indices = Array.from({ length: 4096 }, (_, i) => i % 300);
  // The file was WRITTEN at the global width: 344,003 states -> 19 bits.
  const written = pack(indices, 19);

  // The naive width, as the reader used to compute it: ceillog2(300) = 9 bits.
  const wrong = new Uint16Array(4096);
  {
    const perLong = Math.floor(64 / 9);
    for (let i = 0; i < 4096; i++) {
      wrong[i] = written.getBitsAt(Math.floor(i / perLong), (i % perLong) * 9, 9);
    }
  }

  reset();

  setRegistrySizes({ blockStates: 344003 });
  assert.equal(registryBits().blocks, 19, '344,003 states needs 19 bits');
  const right = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{ Y: 0, block_states: { palette: palette.map((n) => ({ Name: n })), data: written } }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.blocksPromoted, 1);
  assert.equal(paletteStats.blocksUnreadable, 0, 'readable once the size is known');

  const got = right.sections[0].blockIndices!;
  for (let i = 0; i < 512; i++) {
    assert.equal(got[i], i % 300, `cell ${i} should be state ${i % 300}`);
  }
  // And the naive read really was wrong, not merely differently right.
  let differ = 0;
  for (let i = 0; i < 4096; i++) if (wrong[i] !== got[i]) differ++;
  assert.ok(differ > 3000, `the naive width should corrupt nearly every cell, differed on ${differ}`);
});

test('exactly 256 states stays on the section palette; 257 promotes', () => {
  reset();
  const at256 = Array.from({ length: 4096 }, (_, i) => i % 256);
  decodeChunk(chunkWith(stateNames(256), at256, 8));
  assert.equal(paletteStats.blocksPromoted, 0, '256 fits in 8 bits');

  reset();
  setRegistrySizes({ blockStates: 344003 });
  const at257 = Array.from({ length: 4096 }, (_, i) => i % 257);
  decodeChunk(chunkWith(stateNames(257), at257, 19));
  assert.equal(paletteStats.blocksPromoted, 1, '257 does not');
});

// ---------------------------------------------------------------------------
// Biomes — the same rule with a threshold 32x lower.

function chunkWithBiomes(palette: string[], indices: number[], bits: number): NbtCompound {
  return {
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{
      Y: 0,
      block_states: { palette: [{ Name: 'minecraft:stone' }] },
      biomes: { palette, data: pack(indices, bits) },
    }],
  } as unknown as NbtCompound;
}

const biomeNames = (n: number) => Array.from({ length: n }, (_, i) => `minecraft:biome_${i}`);

test('eight biomes fit the container; nine are promoted', () => {
  reset();
  decodeChunk(chunkWithBiomes(biomeNames(8), Array.from({ length: 64 }, (_, i) => i % 8), 3));
  assert.equal(paletteStats.biomesPromoted, 0, '8 biomes fit in 3 bits');

  reset();
  decodeChunk(chunkWithBiomes(biomeNames(9), Array.from({ length: 64 }, (_, i) => i % 9), 8));
  assert.equal(paletteStats.biomesPromoted, 1, 'the ninth promotes the container');
  assert.equal(paletteStats.biomesUnreadable, 0, 'and its width is inferred from the file');
});

test('a promoted biome container reads correctly once the biome registry size is known', () => {
  const idx = Array.from({ length: 64 }, (_, i) => i % 12);
  const written = pack(idx, 8); // 200 biomes -> 8 bits
  reset();
  setRegistrySizes({ biomes: 200 });
  assert.equal(registryBits().biomes, 8);
  const c = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{
      Y: 0,
      block_states: { palette: [{ Name: 'minecraft:stone' }] },
      biomes: { palette: biomeNames(12), data: written },
    }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.biomesUnreadable, 0);
  const got = c.sections[0].biomeIndices!;
  for (let i = 0; i < 64; i++) assert.equal(got[i], i % 12, `biome cell ${i}`);
});

test('the two registries are set independently', () => {
  reset();
  setRegistrySizes({ blockStates: 344003 });
  assert.deepEqual(registryBits(), { blocks: 19, biomes: 0 });
  setRegistrySizes({ biomes: 200 });
  assert.deepEqual(registryBits(), { blocks: 0, biomes: 8 }, 'setting one clears the other');
  setRegistrySizes({ blockStates: 344003, biomes: 200 });
  assert.deepEqual(registryBits(), { blocks: 19, biomes: 8 });
});

test('a nonsense registry size is refused rather than producing a nonsense width', () => {
  reset();
  setRegistrySizes({ blockStates: 0 });
  assert.equal(registryBits().blocks, 0);
  setRegistrySizes({ blockStates: Number.NaN });
  assert.equal(registryBits().blocks, 0);
  setRegistrySizes({ blockStates: -5 });
  assert.equal(registryBits().blocks, 0);
});

test('a single-state section carries no data and is not mistaken for a promotion', () => {
  reset();
  const c = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:stone' }] } }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.blocksPromoted, 0);
  assert.equal(c.sections[0].blockIndices, null, 'every cell is palette[0]');
});

// ---------------------------------------------------------------------------
// Inferring the width when nobody can supply the registry size.
//
// This is the half that makes the fix usable. There is no offline source for a MODDED
// server's block-state registry size — the extraction harness boots without mods and sees
// vanilla's 26,684, while the real figure here is 344,003 and lives only in the server's own
// tables. So a reader that needs the number told to it stays broken on exactly the worlds
// that trip the rule.

import { inferBits } from './chunk.js';

test('the data length alone narrows the width to a handful of candidates', () => {
  // 13..16 bits all pack 4096 entries into 1024 longs; 17..21 into 1366. A reader cannot
  // tell them apart by length, which is why the palette check below is needed.
  const width = (bits: number) => Math.ceil(4096 / Math.floor(64 / bits));
  assert.equal(width(13), width(16), '13 and 16 are indistinguishable by length');
  assert.equal(width(17), width(21));
  assert.notEqual(width(16), width(17), 'but 16 and 17 are not');
});

test('the palette bound picks the right candidate out of those', () => {
  const indices = Array.from({ length: 4096 }, (_, i) => i % 300);
  const data = pack(indices, 19);
  const bits = inferBits(data, 4096, 300, 8);
  assert.equal(bits, 19, 'only 19 decodes every index inside a 300-entry palette');
});

test('an inferred width reads the section correctly with no registry size at all', () => {
  const palette = stateNames(300);
  const indices = Array.from({ length: 4096 }, (_, i) => i % 300);
  reset(); // deliberately no setRegistrySizes
  const c = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{ Y: 0, block_states: { palette: palette.map((n) => ({ Name: n })), data: pack(indices, 19) } }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.blocksPromoted, 1);
  assert.equal(paletteStats.blocksUnreadable, 0, 'inferred, so not counted as unreadable');
  const got = c.sections[0].blockIndices!;
  for (let i = 0; i < 1024; i++) assert.equal(got[i], i % 300, `cell ${i}`);
});

test('a supplied registry size is preferred over inference', () => {
  const indices = Array.from({ length: 4096 }, (_, i) => i % 300);
  reset();
  setRegistrySizes({ blockStates: 344003 });
  const c = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{ Y: 0, block_states: { palette: stateNames(300).map((n) => ({ Name: n })), data: pack(indices, 19) } }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.blocksUnreadable, 0);
  assert.equal(c.sections[0].blockIndices![5], 5);
});

// Declining is the right answer when the file cannot settle it: a wrong width is corruption
// that looks like terrain, and saying "unreadable" at least shows up in the counter.
test('an ambiguous container is declined rather than guessed at', () => {
  // A palette of 2^17 entries makes 17..21 bits all decode in range, so nothing distinguishes
  // them and inference must refuse.
  const indices = Array.from({ length: 4096 }, () => 0);
  const data = pack(indices, 19);
  assert.equal(inferBits(data, 4096, 200000, 8), null, 'all-zero data fits every candidate');
});

test('biome containers are inferred the same way', () => {
  const idx = Array.from({ length: 64 }, (_, i) => i % 12);
  reset();
  const c = decodeChunk({
    DataVersion: 3953, xPos: 0, zPos: 0, yPos: 0,
    sections: [{
      Y: 0,
      block_states: { palette: [{ Name: 'minecraft:stone' }] },
      biomes: { palette: biomeNames(12), data: pack(idx, 8) },
    }],
  } as unknown as NbtCompound);
  assert.equal(paletteStats.biomesPromoted, 1);
  assert.equal(paletteStats.biomesUnreadable, 0, 'inferred without a biome registry size');
  const got = c.sections[0].biomeIndices!;
  for (let i = 0; i < 64; i++) assert.equal(got[i], i % 12, `biome ${i}`);
});
