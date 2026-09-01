/**
 * NBT reader — isomorphic (browser + node), zero dependencies.
 *
 * Design notes:
 *  - TAG_Long_Array is the hot path (block-state / biome palette indices). Decoding
 *    those to BigInt is ~10x slower than we can afford, so long arrays are exposed as
 *    a Uint32Array of [hi, lo] pairs and unpacked with 32-bit integer math in
 *    `LongBits`. Scalar TAG_Long is still returned as bigint (rare, and correctness
 *    matters there — e.g. world seeds, UUIDs).
 *  - Strings are Java "modified UTF-8". Almost every string in a Minecraft save is
 *    pure ASCII, so we take a fast path and only fall back to the full decoder when a
 *    high bit is seen.
 */

export const enum TagType {
  End = 0,
  Byte = 1,
  Short = 2,
  Int = 3,
  Long = 4,
  Float = 5,
  Double = 6,
  ByteArray = 7,
  String = 8,
  List = 9,
  Compound = 10,
  IntArray = 11,
  LongArray = 12,
}

/**
 * A TAG_Long_Array kept as raw 32-bit halves: `words[2n]` = high half of long n,
 * `words[2n+1]` = low half. Length in longs is `words.length / 2`.
 */
const POW2: number[] = Array.from({ length: 33 }, (_, i) => Math.pow(2, i));

export class LongBits {
  constructor(readonly words: Uint32Array) {}

  get length(): number {
    return this.words.length >>> 1;
  }

  /** The n-th long as a bigint. Only for cold paths (seeds, timestamps). */
  getBigInt(n: number): bigint {
    const hi = this.words[n << 1];
    const lo = this.words[(n << 1) | 1];
    return (BigInt(hi | 0) << 32n) | BigInt(lo >>> 0);
  }

  /**
   * Extract `bits` bits starting at bit `start` (LSB=0) of long `n`.
   * Requires bits <= 32. Handles entries straddling the 32-bit halves.
   *
   * Minecraft >=1.16 never lets an entry straddle a *long* boundary, so callers
   * index per-long; but an entry can still straddle the two 32-bit halves.
   */
  getBitsAt(n: number, start: number, bits: number): number {
    const i = n << 1;
    const hi = this.words[i];
    const lo = this.words[i | 1];
    const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    const end = start + bits;
    if (end <= 32) {
      return (lo >>> start) & mask;
    }
    if (start >= 32) {
      return (hi >>> (start - 32)) & mask;
    }
    // Straddles the two 32-bit halves: low bits from `lo`, high bits from `hi`.
    // Uses float multiply rather than `<<` so a 32-bit result cannot go negative.
    const lowCount = 32 - start;
    const low = lo >>> start;
    const high = hi & ((1 << (bits - lowCount)) - 1);
    return low + high * POW2[lowCount];
  }
}

export type NbtValue =
  | number
  | bigint
  | string
  | Int8Array
  | Int32Array
  | LongBits
  | NbtList
  | NbtCompound;

export type NbtList = NbtValue[];
export interface NbtCompound {
  [key: string]: NbtValue;
}

const ASCII_LIMIT = 0x7f;

export class NbtReader {
  private view: DataView;
  private bytes: Uint8Array;
  private off = 0;
  private textDecoder: TextDecoder | null = null;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get offset(): number {
    return this.off;
  }

