/**
 * Asset sources.
 *
 * A "pack" is anything that can answer `get("assets/create/blockstates/shaft.json")`.
 * Mod jars, the vanilla client jar and resource packs are all just zips, so the same
 * reader serves all three — which is what makes modded support fall out for free
 * rather than needing per-mod code.
 *
 * Resolution order mirrors Minecraft's: later packs win. We stack
 *   vanilla client jar  <  mod jars  <  user resource packs
 * so a resource pack can retexture a mod, exactly as in game.
 */

import { unzipSync, type Unzipped } from 'fflate';

export interface Pack {
  readonly name: string;
  has(path: string): boolean;
  get(path: string): Uint8Array | undefined;
  list(prefix: string): string[];
}

export class ZipPack implements Pack {
  private files: Unzipped;
  private keys: string[];

  private constructor(
    readonly name: string,
    files: Unzipped,
  ) {
    this.files = files;
    this.keys = Object.keys(files);
  }

  /**
   * `filter` keeps the unzip cheap: mod jars are mostly .class files we never touch,
   * and inflating all of them for 128 jars would cost seconds and hundreds of MB.
   */
  static fromZip(name: string, data: Uint8Array, filter = defaultFilter): ZipPack {
    const files = unzipSync(data, { filter: (f) => filter(f.name) });
    return new ZipPack(name, files);
  }

  has(path: string): boolean {
    return this.files[path] !== undefined;
  }
  get(path: string): Uint8Array | undefined {
    return this.files[path];
  }
  list(prefix: string): string[] {
    return this.keys.filter((k) => k.startsWith(prefix));
  }
}

/**
 * Only inflate what a renderer can use. Mod jars are mostly .class files, and
 * inflating those across 128 jars would cost seconds and hundreds of megabytes.
 *
 * `data/**\/worldgen/biome/*.json` is included because biome tint (grass, foliage,
 * water) is driven by each biome's temperature/downfall/water_color — and modded
 * biomes (Terralith, Incendium, Nullscape here) ship those files exactly like vanilla,
 * so honouring them costs nothing and makes modded worlds tint correctly.
 */
export function defaultFilter(name: string): boolean {
  if (name.startsWith('data/') || name.includes('/worldgen/biome/')) {
    return name.includes('/worldgen/biome/') && name.endsWith('.json');
  }
  if (!name.startsWith('assets/')) return false;
  return (
    name.endsWith('.json') ||
    name.endsWith('.png') ||
    name.endsWith('.png.mcmeta') ||
    name.endsWith('.obj') ||
    name.endsWith('.mtl')
  );
}

export class PackStack implements Pack {
  readonly name = 'stack';
  /** lowest priority first */
  readonly packs: Pack[] = [];

  add(p: Pack): this {
    this.packs.push(p);
    return this;
  }

  has(path: string): boolean {
    for (let i = this.packs.length - 1; i >= 0; i--) if (this.packs[i].has(path)) return true;
    return false;
  }
  get(path: string): Uint8Array | undefined {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      const v = this.packs[i].get(path);
      if (v) return v;
    }
    return undefined;
  }
  list(prefix: string): string[] {
    const seen = new Set<string>();
    for (const p of this.packs) for (const k of p.list(prefix)) seen.add(k);
    return [...seen];
  }

  /** Which pack actually provided a path — used by the audit to attribute coverage. */
  providerOf(path: string): string | undefined {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      if (this.packs[i].has(path)) return this.packs[i].name;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resource locations

export interface ResLoc {
  namespace: string;
  path: string;
}

export function parseId(id: string, defaultNs = 'minecraft'): ResLoc {
  const i = id.indexOf(':');
  return i < 0
    ? { namespace: defaultNs, path: id }
    : { namespace: id.slice(0, i), path: id.slice(i + 1) };
}

export function idToString(r: ResLoc): string {
  return `${r.namespace}:${r.path}`;
}

export function blockstatePath(id: string): string {
  const r = parseId(id);
  return `assets/${r.namespace}/blockstates/${r.path}.json`;
}

/** Model ids may already carry a `block/` or `item/` prefix; they are relative to models/. */
export function modelPath(id: string): string {
  const r = parseId(id);
  return `assets/${r.namespace}/models/${r.path}.json`;
}

export function texturePath(id: string): string {
  const r = parseId(id);
  return `assets/${r.namespace}/textures/${r.path}.png`;
}

const decoder = new TextDecoder();
export function readJson<T = unknown>(pack: Pack, path: string): T | undefined {
  const raw = pack.get(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(decoder.decode(raw)) as T;
  } catch (e) {
    throw new Error(`Malformed JSON in ${path}: ${(e as Error).message}`);
  }
}
