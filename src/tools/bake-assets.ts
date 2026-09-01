/**
 * ASSET BAKE — turns 129 jars into one small bundle the browser can actually fetch.
 *
 *   npx tsx src/tools/bake-assets.ts [--world <dir>] [--mods <dir>] [--client <jar>]
 *                                    [--regions r.-1.0.mca,...] [--out .cache/baked]
 *
 * The problem this solves: `?auto=1` had the browser download every jar — ~476 MB for the
 * reference set — and then unzip, resolve blockstates, bake models, decode PNGs and pack
 * an atlas, all client-side, on every single page load. All of that is a pure function of
 * (jars, world inventory), so it belongs here, once.
 *
 * What comes out is exactly what the renderer already consumes — baked `RenderableState`
 * geometry, atlas sprite rects, biome tints — so the mesher cannot tell the difference
 * between a baked bundle and the browser having done the work itself.
 *
 * Only states the world actually contains are baked, which keeps the bundle proportional
 * to the world rather than to the 128-jar asset surface. Contraption blocks are included
 * even though they never appear in a chunk palette: they live inside entity NBT, and
 * without them their sprites are missing from the atlas and every contraption quad is
 * silently dropped at mesh time.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'fflate';
import { PackStack, ZipPack } from '../assets/pack.js';
import { BlockRegistry, type RenderableState } from '../render/registry.js';
import { BiomeColors } from '../render/biome.js';
import { RegionFile } from '../core/region.js';
import { decodeChunk } from '../core/chunk.js';
import { decodeContraption, isContraptionId } from '../render/entities.js';
import { bakeAtlas } from '../server/atlas-bake.js';
import type { NbtCompound, NbtList } from '../core/nbt.js';
import {
  makeEntityModelSet, type EntityIndex, type EntityModels,
} from '../render/entity-geometry.js';
import { PLAYER_TYPE, withPlayerRow } from '../render/player-model.js';
import { serialiseAll, type BakedAssets } from '../server/asset-format.js';
import { bakeItems } from '../server/item-bake.js';

const DEFAULTS = {
  world: '/Users/macback/Projects/minecraft-create121/data/world',
  mods: '/Users/macback/Projects/minecraft-create121/data/mods',
  client: '.cache/client-1.21.1.jar',
  out: '.cache/baked',
  entityModels: 'public/entity-models.json',
  entityIndex: 'public/entity-index.json',
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function loadPacks(modsDir: string, clientJar: string): PackStack {
  const stack = new PackStack();
  if (!existsSync(clientJar)) {
    throw new Error(`no vanilla client jar at ${clientJar} — run: npm run fetch-assets`);
  }
  stack.add(ZipPack.fromZip('client.jar', new Uint8Array(readFileSync(clientJar))));
  let mods = 0;
  if (existsSync(modsDir)) {
    for (const f of readdirSync(modsDir).filter((n) => n.endsWith('.jar')).sort()) {
      try {
        stack.add(ZipPack.fromZip(f, new Uint8Array(readFileSync(join(modsDir, f)))));
        mods++;
      } catch (e) {
        console.warn(`  skipped ${f}: ${(e as Error).message}`);
      }
    }
  }
  console.log(`packs: 1 client + ${mods} mods`);
  return stack;
}

interface WorldScan {
  states: Set<string>;
  biomes: Set<string>;
  entityTypes: Set<string>;
  chunks: number;
}

/** Every distinct block state, biome and entity type in the regions we are baking for. */
function scanRegions(worldDir: string, regions: string[]): WorldScan {
  const out: WorldScan = {
    states: new Set(['minecraft:air']),
    biomes: new Set(),
    entityTypes: new Set(),
    chunks: 0,
  };
  for (const name of regions) {
    scanBlockRegion(join(worldDir, 'region', name), name, out);
    scanEntityRegion(join(worldDir, 'entities', name), name, out);
  }
  return out;
}

function eachChunk(path: string, name: string, fn: (root: NbtCompound) => void): void {
  if (!existsSync(path)) return;
  const coords = RegionFile.parseName(name) ?? { x: 0, z: 0 };
  const region = new RegionFile(new Uint8Array(readFileSync(path)), coords.x, coords.z);
  for (const e of region.entries()) {
    try {
      const root = region.chunk(e.localX, e.localZ);
      if (root) fn(root);
    } catch {
      /* a corrupt chunk must not abort the bake */
    }
  }
}

function scanBlockRegion(path: string, name: string, out: WorldScan): void {
  eachChunk(path, name, (root) => {
    const c = decodeChunk(root);
    out.chunks++;
    for (const s of c.sections) {
      for (const p of s.palette) out.states.add(p.key);
      for (const b of s.biomePalette) out.biomes.add(b);
    }
  });
}

/**
 * Contraption blocks live ONLY inside entity NBT and never appear in a chunk section
 * palette, so they have to be collected here or their sprites go missing from the atlas.
 */
function scanEntityRegion(path: string, name: string, out: WorldScan): void {
  eachChunk(path, name, (root) => {
    for (const raw of ((root.Entities as NbtList) ?? [])) {
      const ent = raw as NbtCompound;
      const id = (ent.id as string) ?? '';
      out.entityTypes.add(id);
      if (!isContraptionId(id)) continue;
      const c = decodeContraption(ent);
      for (const b of c?.blocks ?? []) out.states.add(b.stateKey);
    }
  });
}

