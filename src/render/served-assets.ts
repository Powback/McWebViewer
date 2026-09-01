/**
 * Client side of the asset bake.
 *
 * Replaces the fetch-129-jars-and-do-everything-in-the-browser path with two requests:
 * one JSON bundle of baked geometry and one atlas PNG. For the reference world that is
 * ~224 KB against ~476 MB, and it removes unzipping, blockstate resolution, model baking,
 * PNG decoding and atlas packing from page load entirely.
 *
 * What comes back satisfies the same interfaces the mesher already depends on
 * (`StateSource`, `TintLookup`, `TextureAtlas`), so nothing downstream changes and the
 * two paths cannot produce different geometry — they run the same code, just in different
 * places.
 */

import { TextureAtlas } from './atlas.js';
import type { RenderableState } from './registry.js';
import type { StateSource, TintLookup } from './mesher.js';
import { deserialiseState, type BakedAssets } from '../server/asset-format.js';

type RGB = readonly [number, number, number];

/**
 * States are decoded lazily and memoised.
 *
 * A region's bundle holds every state in the world, but a session typically meshes a
 * fraction of them, and eagerly rebuilding 649 states' worth of Float32Arrays costs more
 * than it saves.
 */
class ServedStates implements StateSource {
  private cache = new Map<string, RenderableState>();
  readonly unresolved = new Set<string>();

  constructor(private bundle: BakedAssets) {
    for (const key of bundle.unresolved) this.unresolved.add(key);
  }

  resolve(stateKey: string): RenderableState {
    const hit = this.cache.get(stateKey);
    if (hit) return hit;
    const raw = this.bundle.states[stateKey];
    const state = raw
      ? deserialiseState(stateKey, raw, this.bundle.textures)
      : missingState(stateKey);
    if (!raw) this.unresolved.add(stateKey);
    this.cache.set(stateKey, state);
    return state;
  }

  get size(): number {
    return Object.keys(this.bundle.states).length;
  }
}

/**
 * A state the bake did not cover. Reachable when the world gains a block after the bake —
 * the server world is live — so it must render as nothing rather than throw, and be
 * counted so the HUD can say the bundle is stale.
 */
function missingState(stateKey: string): RenderableState {
  return {
    key: stateKey,
    name: stateKey.split('[')[0],
    props: {},
    quads: [],
    renderType: 'solid',
    opaqueFullCube: false,
    ambientOcclusion: true,
    tintSource: -1,
    provenance: 'none',
    lightEmission: 0,
  };
}

class ServedBiomes implements TintLookup {
  constructor(private bundle: BakedAssets) {}

  tint(biomeId: string, source: 0 | 1 | 2): RGB {
    const b = this.bundle.biomes[biomeId];
    if (!b) return source === 2 ? WATER_FALLBACK : source === 0 ? GRASS_FALLBACK : FOLIAGE_FALLBACK;
    return source === 0 ? b.grass : source === 1 ? b.foliage : b.water;
  }

  get count(): number {
    return Object.keys(this.bundle.biomes).length;
  }
}

// Same constants the in-browser path falls back to for a biome it has no data for.
const GRASS_FALLBACK: RGB = [0x91 / 255, 0xbd / 255, 0x59 / 255];
const FOLIAGE_FALLBACK: RGB = [0x77 / 255, 0xab / 255, 0x2f / 255];
const WATER_FALLBACK: RGB = [0x3f / 255, 0x76 / 255, 0xe4 / 255];

export interface ServedAssets {
  registry: ServedStates;
  atlas: TextureAtlas;
  biomes: ServedBiomes;
  regions: string[];
  stateCount: number;
  generated: string;
}

/**
 * The atlas arrives as a PNG. It is drawn into a canvas because that is what the renderer
 * uploads from — both the three.js texture and the WebGPU `copyExternalImageToTexture`
 * path take a canvas or an ImageBitmap.
 */
async function atlasFromPng(base: string, bundle: BakedAssets): Promise<TextureAtlas> {
  const atlas = new TextureAtlas();
  const r = await fetch(`${base}/atlas.png`);
  if (!r.ok) throw new Error(`atlas.png: HTTP ${r.status}`);
  const bitmap = await createImageBitmap(await r.blob());
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), {
      width: bitmap.width, height: bitmap.height,
    });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  atlas.canvas = canvas;
  atlas.width = bundle.atlas.width;
  atlas.height = bundle.atlas.height;
  for (const [id, rect] of Object.entries(bundle.atlas.sprites)) atlas.sprites.set(id, rect);
  for (const id of bundle.missingSprites) atlas.missing.add(id);
  return atlas;
}

/**
 * Load a baked bundle. Returns null when none is served, so the caller can fall back to
 * the jar path rather than failing — a viewer with no bake is slow, not broken.
 */
export async function loadServedAssets(bases: readonly string[]): Promise<ServedAssets | null> {
  for (const base of bases) {
    const r = await fetch(`${base}/assets.json`).catch(() => null);
    if (!r?.ok) continue;
    const bundle = (await r.json()) as BakedAssets;
    const registry = new ServedStates(bundle);
    return {
      registry,
      atlas: await atlasFromPng(base, bundle),
      biomes: new ServedBiomes(bundle),
      regions: bundle.regions,
      stateCount: registry.size,
      generated: bundle.generated,
    };
  }
  return null;
}
