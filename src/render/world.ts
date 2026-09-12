/**
 * World storage: decoded chunks addressed in world coordinates, with a single global
 * state palette so the mesher works with integers rather than strings.
 *
 * Memory matters here. A 24-section column stored densely is 24*4096*2 = 196 KB, and a
 * 32x32 region would be ~200 MB. Most sections underground are a single state, so
 * uniform sections keep their `null` index array and cost nothing — which is what makes
 * loading a whole region viable.
 */

import { decodeChunk, type DecodedChunk } from '../core/chunk.js';
import type { NbtCompound } from '../core/nbt.js';

export const AIR_ID = 0;

type Section = DecodedChunk['sections'][number];

export interface StoredSection {
  y: number;
  /** global state ids; null when the whole section is `uniform` */
  ids: Uint16Array | null;
  uniform: number;
  blockLight: Int8Array | null;
  skyLight: Int8Array | null;
  biomeIds: Uint16Array | null;
  biomeUniform: number;
}

/**
 * One live section's contents.
 *
 * An options object rather than positional arguments because light is optional and
 * meaningfully so — see the note in `addLiveSection` about null versus zero.
 */
export interface LiveSection {
  /** per-section string palette; index 0 must be air */
  palette: string[];
  /** 4096 indices into `palette` */
  indices: Uint16Array;
  /** 2048 bytes, one nibble per cell, low nibble first; omit when not known */
  blockLight?: Int8Array | null;
  skyLight?: Int8Array | null;
}

export interface ChunkColumn {
  x: number;
  z: number;
  minSection: number;
  sections: Map<number, StoredSection>;
  blockEntities: Map<number, NbtCompound>;
  /** true if any section had a state the registry could not resolve */
  status: string;
}

export function chunkKey(cx: number, cz: number): number {
  // Pack into a single number; world coords fit comfortably in 2^26 each.
  return (cx + 0x2000000) * 0x4000000 + (cz + 0x2000000);
}

export function blockEntityKey(x: number, y: number, z: number): number {
  return ((x & 15) << 12) | ((z & 15) << 8) | (y + 2048);
}

export class World {
  readonly chunks = new Map<number, ChunkColumn>();
  /** global palette: index -> state key. Index 0 is always air. */
  readonly palette: string[] = ['minecraft:air'];
  private paletteIndex = new Map<string, number>([['minecraft:air', 0]]);
  readonly biomePalette: string[] = ['minecraft:plains'];
  private biomeIndex = new Map<string, number>([['minecraft:plains', 0]]);

  minY = -64;
  maxY = 320;

  internState(key: string): number {
    let id = this.paletteIndex.get(key);
    if (id === undefined) {
      id = this.palette.length;
      this.palette.push(key);
      this.paletteIndex.set(key, id);
    }
    return id;
  }

  internBiome(key: string): number {
    let id = this.biomeIndex.get(key);
    if (id === undefined) {
      id = this.biomePalette.length;
      this.biomePalette.push(key);
      this.biomeIndex.set(key, id);
    }
    return id;
  }

