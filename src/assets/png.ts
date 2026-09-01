/**
 * Minimal PNG alpha inspector.
 *
 * We do not need pixels — we need to know whether a sprite is fully opaque, uses only
 * binary (0 or 255) alpha, or has genuine partial alpha. That single fact replaces two
 * things that are otherwise hardcoded name tables:
 *
 *   - the render layer (solid / cutout / translucent). Vanilla resolves this in Java
 *     (`ItemBlockRenderTypes`) and ships no data file for it, but the distinction is
 *     precisely "does this texture have alpha, and is it binary" — which the PNG itself
 *     answers. Deriving it means modded blocks get the right layer with no per-mod table.
 *   - whether a full cube actually occludes its neighbours. Glass is geometrically a
 *     full cube but must not cull; that follows from its texture having alpha.
 *
 * Runs identically in Node and the browser (fflate only), so the headless audit and the
 * renderer cannot disagree.
 */

import { unzlibSync, zlibSync } from 'fflate';

export type AlphaClass = 'opaque' | 'binary' | 'partial';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** Channels per pixel for each PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function classifyAlpha(png: Uint8Array): AlphaClass {
  if (!hasPngMagic(png)) return 'opaque';

  const chunks = readChunks(png);
  const ihdrRaw = chunks.get('IHDR');
  if (!ihdrRaw) return 'opaque';
  const ihdr = parseIhdr(ihdrRaw);

  // Colour types 0 (grey) and 2 (RGB) carry no alpha channel; without a tRNS chunk they
  // are opaque by definition and need no decoding at all — which is most terrain.
  const hasAlphaChannel = ihdr.colorType === 4 || ihdr.colorType === 6;
  const trns = chunks.get('tRNS');
  if (!hasAlphaChannel) return trns ? classifyTrns(trns) : 'opaque';

  // Interlaced PNGs would need Adam7 deinterlacing; Minecraft ships none, and guessing
  // would be worse than declining, so treat as opaque and let the model JSON decide.
  if (ihdr.interlace !== 0 || ihdr.bitDepth !== 8) return 'opaque';

  const raw = inflateIdat(png);
  if (!raw) return 'opaque';
  return scanAlpha(raw, ihdr);
}

/** The 8-byte PNG signature. Anything else is not a PNG we can reason about. */
function hasPngMagic(png: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_MAGIC[i]) return false;
  return true;
}

/** The concatenated IDAT stream, inflated; null when absent or not decodable. */
function inflateIdat(png: Uint8Array): Uint8Array | null {
  const idat = concatChunks(png, 'IDAT');
  if (!idat) return null;
  try {
    return unzlibSync(idat);
  } catch {
    return null;
  }
}

function parseIhdr(d: Uint8Array): Ihdr {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    width: dv.getUint32(0),
    height: dv.getUint32(4),
    bitDepth: d[8],
    colorType: d[9],
    interlace: d[12],
  };
}

function classifyTrns(trns: Uint8Array): AlphaClass {
  // Palette transparency: any entry strictly between 0 and 255 means partial alpha.
  let sawTransparent = false;
  for (const a of trns) {
    if (a > 0 && a < 255) return 'partial';
    if (a === 0) sawTransparent = true;
  }
  return sawTransparent ? 'binary' : 'opaque';
}

/** Un-filters each scanline and records the alpha extremes. */
function scanAlpha(raw: Uint8Array, ihdr: Ihdr): AlphaClass {
  const channels = CHANNELS[ihdr.colorType] ?? 4;
  const bpp = channels; // bitDepth 8 only
  const stride = ihdr.width * bpp;
  const alphaOffset = bpp - 1; // alpha is the last channel for types 4 and 6

  let sawZero = false;
  let sawMid = false;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;

  for (let y = 0; y < ihdr.height; y++) {
    if (p >= raw.length) break;
    const filter = raw[p++];
    cur.set(raw.subarray(p, p + stride));
    p += stride;
    unfilter(cur, prev, filter, bpp, stride);

    for (let x = alphaOffset; x < stride; x += bpp) {
      const a = cur[x];
      if (a === 0) sawZero = true;
      else if (a !== 255) {
        sawMid = true;
        break;
      }
    }
    if (sawMid) return 'partial';
    prev.set(cur);
  }
  return sawZero ? 'binary' : 'opaque';
}

