/**
 * 1.18+ / 1.21 chunk decoding.
 *
 * Since 1.18 the chunk root has no "Level" wrapper, sections carry their own
 * paletted `block_states` / `biomes` containers, and the vertical range is driven by
 * the dimension (`yPos` = index of the lowest section, -4 for the overworld).
 *
 * Palette indices are bit-packed into longs at `bits = max(4, ceil(log2(paletteLen)))`
 * for blocks and `max(1, ceil(log2(paletteLen)))` for biomes, and — since 1.16 —
 * entries never straddle a long boundary, so `floor(64 / bits)` entries sit in each
 * long with the top bits wasted.
 */

import { LongBits, type NbtCompound, type NbtList, type NbtValue } from './nbt.js';

export interface BlockStateDef {
  /** e.g. "minecraft:oak_stairs" */
  name: string;
  /** e.g. { facing: "north", half: "bottom" } — always strings, as stored */
  properties?: Record<string, string>;
  /** canonical "name[k=v,k=v]" with properties sorted; stable identity for the audit */
  key: string;
}

export interface ChunkSection {
  /** section index; multiply by 16 for world Y of the section base */
  y: number;
  palette: BlockStateDef[];
  /** 4096 entries, index into `palette`; null when the section is a single state */
  blockIndices: Uint16Array | null;
  /** when blockIndices is null, every block is palette[0] */
  biomePalette: string[];
  biomeIndices: Uint8Array | null;
  blockLight: Int8Array | null;
  skyLight: Int8Array | null;
}

export interface DecodedChunk {
  dataVersion: number;
  x: number;
  z: number;
  /** lowest section index (overworld: -4) */
  yPos: number;
  status: string;
  sections: ChunkSection[];
  blockEntities: NbtCompound[];
  heightmaps: Record<string, LongBits>;
}

export const SECTION_VOLUME = 4096;

export function canonicalStateKey(name: string, props?: Record<string, string>): string {
  if (!props) return name;
  const keys = Object.keys(props);
  if (keys.length === 0) return name;
  keys.sort();
  let s = name + '[';
  for (let i = 0; i < keys.length; i++) {
    if (i) s += ',';
    s += keys[i] + '=' + props[keys[i]];
  }
  return s + ']';
}

function asCompound(v: NbtValue | undefined): NbtCompound | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof LongBits) &&
    !ArrayBuffer.isView(v)
    ? (v as NbtCompound)
    : undefined;
}

/** Unpack `count` entries of `bits` bits each out of a packed long array. */
export function unpack(
  data: LongBits,
  bits: number,
  count: number,
  out: Uint16Array | Uint8Array,
): void {
  const perLong = Math.floor(64 / bits);
  let i = 0;
  const longs = data.length;
  for (let l = 0; l < longs && i < count; l++) {
    for (let e = 0; e < perLong && i < count; e++, i++) {
      out[i] = data.getBitsAt(l, e * bits, bits);
    }
  }
  if (i < count) {
    throw new Error(`Packed array too short: got ${i} of ${count} entries at ${bits} bits`);
  }
}

/**
 * Bits per entry for a paletted container.
 *
 * Vanilla's `Strategy.calculateBitsForSerialization` has TWO cases and the second one is
 * silent if you miss it. Up to 256 distinct states a section uses its own palette, at
 * `ceillog2(palette length)` bits. Past 256 it is promoted to the GLOBAL palette, whose
 * width is `ceillog2(registry size)` — the data still holds block-state ids, they are just
 * written at a wider stride. A reader using only the first rule reads the right values from
 * the wrong bit offsets and produces plausible rubbish rather than an error.
 *
 * The width cannot be derived from the file. The registry size is not in it, and the `data`
 * array's length does not pin it either: 13, 14, 15 and 16 bits all pack 4096 entries into
 * 1024 longs. It has to be supplied, which is what `setRegistrySizes` is for.
 *
 * Found by the mcspacetime world downloader, which had to implement the packing side and hit
 * the rule from the other direction (2026-09-12).
 */
/**
 * Global palette widths in bits, or 0 when the registry size has not been supplied.
 *
 * Zero means "use the naive rule and count it", which is all a caller with no registry size
 * can do — and the count makes the cost visible instead of leaving it a rendering artifact
 * nobody connects to a bit width.
 */
const globalBits = { blocks: 0, biomes: 0 };

function ceilLog2(n: number): number {
  let b = 0;
  while (1 << b < n) b++;
  return b;
}

/**
 * Tell the decoder how big the game's registries are, so promoted containers can be read.
 *
 * Takes REGISTRY SIZES — the number of distinct block states (344,003 on the reference
 * server) and biomes — and stores `ceillog2` of each, because that is vanilla's formula.
 * Either may be omitted; an omitted one keeps the naive rule and keeps counting.
 */
