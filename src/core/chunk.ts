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

function bitsFor(paletteLen: number, min: number): number {
  let b = min;
  while (1 << b < paletteLen) b++;
  return b;
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
      const bits = bitsFor(palette.length, 4);
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
      const bits = bitsFor(biomePalette.length, 1);
      biomeIndices = new Uint8Array(64);
      unpack(data, bits, 64, biomeIndices);
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