/** PNG scanline filters 0-4, in place. */
function unfilter(
  cur: Uint8Array,
  prev: Uint8Array,
  filter: number,
  bpp: number,
  stride: number,
): void {
  if (filter === 0) return;
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    cur[i] = (cur[i] + filterAddend(filter, a, b, c)) & 0xff;
  }
}

function filterAddend(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readChunks(png: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const start = p + 8;
    if (start + len > png.length) break;
    if (!out.has(type)) out.set(type, png.subarray(start, start + len));
    if (type === 'IEND') break;
    p = start + len + 4;
  }
  return out;
}

/** IDAT may be split across several chunks that must be concatenated before inflate. */
function concatChunks(png: Uint8Array, type: string): Uint8Array | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [];
  let total = 0;
  let p = 8;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const t = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const start = p + 8;
    if (start + len > png.length) break;
    if (t === type) {
      parts.push(png.subarray(start, start + len));
      total += len;
    }
    if (t === 'IEND') break;
    p = start + len + 4;
  }
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ full decode/encode */

/**
 * Decode to straight RGBA.
 *
 * Added so the texture atlas can be built on the SERVER. The browser gets this for free
 * from `createImageBitmap` plus a canvas, but neither exists in Node, and baking the atlas
 * server-side is what removes a ~476 MB jar download from every page load.
 *
 * Covers what Minecraft actually ships: 8-bit greyscale, RGB, palette, grey+alpha and
 * RGBA, non-interlaced. Adam7 is declined rather than guessed — no vanilla or modded
 * sprite in the reference set uses it, and a wrong deinterlace is worse than a miss.
 */
export interface DecodedImage {
  width: number;
  height: number;
  /** width * height * 4, non-premultiplied */
  data: Uint8Array;
}

export function decodeRgba(png: Uint8Array): DecodedImage | null {
  if (!hasPngMagic(png)) return null;
  const chunks = readChunks(png);
  const ihdrRaw = chunks.get('IHDR');
  if (!ihdrRaw) return null;
  const ihdr = parseIhdr(ihdrRaw);
  // Adam7 is declined rather than guessed; no sprite in the reference set uses it.
  if (ihdr.interlace !== 0) return null;
  if (![1, 2, 4, 8, 16].includes(ihdr.bitDepth)) return null;
  const raw = inflateIdat(png);
  if (!raw) return null;
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) return null;

  const unfiltered = unfilterImage(raw, ihdr, channels);
  if (!unfiltered) return null;
  const samples = toSamples(unfiltered, ihdr, channels);
  const data = toRgba(samples, ihdr, channels, chunks);
  return data ? { width: ihdr.width, height: ihdr.height, data } : null;
}

/** Bytes per scanline, which for sub-byte depths is not width * channels. */
function scanlineBytes(ihdr: Ihdr, channels: number): number {
  return Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8);
}

/**
 * Un-filter every scanline.
 *
 * Filtering operates on BYTES, and its `bpp` is the byte distance between neighbouring
 * pixels — which the spec floors at 1 for depths below 8. Using width*channels here (the
 * 8-bit assumption) silently corrupts every 1/2/4-bit image, and Minecraft ships a great
 * many 4-bit paletted textures.
 */
function unfilterImage(raw: Uint8Array, ihdr: Ihdr, channels: number): Uint8Array | null {
  const stride = scanlineBytes(ihdr, channels);
  const bpp = Math.max(1, Math.ceil((channels * ihdr.bitDepth) / 8));
  const out = new Uint8Array(stride * ihdr.height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < ihdr.height; y++) {
    if (p + 1 + stride > raw.length) return null;
    const filter = raw[p++];
    cur.set(raw.subarray(p, p + stride));
    p += stride;
    unfilter(cur, prev, filter, bpp, stride);
    out.set(cur, y * stride);
    prev.set(cur);
  }
  return out;
}