  /**
   * Ingest a section straight from the live bridge, which sends a per-section string
   * palette plus Uint16 indices. Same storage as the save-file path, so the mesher and
   * registry cannot tell the two apart — which is the point: live mode reuses the whole
   * rendering pipeline unchanged.
   */
  addLiveSection(
    cx: number,
    cy: number,
    cz: number,
    section: LiveSection,
  ): ChunkColumn {
    const { palette, indices } = section;
    let col = this.chunks.get(chunkKey(cx, cz));
    if (!col) {
      col = {
        x: cx,
        z: cz,
        minSection: cy,
        sections: new Map(),
        blockEntities: new Map(),
        status: 'live',
      };
      this.chunks.set(chunkKey(cx, cz), col);
    }
    const localToGlobal = new Uint16Array(palette.length);
    for (let i = 0; i < palette.length; i++) localToGlobal[i] = this.internState(palette[i]);

    const ids = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) {
      const p = indices[i];
      ids[i] = p < localToGlobal.length ? localToGlobal[p] : AIR_ID;
    }
    col.sections.set(cy, {
      y: cy,
      ids,
      uniform: AIR_ID,
      // NULL MEANS "NOBODY HAS TOLD US", NOT "DARK".
      //
      // `getLight` reads a null sky array as 15, i.e. fully lit, which is the right fallback
      // for a section whose light has not arrived: the alternative is a world that blacks out
      // every time a chunk beats its light packet. A section the server says is genuinely
      // dark arrives as an array of ZEROES, which is a different thing and renders dark.
      blockLight: section.blockLight ?? null,
      skyLight: section.skyLight ?? null,
      biomeIds: null,
      biomeUniform: 0,
    });
    if (cy < col.minSection) col.minSection = cy;
    return col;
  }

  removeChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  addChunk(root: NbtCompound): ChunkColumn {
    const c: DecodedChunk = decodeChunk(root);
    const col: ChunkColumn = {
      x: c.x,
      z: c.z,
      minSection: c.yPos,
      sections: new Map(),
      blockEntities: new Map(),
      status: c.status,
    };

    for (const s of c.sections) {
      const { ids, uniform } = this.internSectionStates(s);
      const { biomeIds, biomeUniform } = this.internSectionBiomes(s);

      col.sections.set(s.y, {
        y: s.y,
        ids,
        uniform,
        blockLight: s.blockLight,
        skyLight: s.skyLight,
        biomeIds,
        biomeUniform,
      });
    }

    for (const be of c.blockEntities) {
      const x = be.x as number;
      const y = be.y as number;
      const z = be.z as number;
      if (typeof x === 'number') col.blockEntities.set(blockEntityKey(x, y, z), be);
    }

    this.chunks.set(chunkKey(c.x, c.z), col);
    return col;
  }

  /** Map the section's local palette into the global one once, then remap indices. */
  private internSectionStates(s: Section): { ids: Uint16Array | null; uniform: number } {
    const localToGlobal = new Uint16Array(s.palette.length);
    for (let i = 0; i < s.palette.length; i++) {
      localToGlobal[i] = this.internState(s.palette[i].key);
    }
    let ids: Uint16Array | null = null;
    const uniform = s.palette.length ? localToGlobal[0] : AIR_ID;
    if (s.blockIndices) {
      ids = new Uint16Array(4096);
      const src = s.blockIndices;
      for (let i = 0; i < 4096; i++) ids[i] = localToGlobal[src[i]];
    }
    return { ids, uniform };
  }

  /** Same remapping for the section's 4x4x4 biome grid. */
  private internSectionBiomes(
    s: Section,
  ): { biomeIds: Uint16Array | null; biomeUniform: number } {
    let biomeIds: Uint16Array | null = null;
    let biomeUniform = 0;
    if (s.biomePalette.length) {
      const bLocal = new Uint16Array(s.biomePalette.length);
      for (let i = 0; i < s.biomePalette.length; i++) {
        bLocal[i] = this.internBiome(s.biomePalette[i]);
      }
      biomeUniform = bLocal[0];
      if (s.biomeIndices) {
        biomeIds = new Uint16Array(64);
        for (let i = 0; i < 64; i++) biomeIds[i] = bLocal[s.biomeIndices[i]];
      }
    }
    return { biomeIds, biomeUniform };
  }

  getChunk(cx: number, cz: number): ChunkColumn | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** Global state id at world coords; AIR_ID outside loaded chunks. */
  getState(x: number, y: number, z: number): number {
    const col = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!col) return AIR_ID;
    const s = col.sections.get(y >> 4);
    if (!s) return AIR_ID;
    if (!s.ids) return s.uniform;
    return s.ids[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  getBiome(x: number, y: number, z: number): number {
    const col = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!col) return 0;
    const s = col.sections.get(y >> 4);
    if (!s) return 0;
    if (!s.biomeIds) return s.biomeUniform;
    return s.biomeIds[(((y & 15) >> 2) << 4) | (((z & 15) >> 2) << 2) | ((x & 15) >> 2)];
  }

  /** Packed light: low nibble block light, high nibble sky light. */
  getLight(x: number, y: number, z: number): number {
    const col = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!col) return 0xf0;
    const s = col.sections.get(y >> 4);
    if (!s) return 0xf0;
    const idx = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const block = s.blockLight ? nibble(s.blockLight, idx) : 0;
    const sky = s.skyLight ? nibble(s.skyLight, idx) : 15;
    return block | (sky << 4);
  }
}

function nibble(arr: Int8Array, i: number): number {
  const b = arr[i >> 1] & 0xff;
  return (i & 1) === 0 ? b & 0xf : b >> 4;
}
