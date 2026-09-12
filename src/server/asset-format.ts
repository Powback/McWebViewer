/**
 * Wire format for baked assets, shared by the bake tool and the browser.
 *
 * Kept deliberately boring — JSON, gzipped by the server — because the win here is not the
 * encoding, it is not shipping 476 MB of jars. Two cheap things are done anyway because
 * they are nearly free:
 *
 *  - sprite ids are interned into a table, since every quad names one and the strings
 *    otherwise dominate the payload;
 *  - coordinates are rounded to 4 decimals. Block-space positions and UVs are both in
 *    0..1 and no model in the reference set carries meaningful precision past that, so
 *    this is lossless in practice and roughly halves the number text.
 *
 * The decoded result is exactly `RenderableState`, so everything downstream — mesher,
 * registry lookups, the coverage audit — is unchanged and cannot tell the two paths apart.
 */

import type { BakedQuad, Direction, RenderType } from '../assets/model.js';
import type { RenderableState, TintSource } from '../render/registry.js';
import type { SpriteRect } from '../render/atlas.js';

export const DIRECTIONS: readonly Direction[] = [
  'down', 'up', 'north', 'south', 'west', 'east',
];

const RENDER_TYPES: readonly RenderType[] = ['solid', 'cutout', 'translucent'];

export interface SerialisedQuad {
  /** 12 floats: 4 vertices x xyz, block space */
  p: number[];
  /** 8 floats: 4 vertices x uv, sprite-local */
  uv: number[];
  /** index into BakedAssets.textures */
  t: number;
  /** cullface direction index, -1 for none */
  cf: number;
  /** geometric facing index */
  f: number;
  /** tintindex, -1 for untinted */
  ti: number;
  /** 1 when the quad takes vanilla directional shading */
  sh: number;
  n: number[];
}

export interface SerialisedState {
  q: SerialisedQuad[];
  /** index into RENDER_TYPES */
  rt: number;
  /** opaqueFullCube */
  o: number;
  ao: number;
  /** tintSource: -1 none, 0 grass, 1 foliage, 2 water */
  ts: number;
  /** provenance, for the coverage audit */
  pv: string;
  le: number;
  cl?: number;
}

export interface BakedAssets {
  version: number;
  generated: string;
  textures: string[];
  atlas: {
    width: number;
    height: number;
    sprites: Record<string, SpriteRect>;
  };
  states: Record<string, SerialisedState>;
  biomes: Record<string, {
    grass: [number, number, number];
    foliage: [number, number, number];
    water: [number, number, number];
  }>;
  regions: string[];
  /** block names the world had block entities for at bake time (painted-surface rule) */
  blockEntityBlocks?: string[];
  unresolved: string[];
  missingSprites: string[];
  /**
   * The entity types the bake collected sprites for. The baker's staleness check needs
   * them, because nothing else in the bundle says which mobs it can draw. Optional so a
   * bundle from before the field is still readable — it is treated as stale once.
   */
  entityTypes?: string[];
  /**
   * Datapack-driven entity variants, as `<registry>` -> `<id>` -> the variant's own JSON.
   * Currently `wolf_variant`, whose entries name the wild / tame / angry coat texture.
   *
   * Baked rather than read at runtime because the browser has no packs — a served world is
   * the bundle and the atlas, nothing else. And it cannot be derived from the variant name:
   * `minecraft:pale`'s wild texture is `entity/wolf/wolf`, not `wolf_pale`, so the obvious
   * convention breaks on vanilla's own default before any mod gets involved.
   *
   * Optional, like `entityTypes`: a bundle written before this field still loads, it just
   * draws every wolf in the pale coat as before.
   */
  entityVariants?: Record<string, Record<string, Record<string, unknown>>>;
  /**
   * Sizes of the game's registries, for the paletted-container promotion rule.
   *
   * A section whose own palette outgrows its width limit is written at the GLOBAL palette's
   * width instead, and that width is `ceillog2(registry size)` — a number that is nowhere in
   * the save file. See `core/chunk.ts`. `biomes` is counted from the packs' own
   * `worldgen/biome` definitions; `blockStates` has no offline source in bridge mode and is
   * usually absent, which `paletteStats` then counts rather than hides.
   */
  registrySizes?: { blockStates?: number; biomes?: number };
  /**
   * Every entity type's collision box, extracted from the running game.
   *
   * A spawner scales the mob in its cage by `0.53125 / max(w, h)` when that exceeds 1, so
   * drawing it at the right size needs the real box rather than the model's drawn extent.
   * Travels in the bundle because it is asset-shaped data the renderer needs per frame.
   */
  entitySizes?: Record<string, { w: number; h: number }>;
  /**
   * Hash of atlas.png as written next to this JSON. The client fetches the PNG as
   * `atlas.png?v=<hash>`, so a bundle and its atlas can never be paired across a re-bake
   * by an HTTP cache that expired one and not the other — sprite rects move between bakes.
   */
  atlasHash?: string;
}

