/**
 * Anvil region (.mca) reader.
 *
 * Layout (unchanged since 1.2.1):
 *   [0,4096)     location table  — 1024 x { u24 sectorOffset, u8 sectorCount }
 *   [4096,8192)  timestamp table — 1024 x i32 epoch seconds
 *   thereafter   chunk payloads, 4096-byte aligned:
 *                  i32 length, u8 compressionType, (length-1) bytes of data
 *
 * Compression byte: 1=gzip, 2=zlib, 3=none, 4=LZ4, 127=custom (registered by mods).
 * Bit 0x80 set means the payload lives in an external `c.<x>.<z>.mcc` file and the
 * in-region payload is empty — Mojang added this for chunks exceeding 255 sectors
 * (~1 MiB), which large modded chunks genuinely hit.
 */

import { gunzipSync, unzlibSync } from 'fflate';
import { parseNbt, type NbtCompound } from './nbt.js';

export const SECTOR = 4096;

export type Compression = 'gzip' | 'zlib' | 'none' | 'lz4' | 'custom';

export interface ChunkEntry {
  /** chunk coords within the region, 0..31 */
  localX: number;
  localZ: number;
  sectorOffset: number;
  sectorCount: number;
  timestamp: number;
  external: boolean;
}

export class RegionFile {
  private view: DataView;

