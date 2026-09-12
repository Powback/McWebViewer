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
import { useEntityVariants } from '../app/entity-tracks.js';
import { setRegistrySizes } from '../core/chunk.js';
import { setEntitySizes } from './entity-sizes.js';
import { useVariantRegistries } from '../app/spacetime-entities.js';
import type { VariantTable } from './entity-metadata.js';

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
  /**
   * Keys the bundle does not contain at all — the world gained the block after the bake.
   * Kept apart from `unresolved` (which also holds states no jar can render) because only
   * this set is fixed by re-baking, and it is what drives the refresh poll.
   */
  readonly missing = new Set<string>();

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
    if (!raw) {
      this.unresolved.add(stateKey);
      this.missing.add(stateKey);
    }
    this.cache.set(stateKey, state);
    return state;
  }

  get size(): number {
    return Object.keys(this.bundle.states).length;
  }

  /**
   * Every canonical state key the bundle can render.
   *
   * Used by the spacetime terrain path to work out each block property's DOMAIN, which is
   * how it recovers the properties the wire omits because they are at their default value.
   * See spacetime-sections.ts — the bundle turns out to be a better domain source than the
   * blockstate JSON would be, because it is already canonical and already per-state.
   */
  keys(): Iterable<string> {
    return Object.keys(this.bundle.states);
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
async function atlasFromPng(
  base: string,
  bundle: BakedAssets,
  init: RequestInit,
): Promise<TextureAtlas> {
  const atlas = new TextureAtlas();
  // Keyed by the bundle's own hash of the PNG, so this request cannot be answered from a
  // cache entry made for a different bake — the sprite rects below would then index the
  // wrong pixels. Bundles from before the hash existed fall back to the plain URL.
  const v = bundle.atlasHash ? `?v=${encodeURIComponent(bundle.atlasHash)}` : '';
  const r = await fetch(`${base}/atlas.png${v}`, init);
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
export async function loadServedAssets(
  bases: readonly string[],
  opts: { fresh?: boolean } = {},
): Promise<ServedAssets | null> {
  // `fresh` is for the refresh poll: it exists to find out whether the bundle CHANGED, and
  // an answer from the HTTP cache would say "no" for as long as the cache lasts.
  const init: RequestInit = opts.fresh ? { cache: 'no-store' } : {};
  for (const base of bases) {
    const r = await fetch(`${base}/assets.json`, init).catch(() => null);
    if (!r?.ok) continue;
    const bundle = (await r.json()) as BakedAssets;
    // Datapack variant tables travel in the bundle because the browser has no packs; see
    // the field's note in asset-format.ts for why a wolf's coat cannot be derived from its
    // variant name. Installed here, at the one place a bundle becomes live.
    useEntityVariants(bundle.entityVariants);
    // How wide a promoted paletted container is written. Nowhere in a save file, so it
    // travels in the bundle; see core/chunk.ts for what goes wrong without it.
    if (bundle.registrySizes) setRegistrySizes(bundle.registrySizes);
    // Collision boxes, for the spawner cage's scale rule. See render/spawner-display.ts.
    setEntitySizes(bundle.entitySizes);
    // The same variant tables the appearance rules use, for turning a metadata int back into
    // a registry name. One table, two readers — see render/entity-metadata.ts.
    useVariantRegistries(bundle.entityVariants
      ? (name) => bundle.entityVariants?.[name] as VariantTable | undefined
      : undefined);
    const registry = new ServedStates(bundle);
    return {
      registry,
      atlas: await atlasFromPng(base, bundle, init),
      biomes: new ServedBiomes(bundle),
      regions: bundle.regions,
      stateCount: registry.size,
      generated: bundle.generated,
    };
  }
  return null;
}
