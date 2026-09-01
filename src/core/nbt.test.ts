/**
 * Tests for the two things that would silently corrupt every chunk if wrong:
 * bit-packed palette unpacking, and NBT tag decoding.
 *
 *   npm test
 *
 * The packing rule under test (Minecraft >= 1.16): entries of `bits` bits are packed
 * least-significant-first into 64-bit longs, `floor(64/bits)` per long, and an entry
 * NEVER straddles a long boundary — the remaining high bits are simply wasted. Porting
 * pre-1.16 unpacking (which did straddle) produces output that looks almost right,
 * which is the worst possible failure mode, so this is pinned down explicitly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LongBits, TagType, parseNbt } from './nbt.js';
import { unpack } from './chunk.js';

/** Pack values the way Minecraft does, then expose them as LongBits. */
function packed(values: number[], bits: number): LongBits {
  const perLong = Math.floor(64 / bits);
  const longs: bigint[] = [];
  for (let i = 0; i < values.length; i += perLong) {
    let acc = 0n;
    for (let j = 0; j < perLong && i + j < values.length; j++) {
      acc |= BigInt(values[i + j]) << BigInt(j * bits);
    }
    longs.push(acc);
  }
  const words = new Uint32Array(longs.length * 2);
  longs.forEach((v, i) => {
    words[i * 2] = Number((v >> 32n) & 0xffffffffn);
    words[i * 2 + 1] = Number(v & 0xffffffffn);
  });
  return new LongBits(words);
}

test('unpack round-trips at every bit width the format uses', () => {
  // 4 is the format's minimum; 12 covers a full 4096-entry section palette.
  for (let bits = 1; bits <= 12; bits++) {
    const max = (1 << bits) - 1;
    const values = Array.from({ length: 300 }, (_, i) => (i * 2654435761) % (max + 1));
    const out = new Uint16Array(values.length);
    unpack(packed(values, bits), bits, values.length, out);
    assert.deepEqual([...out], values, `bits=${bits}`);
  }
});

test('unpack handles entries straddling the two 32-bit halves of a long', () => {
  // bits=5 puts entry 6 at bits 30..34, i.e. across the hi/lo boundary. This is the
  // case that a naive 32-bit implementation silently gets wrong.
  const values = [1, 2, 3, 4, 5, 6, 31, 8, 9, 10, 11, 12];
  const out = new Uint16Array(values.length);
  unpack(packed(values, 5), 5, values.length, out);
  assert.deepEqual([...out], values);
});

test('unpack never lets an entry straddle a long boundary', () => {
  // bits=6 fits 10 entries per long (60 bits), wasting 4. Entry 10 must come from the
  // NEXT long starting at bit 0, not from the wasted bits.
  const values = Array.from({ length: 20 }, (_, i) => i + 40);
  const out = new Uint16Array(values.length);
  unpack(packed(values, 6), 6, values.length, out);
  assert.deepEqual([...out], values);
});

test('unpack throws rather than silently truncating a short array', () => {
  assert.throws(() => unpack(packed([1, 2, 3], 4), 4, 4096, new Uint16Array(4096)), /too short/);
});

test('NBT decodes every tag type', () => {
  // Hand-built: compound { b:Byte 7, s:Short -2, i:Int 70000, l:Long 1<<32,
  //                        f:Float 0.5, d:Double 1.5, str:String "hé",
  //                        ia:IntArray[1,-1], la:LongArray[3], list:List<Int>[1,2] }
  const parts: number[] = [];
  const push = (...b: number[]) => parts.push(...b);
  const name = (s: string) => {
    const bytes = [...Buffer.from(s, 'utf8')];
    push(0, bytes.length, ...bytes);
  };
  push(TagType.Compound);
  name(''); // root name
  push(TagType.Byte); name('b'); push(7);
  push(TagType.Short); name('s'); push(0xff, 0xfe);
  push(TagType.Int); name('i'); push(0x00, 0x01, 0x11, 0x70);
  push(TagType.Long); name('l'); push(0, 0, 0, 0x01, 0, 0, 0, 0);
  push(TagType.Float); name('f'); push(0x3f, 0x00, 0x00, 0x00);
  push(TagType.Double); name('d'); push(0x3f, 0xf8, 0, 0, 0, 0, 0, 0);
  push(TagType.String); name('str'); name('hé');
  push(TagType.IntArray); name('ia'); push(0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff);
  push(TagType.LongArray); name('la'); push(0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3);
  push(TagType.List); name('list'); push(TagType.Int, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2);
  push(TagType.End);

  const nbt = parseNbt(new Uint8Array(parts));
  assert.equal(nbt.b, 7);
  assert.equal(nbt.s, -2);
  assert.equal(nbt.i, 70000);
  assert.equal(nbt.l, 1n << 32n);
  assert.equal(nbt.f, 0.5);
  assert.equal(nbt.d, 1.5);
  assert.equal(nbt.str, 'hé');
  assert.deepEqual([...(nbt.ia as Int32Array)], [1, -1]);
  assert.equal((nbt.la as LongBits).getBigInt(0), 3n);
  assert.deepEqual(nbt.list, [1, 2]);
});
