/**
 * Biome tint.
 *
 * Vanilla resolves grass/foliage colour by sampling a 256x256 colormap with the
 * biome's temperature and downfall (BiomeColors -> GrassColor/FoliageColor), and water
 * colour straight from the biome's `effects.water_color`. All three inputs live in the
 * biome JSON, which ships in the jar for vanilla AND for modded biomes — so this is
 * fully data-driven and Terralith/Incendium/Nullscape biomes tint correctly with no
 * per-mod work.
 *
 * The one approximation: `grass_color_modifier: swamp` is noise-driven per-position in
 * vanilla; we use its dominant constant. Documented rather than silently wrong.
 */

import { parseId, type Pack } from '../assets/pack.js';
import { decodeRgba } from '../assets/png.js';

export interface BiomeDef {
  temperature: number;
  downfall: number;
  waterColor: number;
  grassColorOverride?: number;
  foliageColorOverride?: number;
  grassColorModifier?: 'none' | 'dark_forest' | 'swamp';
}

type RGB = [number, number, number];

/** the subset of the biome JSON we read */
interface BiomeJson {
  temperature?: number;
  downfall?: number;
  effects?: {
    water_color?: number;
    grass_color?: number;
    foliage_color?: number;
    grass_color_modifier?: string;
  };
}

function readBiomeDef(raw: Uint8Array): BiomeDef | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(raw)) as BiomeJson;
    return biomeDefFrom(j);
  } catch {
    /* skip malformed biome files rather than failing the whole load */
    return null;
  }
}

function biomeDefFrom(j: BiomeJson): BiomeDef {
  return {
    temperature: j.temperature ?? 0.5,
    downfall: j.downfall ?? 0.5,
    waterColor: j.effects?.water_color ?? 0x3f76e4,
    grassColorOverride: j.effects?.grass_color,
    foliageColorOverride: j.effects?.foliage_color,
    grassColorModifier: (j.effects?.grass_color_modifier as BiomeDef['grassColorModifier']) ??
      'none',
  };
}

export class BiomeColors {
  private defs = new Map<string, BiomeDef>();
  private cache = new Map<string, RGB>();
  private grassMap: Uint8Array | null = null;
  private foliageMap: Uint8Array | null = null;

  static load(pack: Pack): BiomeColors {
    const bc = new BiomeColors();
    bc.grassMap = loadColormap(pack, 'assets/minecraft/textures/colormap/grass.png');
    bc.foliageMap = loadColormap(pack, 'assets/minecraft/textures/colormap/foliage.png');

    for (const path of pack.list('data/')) {
      if (!path.includes('/worldgen/biome/') || !path.endsWith('.json')) continue;
      const m = /^data\/([^/]+)\/worldgen\/biome\/(.+)\.json$/.exec(path);
      if (!m) continue;
      const raw = pack.get(path);
      if (!raw) continue;
      const def = readBiomeDef(raw);
      if (!def) continue;
      bc.defs.set(`${m[1]}:${m[2]}`, def);
    }
    return bc;
  }

  get count(): number {
    return this.defs.size;
  }

  /** source: 0 grass, 1 foliage, 2 water */
  tint(biomeId: string, source: 0 | 1 | 2): RGB {
    const key = biomeId + '|' + source;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const id = parseId(biomeId);
    const def = this.defs.get(`${id.namespace}:${id.path}`);
    let rgb: RGB;
    if (!def) {
      rgb = unknownBiomeTint(source);
    } else if (source === 2) {
      rgb = unpack(def.waterColor);
    } else {
      rgb = this.plantTint(def, source);
    }
    this.cache.set(key, rgb);
    return rgb;
  }

  /** grass (0) / foliage (1) tint for a known biome */
  private plantTint(def: BiomeDef, source: 0 | 1): RGB {
    const override = source === 0 ? def.grassColorOverride : def.foliageColorOverride;
    if (override !== undefined) {
      return unpack(override);
    }
    return unpack(this.colormapTint(def, source));
  }

  private colormapTint(def: BiomeDef, source: 0 | 1): number {
    const map = source === 0 ? this.grassMap : this.foliageMap;
    let c = sampleColormap(map, def.temperature, def.downfall);
    if (source === 0 && def.grassColorModifier === 'dark_forest') {
      c = ((c & 0xfefefe) + 0x28340a) >> 1;
    } else if (source === 0 && def.grassColorModifier === 'swamp') {
      // Vanilla picks between two constants using BIOME_INFO_NOISE; we take the
      // dominant one. Difference is a subtle two-tone mottling in swamps only.
      c = 6975545;
    }
    return c;
  }
}

/**
 * Unknown biome (datapack-only, or a dimension we have no data for): use the
 * vanilla plains-ish defaults rather than rendering it untinted white.
 */
function unknownBiomeTint(source: 0 | 1 | 2): RGB {
  return source === 2 ? unpack(0x3f76e4) : source === 0 ? unpack(0x91bd59) : unpack(0x77ab2f);
}

function unpack(c: number): RGB {
  return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255];
}

/** vanilla GrassColor.get / FoliageColor.get */
function sampleColormap(
  map: Uint8Array | null,
  temperature: number,
  downfall: number,
): number {
  const t = Math.max(0, Math.min(1, temperature));
  const d = Math.max(0, Math.min(1, downfall)) * t;
  const i = Math.floor((1 - t) * 255);
  const j = Math.floor((1 - d) * 255);
  if (!map) return 0x91bd59;
  const idx = (j * 256 + i) * 4;
  if (idx < 0 || idx + 2 >= map.length) return 0xff00ff;
  return (map[idx] << 16) | (map[idx + 1] << 8) | map[idx + 2];
}

/**
 * Decoded with the project's own PNG reader rather than `createImageBitmap` + a canvas.
 *
 * That is what lets biome tint be resolved on the SERVER as well as in the browser: the
 * canvas path only exists in a browser, and the asset bake needs the same colours the
 * renderer would compute, from the same code, or the two can disagree silently.
 */
function loadColormap(pack: Pack, path: string): Uint8Array | null {
  const png = pack.get(path);
  if (!png) return null;
  return decodeRgba(png)?.data ?? null;
}