function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roundAll(a: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(r4(a[i]));
  return out;
}

class TextureTable {
  private index = new Map<string, number>();
  readonly list: string[] = [];

  intern(id: string): number {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(id);
      this.index.set(id, i);
    }
    return i;
  }
}

export interface SerialisedBundle {
  states: Record<string, SerialisedState>;
  textures: string[];
}

export function serialiseAll(
  states: ReadonlyMap<string, RenderableState>,
): SerialisedBundle {
  const textures = new TextureTable();
  const out: Record<string, SerialisedState> = {};
  for (const [key, s] of states) out[key] = serialiseState(s, textures);
  return { states: out, textures: textures.list };
}

function serialiseState(s: RenderableState, textures: TextureTable): SerialisedState {
  return {
    q: s.quads.map((q) => serialiseQuad(q, textures)),
    rt: RENDER_TYPES.indexOf(s.renderType),
    o: s.opaqueFullCube ? 1 : 0,
    ao: s.ambientOcclusion ? 1 : 0,
    ts: s.tintSource,
    pv: s.provenance,
    le: s.lightEmission,
    ...(s.usedCustomLoader ? { cl: 1 } : {}),
  };
}

function serialiseQuad(q: BakedQuad, textures: TextureTable): SerialisedQuad {
  return {
    p: roundAll(q.positions),
    uv: roundAll(q.uvs),
    t: textures.intern(q.texture),
    cf: q.cullface ? DIRECTIONS.indexOf(q.cullface) : -1,
    f: DIRECTIONS.indexOf(q.facing),
    ti: q.tintIndex,
    sh: q.shade ? 1 : 0,
    n: roundAll(q.normal),
  };
}

/* ------------------------------------------------------------------ decode */

export function deserialiseState(
  key: string,
  s: SerialisedState,
  textures: readonly string[],
): RenderableState {
  const { name, props } = splitKey(key);
  return {
    key,
    name,
    props,
    quads: s.q.map((q) => deserialiseQuad(q, textures)),
    renderType: RENDER_TYPES[s.rt] ?? 'solid',
    opaqueFullCube: s.o === 1,
    ambientOcclusion: s.ao === 1,
    tintSource: s.ts as TintSource,
    provenance: s.pv as RenderableState['provenance'],
    lightEmission: s.le,
    usedCustomLoader: s.cl === 1,
  };
}

function deserialiseQuad(q: SerialisedQuad, textures: readonly string[]): BakedQuad {
  return {
    positions: new Float32Array(q.p),
    uvs: new Float32Array(q.uv),
    texture: textures[q.t] ?? '',
    cullface: q.cf >= 0 ? DIRECTIONS[q.cf] : null,
    facing: DIRECTIONS[q.f] ?? 'up',
    tintIndex: q.ti,
    shade: q.sh === 1,
    normal: [q.n[0], q.n[1], q.n[2]],
  };
}

/** Same split as registry.splitStateKey, duplicated to keep this module dependency-light. */
function splitKey(key: string): { name: string; props: Record<string, string> } {
  const i = key.indexOf('[');
  if (i < 0) return { name: key, props: {} };
  const props: Record<string, string> = {};
  const body = key.slice(i + 1, key.lastIndexOf(']'));
  for (const part of body ? body.split(',') : []) {
    const j = part.indexOf('=');
    if (j > 0) props[part.slice(0, j)] = part.slice(j + 1);
  }
  return { name: key.slice(0, i), props };
}