export function setRegistrySizes(sizes: { blockStates?: number; biomes?: number }): void {
  globalBits.blocks = sizes.blockStates && sizes.blockStates > 1 ? ceilLog2(sizes.blockStates) : 0;
  globalBits.biomes = sizes.biomes && sizes.biomes > 1 ? ceilLog2(sizes.biomes) : 0;
}

/** The widths currently in effect; 0 means unset. Exposed for tests and the HUD. */
export function registryBits(): { blocks: number; biomes: number } {
  return { ...globalBits };
}

/**
 * Containers that were promoted to a global palette, and how many we could not read.
 *
 * `blocksPromoted` / `biomesPromoted` count every promoted container; the `*Unreadable`
 * counts are the subset decoded with a guessed width because no registry size was supplied.
 * Those are the ones that render as rubbish.
 *
 * `tooManyStates` is kept under its old name because the HUD reports it.
 */
export const paletteStats = {
  tooManyStates: 0,
  blocksPromoted: 0, blocksUnreadable: 0,
  biomesPromoted: 0, biomesUnreadable: 0,
};

/**
 * Vanilla's rule, for either container.
 *
 * `min` is the container's floor (4 bits for blocks, 1 for biomes) and `max` the widest the
 * container's OWN palette may be (8 for blocks, 3 for biomes). Past that the container holds
 * the same palette indices at the global palette's width.
 *
 * When no registry size has been supplied, the width is INFERRED rather than guessed — see
 * `inferBits`. That matters because there is no offline source for a modded server's
 * block-state registry size: the harness sees vanilla's 26,684 because it boots without
 * mods, and the real figure (344,003 here) lives only in the server's own tables.
 */
function containerBits(
  paletteLen: number, min: number, max: number, global: number,
  data?: LongBits, entries?: number,
): { bits: number; promoted: boolean; guessed: boolean } {
  const own = Math.max(min, ceilLog2(paletteLen));
  if (own <= max) return { bits: own, promoted: false, guessed: false };
  if (global) return { bits: global, promoted: true, guessed: false };
  const inferred = data && entries ? inferBits(data, entries, paletteLen, max) : null;
  return { bits: inferred ?? own, promoted: true, guessed: inferred === null };
}

/**
 * Work out a promoted container's width from the file itself.
 *
 * The `data` array's length narrows it: Minecraft never lets an entry straddle a long, so
 * `longs = ceil(entries / floor(64 / bits))`, and that maps several widths onto the same
 * length — 13, 14, 15 and 16 bits all pack 4096 entries into 1024 longs. It does NOT map all
 * of them together though: 17..21 bits take 1366 longs, 22..32 take 2048. So the length
 * gives a handful of candidates rather than one.
 *
 * The palette then picks between them. Every value in a promoted container is still an index
 * into the section's own palette, so a candidate width that decodes any index past the end
 * of the palette is wrong. With 4,096 entries and a palette of a few hundred, a wrong width
 * misaligns almost immediately and is rejected; only when two candidates BOTH decode cleanly
 * is the answer ambiguous, and then we decline rather than pick.
 */
export function inferBits(
  data: LongBits, entries: number, paletteLen: number, minBits: number,
): number | null {
  const longs = data.length;
  const fits: number[] = [];
  for (let bits = minBits + 1; bits <= 32; bits++) {
    const perLong = Math.floor(64 / bits);
    if (perLong && Math.ceil(entries / perLong) === longs) fits.push(bits);
  }
  const ok = fits.filter((bits) => allInPalette(data, bits, entries, paletteLen));
  return ok.length === 1 ? ok[0] : null;
}

function allInPalette(data: LongBits, bits: number, entries: number, paletteLen: number): boolean {
  const perLong = Math.floor(64 / bits);
  for (let i = 0; i < entries; i++) {
    const v = data.getBitsAt(Math.floor(i / perLong), (i % perLong) * bits, bits);
    if (v >= paletteLen) return false;
  }
  return true;
}

function readPalette(list: NbtList): BlockStateDef[] {
  const out: BlockStateDef[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as NbtCompound;
    const name = e.Name as string;
    const propsTag = asCompound(e.Properties);
    let properties: Record<string, string> | undefined;
    if (propsTag) {
      properties = {};
      for (const k in propsTag) properties[k] = String(propsTag[k]);
    }
    out[i] = { name, properties, key: canonicalStateKey(name, properties) };
  }
  return out;
}