  constructor(
    private data: Uint8Array,
    /** region coords, parsed from the filename */
    readonly regionX = 0,
    readonly regionZ = 0,
  ) {
    if (data.byteLength && data.byteLength < SECTOR * 2) {
      throw new Error(`Region file too small (${data.byteLength} bytes)`);
    }
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  static parseName(name: string): { x: number; z: number } | null {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mc[ar]$/.exec(name.replace(/^.*[\\/]/, ''));
    return m ? { x: parseInt(m[1], 10), z: parseInt(m[2], 10) } : null;
  }

  /** All chunks with data present in this region. */
  *entries(): Generator<ChunkEntry> {
    if (!this.data.byteLength) return;
    for (let i = 0; i < 1024; i++) {
      const loc = this.view.getUint32(i * 4);
      const sectorCount = loc & 0xff;
      const sectorOffset = loc >>> 8;
      if (sectorOffset === 0 || sectorCount === 0) continue;
      yield {
        localX: i & 31,
        localZ: i >>> 5,
        sectorOffset,
        sectorCount,
        timestamp: this.view.getInt32(SECTOR + i * 4),
        external: false,
      };
    }
  }

  /** Raw (still compressed) payload for a chunk, or null if absent. */
  rawChunk(localX: number, localZ: number): { compression: Compression; data: Uint8Array } | null {
    if (!this.data.byteLength) return null;
    const idx = (localX & 31) + (localZ & 31) * 32;
    const loc = this.view.getUint32(idx * 4);
    const sectorOffset = loc >>> 8;
    const sectorCount = loc & 0xff;
    if (sectorOffset === 0 || sectorCount === 0) return null;

    const base = sectorOffset * SECTOR;
    if (base + 5 > this.data.byteLength) return null;
    const length = this.view.getInt32(base);
    const flag = this.data[base + 4];
    const external = (flag & 0x80) !== 0;
    const compression = compressionOf(flag & 0x7f);
    if (external) {
      // Caller must fetch `c.<cx>.<cz>.mcc` itself; we cannot see the filesystem here.
      throw new ExternalChunkError(
        this.regionX * 32 + (localX & 31),
        this.regionZ * 32 + (localZ & 31),
        compression,
      );
    }
    const payloadLen = length - 1;
    if (payloadLen <= 0) return null;
    return { compression, data: this.data.subarray(base + 5, base + 5 + payloadLen) };
  }

  /** Decompressed + NBT-parsed chunk, or null if the chunk is not generated. */
  chunk(localX: number, localZ: number): NbtCompound | null {
    const raw = this.rawChunk(localX, localZ);
    if (!raw) return null;
    return parseNbt(decompress(raw.data, raw.compression));
  }
}

/**
 * The 8 KB header, parsed on its own.
 *
 * The live tier polls this over an HTTP Range request rather than re-downloading whole
 * region files every few seconds: a region is 5-15 MB, the header is 8 KB, and the
 * timestamp table already says exactly which of the 1024 chunks the server rewrote. That
 * turns "re-read the world" into "fetch 8 KB, then fetch the two chunks that moved".
 *
 * `bytes` must be at least the two header sectors; anything past them is ignored, so the
 * same function reads a full region file or a Range response.
 */
export function parseRegionHeader(bytes: Uint8Array): ChunkEntry[] {
  if (bytes.byteLength < SECTOR * 2) {
    throw new Error(`Region header too small (${bytes.byteLength} bytes, need ${SECTOR * 2})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ChunkEntry[] = [];
  for (let i = 0; i < 1024; i++) {
    const loc = view.getUint32(i * 4);
    const sectorCount = loc & 0xff;
    const sectorOffset = loc >>> 8;
    if (sectorOffset === 0 || sectorCount === 0) continue;
    out.push({
      localX: i & 31,
      localZ: i >>> 5,
      sectorOffset,
      sectorCount,
      timestamp: view.getInt32(SECTOR + i * 4),
      external: false,
    });
  }
  return out;
}

/**
 * Decode one chunk from just its own sectors — the bytes at
 * `[sectorOffset * SECTOR, (sectorOffset + sectorCount) * SECTOR)` of the region file.
 *
 * Same 5-byte prefix `rawChunk` reads, split out so a Range response can be decoded
 * without the rest of the file in memory. Returns null for an absent or empty chunk;
 * throws for an externally-stored one, which the caller must fetch as `c.<x>.<z>.mcc`.
 */
export function decodeChunkPayload(
  bytes: Uint8Array,
  chunkX = 0,
  chunkZ = 0,
): NbtCompound | null {
  if (bytes.byteLength < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getInt32(0);
  const flag = bytes[4];
  const compression = compressionOf(flag & 0x7f);
  if ((flag & 0x80) !== 0) throw new ExternalChunkError(chunkX, chunkZ, compression);
  const payloadLen = length - 1;
  if (payloadLen <= 0 || 5 + payloadLen > bytes.byteLength) return null;
  return parseNbt(decompress(bytes.subarray(5, 5 + payloadLen), compression));
}

export class ExternalChunkError extends Error {
  constructor(
    readonly chunkX: number,
    readonly chunkZ: number,
    readonly compression: Compression,
  ) {
    super(`Chunk ${chunkX},${chunkZ} is stored externally (c.${chunkX}.${chunkZ}.mcc)`);
    this.name = 'ExternalChunkError';
  }
}

function compressionOf(id: number): Compression {
  switch (id) {
    case 1:
      return 'gzip';
    case 2:
      return 'zlib';
    case 3:
      return 'none';
    case 4:
      return 'lz4';
    case 127:
      return 'custom';
    default:
      throw new Error(`Unknown chunk compression id ${id}`);
  }
}

export function decompress(data: Uint8Array, compression: Compression): Uint8Array {
  switch (compression) {
    case 'none':
      return data;
    case 'zlib':
      return unzlibSync(data);
    case 'gzip':
      return gunzipSync(data);
    case 'lz4':
      return lz4DecodeFrame(data);
    case 'custom':
      // Format: u16 length-prefixed custom-codec id string, then codec-specific bytes.
      // No mod in the reference pack registers one; fail loudly rather than guess.
      throw new Error('Chunk uses a mod-registered custom compression codec (id 127)');
  }
}

/**
 * Minecraft's LZ4 chunks are NOT in the standard LZ4 frame format (magic 0x184D2204).
 * Mojang writes them with lz4-java's `LZ4BlockOutputStream`, which uses its own
 * container: a sequence of blocks, each with a 21-byte header
 *
 *   [0,8)   magic "LZ4Block"
 *   [8]     token: high nibble = compression method (0x10 = raw, 0x20 = LZ4),
 *                  low nibble  = log2(blockSize) - 10
 *   [9,13)  compressed length   (little-endian u32)
 *   [13,17) decompressed length (little-endian u32)
 *   [17,21) XXH32 checksum of the decompressed block (little-endian)
 *
 * terminated by a header whose decompressed length is 0. Off-the-shelf LZ4 packages
 * decode the *frame* format and will reject this, which is a well-known trap (it is
 * why Amulet still cannot open LZ4 saves). We parse the container ourselves and use a
 * raw-block decompressor per block. The XXH32 checksum is not verified — it would cost
 * a hash implementation for no benefit, since a corrupt chunk fails NBT parsing anyway.
 */
const LZ4_MAGIC = [0x4c, 0x5a, 0x34, 0x42, 0x6c, 0x6f, 0x63, 0x6b]; // "LZ4Block"

interface Lz4BlockHeader {
  /** high nibble of the token: 0x10 = raw, 0x20 = LZ4 */
  method: number;
  compressedLen: number;
  decompressedLen: number;
}

/** Reject the standard frame format explicitly rather than producing garbage. */
function rejectStandardLz4Frame(input: Uint8Array, dv: DataView): void {
  if (input.byteLength >= 4 && dv.getUint32(0, true) === 0x184d2204) {
    throw new Error(
      'Chunk uses standard LZ4 frame format; Minecraft writes LZ4Block. Refusing to guess.',
    );
  }
}

/** Checks the "LZ4Block" magic and reads the 21-byte block header starting at `p`. */
function readLz4BlockHeader(input: Uint8Array, dv: DataView, p: number): Lz4BlockHeader {
  for (let i = 0; i < 8; i++) {
    if (input[p + i] !== LZ4_MAGIC[i]) {
      throw new Error(`LZ4Block magic mismatch at offset ${p}`);
    }
  }
  const token = input[p + 8];
  return {
    method: token & 0xf0,
    compressedLen: dv.getUint32(p + 9, true),
    decompressedLen: dv.getUint32(p + 13, true),
  };
}

/** Decompresses one container block according to its header's compression method. */
function decodeLz4BlockBody(block: Uint8Array, method: number, decompressedLen: number): Uint8Array {
  let out: Uint8Array;
  if (method === 0x10) {
    out = block; // stored uncompressed
  } else if (method === 0x20) {
    out = lz4DecodeBlock(block, decompressedLen);
  } else {
    throw new Error(`Unknown LZ4Block compression method 0x${method.toString(16)}`);
  }
  if (out.length !== decompressedLen) {
    throw new Error(`LZ4Block length mismatch: got ${out.length}, expected ${decompressedLen}`);
  }
  return out;
}

function concatBlocks(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const result = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    result.set(part, o);
    o += part.length;
  }
  return result;
}

export function lz4DecodeFrame(input: Uint8Array): Uint8Array {
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  rejectStandardLz4Frame(input, dv);

  const parts: Uint8Array[] = [];
  let total = 0;
  let p = 0;
  while (p + 21 <= input.byteLength) {
    const { method, compressedLen, decompressedLen } = readLz4BlockHeader(input, dv, p);
    p += 21;
    if (decompressedLen === 0) break; // end marker
    const block = input.subarray(p, p + compressedLen);
    p += compressedLen;

    const out = decodeLz4BlockBody(block, method, decompressedLen);
    parts.push(out);
    total += out.length;
  }

  return concatBlocks(parts, total);
}

/** Raw LZ4 block decompression. Output size is known from the LZ4Block header. */
function lz4DecodeBlock(src: Uint8Array, outLen: number): Uint8Array {
  const dst = new Uint8Array(outLen);
  let d = 0;
  let s = 0;
  const ensure = (need: number) => {
    if (d + need > outLen) throw new Error('LZ4: output overrun');
  };
  while (s < src.length) {
    const token = src[s++];
    let literalLen = token >> 4;
    if (literalLen === 15) {
      let n: number;
      do {
        n = src[s++];
        literalLen += n;
      } while (n === 255);
    }
    ensure(literalLen);
    dst.set(src.subarray(s, s + literalLen), d);
    s += literalLen;
    d += literalLen;
    if (s >= src.length) break;

    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let n: number;
      do {
        n = src[s++];
        matchLen += n;
      } while (n === 255);
    }
    matchLen += 4;
    ensure(matchLen);
    let m = d - offset;
    if (m < 0) throw new Error('LZ4: match offset before start of output');
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }
  return d === outLen ? dst : dst.subarray(0, d);
}