/**
 * Expand packed scanlines into one byte per sample.
 *
 * Palette indices must NOT be scaled — they are look-up keys, not intensities — whereas
 * sub-byte greyscale must be scaled to 0..255. Conflating the two turns a 4-bit paletted
 * texture into noise.
 */
function toSamples(unfiltered: Uint8Array, ihdr: Ihdr, channels: number): Uint8Array {
  const { bitDepth, width, height } = ihdr;
  if (bitDepth === 8) return unfiltered;
  const out = new Uint8Array(width * height * channels);
  const stride = scanlineBytes(ihdr, channels);

  if (bitDepth === 16) {
    // Take the high byte; 16-bit precision is not useful for a block atlas.
    for (let i = 0; i < out.length; i++) out[i] = unfiltered[i * 2];
    return out;
  }

  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  const scale = ihdr.colorType === 3 ? 1 : 255 / mask;
  for (let y = 0; y < height; y++) {
    const rowIn = y * stride;
    const rowOut = y * width * channels;
    for (let i = 0; i < width * channels; i++) {
      const byte = unfiltered[rowIn + Math.floor(i / perByte)];
      const shift = 8 - bitDepth * ((i % perByte) + 1);
      out[rowOut + i] = ((byte >> shift) & mask) * scale;
    }
  }
  return out;
}

function toRgba(
  samples: Uint8Array,
  ihdr: Ihdr,
  channels: number,
  chunks: Map<string, Uint8Array>,
): Uint8Array | null {
  const n = ihdr.width * ihdr.height;
  const out = new Uint8Array(n * 4);
  if (ihdr.colorType === 3) return palettedToRgba(samples, n, chunks, out);
  for (let i = 0; i < n; i++) expandPixel(samples, i, channels, ihdr.colorType, out);
  return out;
}

function expandPixel(
  s: Uint8Array,
  i: number,
  channels: number,
  colorType: number,
  out: Uint8Array,
): void {
  const si = i * channels;
  const oi = i * 4;
  if (colorType === 0 || colorType === 4) {
    // greyscale, optionally with alpha
    out[oi] = out[oi + 1] = out[oi + 2] = s[si];
    out[oi + 3] = colorType === 4 ? s[si + 1] : 255;
    return;
  }
  out[oi] = s[si];
  out[oi + 1] = s[si + 1];
  out[oi + 2] = s[si + 2];
  out[oi + 3] = colorType === 6 ? s[si + 3] : 255;
}

function palettedToRgba(
  indices: Uint8Array,
  n: number,
  chunks: Map<string, Uint8Array>,
  out: Uint8Array,
): Uint8Array | null {
  const plte = chunks.get('PLTE');
  if (!plte) return null;
  const trns = chunks.get('tRNS');
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const p = idx * 3;
    out[i * 4] = plte[p];
    out[i * 4 + 1] = plte[p + 1];
    out[i * 4 + 2] = plte[p + 2];
    out[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
  }
  return out;
}

/**
 * Encode straight RGBA as a PNG.
 *
 * Filter 0 on every scanline: the atlas is mostly hard-edged 16x16 pixel art where the
 * adaptive filters buy little, and deflate does the real work. Keeping it trivial keeps
 * this dependency-free alongside the decoder.
 */
export function encodeRgba(img: DecodedImage): Uint8Array {
  const stride = img.width * 4;
  const rawSize = (stride + 1) * img.height;
  const raw = new Uint8Array(rawSize);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.width);
  dv.setUint32(4, img.height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return concatPng([
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function concatPng(chunks: Uint8Array[]): Uint8Array {
  let total = 8;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set(PNG_MAGIC, 0);
  let o = 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