/**
 * Entity textures live under textures/entity/, so no block state ever names them and they
 * would be absent from the atlas at mesh time.
 *
 * Goes through `EntityModelSet.spriteIds` rather than reading the index directly: the
 * index stores raw asset paths, and only that method converts them into the resource
 * locations the atlas is keyed by. Reading the field straight gives paths that then get a
 * second `assets/.../textures/` prefix bolted on and silently miss.
 */
function entitySprites(entityTypes: Set<string>): Set<string> {
  if (!existsSync(DEFAULTS.entityModels) || !existsSync(DEFAULTS.entityIndex)) {
    console.warn('  no extracted entity models; mob textures will be absent from the atlas');
    return new Set();
  }
  const models = JSON.parse(readFileSync(DEFAULTS.entityModels, 'utf8')) as EntityModels;
  const index = JSON.parse(readFileSync(DEFAULTS.entityIndex, 'utf8')) as EntityIndex;
  // The player is not an entity in the save files — live players come over RCON — but its
  // texture has to be in the atlas before anyone logs in, or the first player to appear
  // draws untextured and nothing at runtime can fix it.
  const withPlayer = new Set([...entityTypes, PLAYER_TYPE]);
  return makeEntityModelSet(models, withPlayerRow(index)).spriteIds(withPlayer);
}

function regionList(worldDir: string, spec: string): string[] {
  if (spec) return spec.split(',').filter(Boolean);
  const dir = join(worldDir, 'region');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mca')).sort() : [];
}

function biomeTints(biomes: BiomeColors, names: Set<string>) {
  const out: BakedAssets['biomes'] = {};
  for (const name of names) {
    out[name] = {
      grass: biomes.tint(name, 0).map(round3) as [number, number, number],
      foliage: biomes.tint(name, 1).map(round3) as [number, number, number],
      water: biomes.tint(name, 2).map(round3) as [number, number, number],
    };
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function resolveAll(registry: BlockRegistry, keys: Set<string>): Map<string, RenderableState> {
  const out = new Map<string, RenderableState>();
  for (const key of keys) out.set(key, registry.resolve(key));
  return out;
}

function main(): void {
  const world = arg('--world', DEFAULTS.world);
  const out = arg('--out', DEFAULTS.out);
  const regions = regionList(world, arg('--regions', ''));
  console.log(`world ${world}\nregions: ${regions.join(', ') || '(none)'}`);

  const pack = loadPacks(arg('--mods', DEFAULTS.mods), arg('--client', DEFAULTS.client));
  const t0 = Date.now();
  const scan = scanRegions(world, regions);
  console.log(`scanned ${scan.chunks} chunks: ${scan.states.size} states,`
    + ` ${scan.biomes.size} biomes, ${scan.entityTypes.size} entity types`);

  const registry = new BlockRegistry(pack);
  const states = resolveAll(registry, scan.states);
  console.log(`baked ${states.size} states (${registry.unresolved.size} unresolved)`);

  const sprites = new Set<string>();
  for (const s of states.values()) for (const q of s.quads) sprites.add(q.texture);
  for (const s of entitySprites(scan.entityTypes)) sprites.add(s);

  const atlas = bakeAtlas(pack, sprites);
  console.log(`atlas ${atlas.width}x${atlas.height},`
    + ` ${Object.keys(atlas.sprites).length} sprites (${atlas.missing.length} missing)`);

  const biomes = BiomeColors.load(pack);
  const serialised = serialiseAll(states);

  const bundle: BakedAssets = {
    version: 1,
    generated: new Date().toISOString(),
    textures: serialised.textures,
    atlas: { width: atlas.width, height: atlas.height, sprites: atlas.sprites },
    states: serialised.states,
    biomes: biomeTints(biomes, scan.biomes),
    regions,
    unresolved: [...registry.unresolved],
    missingSprites: atlas.missing,
  };

  // Item icons go in their OWN files, fetched only by live mode. Folding them into the
  // main bundle would grow the ?auto=1 payload for a feature it never uses, and the size
  // of that payload is the whole point of the bake.
  const items = bakeItems(pack);
  console.log(`items ${Object.keys(items.meta.icons).length} icons`
    + ` (${Object.keys(items.meta.atlas.sprites).length} flat sprites,`
    + ` ${items.meta.missing.length} missing)`);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'atlas.png'), atlas.png);
  writeFileSync(join(out, 'items.png'), items.png);
  const itemsJson = Buffer.from(JSON.stringify(items.meta));
  writeFileSync(join(out, 'items.json'), itemsJson);
  writeFileSync(join(out, 'items.json.gz'), gzipSync(new Uint8Array(itemsJson), { level: 9 }));
  const json = Buffer.from(JSON.stringify(bundle));
  writeFileSync(join(out, 'assets.json'), json);
  const gz = gzipSync(new Uint8Array(json), { level: 9 });
  writeFileSync(join(out, 'assets.json.gz'), gz);

  console.log(`\nwrote ${out}/`);
  console.log(`  atlas.png       ${mb(atlas.png.length)}`);
  console.log(`  items.png       ${mb(items.png.length)}  (live mode only)`);
  console.log(`  items.json      ${mb(itemsJson.length)}  (live mode only)`);
  console.log(`  assets.json     ${mb(json.length)}  (gzip ${mb(gz.length)})`);
  console.log(`  total over the wire: ${mb(atlas.png.length + gz.length)}`);
  console.log(`  bake took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function mb(bytes: number): string {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
}

main();