  u8(): number {
    return this.bytes[this.off++];
  }
  i8(): number {
    return this.view.getInt8(this.off++);
  }
  i16(): number {
    const v = this.view.getInt16(this.off);
    this.off += 2;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off);
    this.off += 2;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.off);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off);
    this.off += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.off);
    this.off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.off);
    this.off += 8;
    return v;
  }

  string(): string {
    const len = this.u16();
    const start = this.off;
    const end = start + len;
    const b = this.bytes;
    // Fast ASCII path — covers essentially every key and resource location.
    let ascii = true;
    for (let i = start; i < end; i++) {
      if (b[i] > ASCII_LIMIT) {
        ascii = false;
        break;
      }
    }
    this.off = end;
    if (ascii) {
      // String.fromCharCode in chunks avoids arg-count limits on long strings.
      if (len < 64) {
        let s = '';
        for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
        return s;
      }
      if (!this.textDecoder) this.textDecoder = new TextDecoder('utf-8');
      return this.textDecoder.decode(b.subarray(start, end));
    }
    return decodeModifiedUtf8(b, start, len);
  }

  /** Reads a payload of the given tag type. */
  payload(type: TagType): NbtValue {
    switch (type) {
      case TagType.Byte:
        return this.i8();
      case TagType.Short:
        return this.i16();
      case TagType.Int:
        return this.i32();
      case TagType.Long:
        return this.i64();
      case TagType.Float:
        return this.f32();
      case TagType.Double:
        return this.f64();
      case TagType.String:
        return this.string();
      default:
        return this.compoundOrArrayPayload(type);
    }
  }

  /**
   * The tag types whose payload is a length-prefixed run or a nested structure, i.e.
   * everything that needs its own read loop rather than a single fixed-width read.
   * All of these keep advancing the same `this.off` cursor, so reads stay in order.
   */
  private compoundOrArrayPayload(type: TagType): NbtValue {
    switch (type) {
      case TagType.ByteArray:
        return this.byteArray();
      case TagType.List:
        return this.list();
      case TagType.Compound:
        return this.compound();
      case TagType.IntArray:
        return this.intArray();
      case TagType.LongArray:
        return this.longArray();
      default:
        throw new Error(`NBT: unknown tag type ${type} at offset ${this.off}`);
    }
  }

  private byteArray(): Int8Array {
    const n = this.i32();
    const out = new Int8Array(n);
    out.set(new Int8Array(this.bytes.buffer, this.bytes.byteOffset + this.off, n));
    this.off += n;
    return out;
  }

  private list(): NbtList {
    const elem = this.u8() as TagType;
    const n = this.i32();
    const out: NbtValue[] = new Array(n < 0 ? 0 : n);
    if (elem === TagType.End) {
      // A zero-length list is written with element type End; anything else is malformed.
      return [];
    }
    for (let i = 0; i < n; i++) out[i] = this.payload(elem);
    return out;
  }

  private compound(): NbtCompound {
    const out: NbtCompound = {};
    for (;;) {
      const t = this.u8() as TagType;
      if (t === TagType.End) break;
      const name = this.string();
      out[name] = this.payload(t);
    }
    return out;
  }

  private intArray(): Int32Array {
    const n = this.i32();
    const out = new Int32Array(n);
    const dv = this.view;
    let o = this.off;
    for (let i = 0; i < n; i++, o += 4) out[i] = dv.getInt32(o);
    this.off = o;
    return out;
  }

  private longArray(): LongBits {
    const n = this.i32();
    const words = new Uint32Array(n * 2);
    const dv = this.view;
    let o = this.off;
    for (let i = 0; i < n; i++, o += 8) {
      words[i * 2] = dv.getUint32(o);
      words[i * 2 + 1] = dv.getUint32(o + 4);
    }
    this.off = o;
    return new LongBits(words);
  }

  /** Reads a root tag (type byte + name + payload). Returns the payload. */
  root(): NbtValue {
    const t = this.u8() as TagType;
    if (t === TagType.End) return {};
    this.string(); // root name, conventionally ""
    return this.payload(t);
  }
}

/** Java modified UTF-8: 0x00 encoded as 0xC0 0x80, supplementary chars as surrogate pairs. */
function decodeModifiedUtf8(b: Uint8Array, start: number, len: number): string {
  let out = '';
  let i = start;
  const end = start + len;
  while (i < end) {
    const c = b[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if ((c & 0xe0) === 0xc0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if ((c & 0xf0) === 0xe0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    } else {
      throw new Error('NBT: malformed modified UTF-8');
    }
  }
  return out;
}

/** Parse a complete uncompressed NBT buffer. */
export function parseNbt(data: Uint8Array): NbtCompound {
  return new NbtReader(data).root() as NbtCompound;
}