/** The paletted `block_states` container of one section, unpacked. */
function readBlockStates(bsTag: NbtCompound | undefined): {
  palette: BlockStateDef[];
  blockIndices: Uint16Array | null;
} {
  let palette: BlockStateDef[] = [];
  let blockIndices: Uint16Array | null = null;
  if (bsTag && Array.isArray(bsTag.palette)) {
    palette = readPalette(bsTag.palette as NbtList);
    const data = bsTag.data;
    if (data instanceof LongBits && palette.length > 1) {
      // Over 256 distinct states vanilla promotes the section to the global palette and
      // writes at ITS width, not this palette's. See containerBits.
      const w = containerBits(palette.length, 4, 8, globalBits.blocks, data, SECTION_VOLUME);
      if (w.promoted) {
        paletteStats.tooManyStates++;
        paletteStats.blocksPromoted++;
        if (w.guessed) paletteStats.blocksUnreadable++;
      }
      const bits = w.bits;
      blockIndices = new Uint16Array(SECTION_VOLUME);
      unpack(data, bits, SECTION_VOLUME, blockIndices);
    }
  }
  return { palette, blockIndices };
}

/** The paletted `biomes` container of one section (4x4x4 cells, so 64 entries). */
function readBiomes(biomeTag: NbtCompound | undefined): {
  biomePalette: string[];
  biomeIndices: Uint8Array | null;
} {
  let biomePalette: string[] = [];
  let biomeIndices: Uint8Array | null = null;
  if (biomeTag && Array.isArray(biomeTag.palette)) {
    biomePalette = (biomeTag.palette as NbtList).map(String);
    const data = biomeTag.data;
    if (data instanceof LongBits && biomePalette.length > 1) {
      // The SAME promotion rule, and its threshold is far lower: a biome container's own
      // palette tops out at 3 bits, so NINE distinct biomes in one 4x4x4 container is
      // already enough to promote it. Blocks need 257.
      const w = containerBits(biomePalette.length, 1, 3, globalBits.biomes, data, 64);
      if (w.promoted) {
        paletteStats.biomesPromoted++;
        if (w.guessed) paletteStats.biomesUnreadable++;
      }
      biomeIndices = new Uint8Array(64);
      unpack(data, w.bits, 64, biomeIndices);
    }
  }
  return { biomePalette, biomeIndices };
}

/** One section, or null when it carries nothing worth keeping. */
function decodeSection(s: NbtCompound): ChunkSection | null {
  const y = s.Y as number;
  const { palette, blockIndices } = readBlockStates(asCompound(s.block_states));
  const { biomePalette, biomeIndices } = readBiomes(asCompound(s.biomes));

  // Empty sections (air-only, no light) carry no useful data; skip to keep
  // downstream loops tight, but keep single-state non-air sections (e.g. bedrock
  // fill, deep stone) because those DO need meshing.
  const isEmptyAir =
    palette.length === 1 && palette[0].name === 'minecraft:air' && !s.BlockLight && !s.SkyLight;
  if (isEmptyAir) return null;

  return {
    y,
    palette,
    blockIndices,
    biomePalette,
    biomeIndices,
    blockLight: (s.BlockLight as Int8Array) ?? null,
    skyLight: (s.SkyLight as Int8Array) ?? null,
  };
}

function decodeSections(sectionsTag: NbtList | undefined): ChunkSection[] {
  const sections: ChunkSection[] = [];
  if (sectionsTag) {
    for (const raw of sectionsTag) {
      const section = decodeSection(raw as NbtCompound);
      if (section) sections.push(section);
    }
  }
  return sections;
}

function readHeightmaps(root: NbtCompound): Record<string, LongBits> {
  const heightmaps: Record<string, LongBits> = {};
  const hm = asCompound(root.Heightmaps);
  if (hm) for (const k in hm) if (hm[k] instanceof LongBits) heightmaps[k] = hm[k] as LongBits;
  return heightmaps;
}

export function decodeChunk(root: NbtCompound): DecodedChunk {
  const dataVersion = (root.DataVersion as number) ?? 0;
  const sectionsTag = (root.sections ?? root.Sections) as NbtList | undefined;

  return {
    dataVersion,
    x: (root.xPos as number) ?? 0,
    z: (root.zPos as number) ?? 0,
    yPos: (root.yPos as number) ?? -4,
    status: (root.Status as string) ?? 'unknown',
    sections: decodeSections(sectionsTag),
    blockEntities: ((root.block_entities as NbtList) ?? []) as NbtCompound[],
    heightmaps: readHeightmaps(root),
  };
}

/** Palette index of the block at section-local (x,y,z), each 0..15. */
export function sectionBlockIndex(s: ChunkSection, x: number, y: number, z: number): number {
  if (!s.blockIndices) return 0;
  return s.blockIndices[(y << 8) | (z << 4) | x];
}
