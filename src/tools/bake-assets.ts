/**
 * ASSET BAKE — turns 129 jars into one small bundle the browser can actually fetch.
 *
 *   npx tsx src/tools/bake-assets.ts [--world <dir>] [--mods <dir>] [--client <jar|dir>]
 *                                    [--regions r.-1.0.mca,...] [--out .cache/baked]
 *                                    [--watch <ms>]
 *
 * `--watch` turns the one-shot bake into the baker: re-scan the regions every <ms> and
 * re-bake ONLY when the world contains a state, biome or entity type the served bundle
 * does not (src/server/bake-plan.ts). This exists because the bundle is a snapshot of a
 * live world's inventory, and a live world outgrows it — turtles built a stone-brick tower
 * on the reference server and the viewer drew none of it for three days, because
 * `minecraft:stone_bricks` was not in a bundle baked before the first brick was laid. The
 * region files were current the whole time; the geometry to draw them was not. The
 * docker-compose `mcwv-baker` service runs this mode against the same mounts the viewer
 * serves from. A bake is ~1 s of CPU, so the loop's cost is the scan, not the bake.
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

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';
import { BAKE_FORMAT, planBake } from '../server/bake-plan.js';
import { readTurtleUpgrades, upgradeStateKeysAllFacings } from '../render/turtle-upgrades.js';
import { PackStack, ZipPack, readJson, type Pack } from '../assets/pack.js';
import { BlockRegistry, type RenderableState } from '../render/registry.js';
import { BiomeColors } from '../render/biome.js';
import { RegionFile } from '../core/region.js';
import { decodeChunk } from '../core/chunk.js';
import { decodeContraption, isContraptionId } from '../render/entities.js';
import { bakeAtlas } from '../server/atlas-bake.js';
import type { NbtCompound, NbtList } from '../core/nbt.js';
import {
  makeEntityModelSet, spriteIdForTexture, type EntityIndex, type EntityModels,
} from '../render/entity-geometry.js';
import {
  appearanceTextures, assetPathOf, defaultVariantTexture, variantIdsIn, variantLookup,
  villagerOverlayTextures, wolfCoatTextures,
} from '../render/entity-layers.js';
import { materialsIn } from '../render/retexture.js';
import { ENTITY_BLOCK_STATES } from '../render/item-frames.js';
import { particleSprites } from '../render/particles.js';
import { PLAYER_TYPE, withPlayerRow } from '../render/player-model.js';
import { serialiseAll, type BakedAssets } from '../server/asset-format.js';
import { bakeItems } from '../server/item-bake.js';
import { bakeRecipes } from '../server/recipe-bake.js';
import { bakeTags } from '../server/tag-bake.js';

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

/**
 * `--client` may name the jar or the directory it sits in (the baker container mounts the
 * whole .cache). The harness leaves a `client-<ver>-deobf.jar` next to the real one — a
 * 28 MB remapped copy with no assets/ — which is skipped by name, as the nginx entrypoint
 * skips it.
 */
function resolveClientJar(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return path;
  const jar = readdirSync(path)
    .filter((f) => /^client.*\.jar$/i.test(f) && !f.endsWith('-deobf.jar'))
    .sort()[0];
  return jar ? join(path, jar) : null;
}

function loadPacks(modsDir: string, client: string): PackStack {
  const stack = new PackStack();
  const clientJar = resolveClientJar(client);
  if (!clientJar) {
    throw new Error(`no vanilla client jar at ${client} — run: npm run fetch-assets`);
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
  /** block names the world has block entities for (see registry.ts addPaintedSurfaces) */
  blockEntityBlocks: Set<string>;
  chunks: number;
}

/** Every distinct block state, biome and entity type in the regions we are baking for. */
function scanRegions(worldDir: string, regions: string[]): WorldScan {
  const out: WorldScan = {
    states: new Set(['minecraft:air']),
    biomes: new Set(),
    entityTypes: new Set(),
    blockEntityBlocks: new Set(),
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
    for (const be of c.blockEntities) {
      // Which blocks have a renderer painting on them is world data, not asset data.
      if (typeof be.id === 'string') out.blockEntityBlocks.add(be.id);
      // A turtle's pickaxe/modem is in its block entity, not its state. Bake a synthetic
      // state per facing so the turtle can turn — or move, live — without a re-bake.
      for (const k of upgradeStateKeysAllFacings(readTurtleUpgrades(be))) out.states.add(k);
      // A block whose material lives in its block entity (Domum Ornamentum's whole family)
      // names a block nothing in the world necessarily places — the world holds
      // `domum_ornamentum:plain`, not the birch planks it is MADE of. Adding the material
      // as a state is what pulls its texture into the atlas, via the ordinary
      // states -> quads -> sprites collection below; without it the retextured block
      // samples a sprite that is not there. Fourth outing for this trap, after
      // destroy_stage, the fluid surfaces and the entity layers.
      for (const material of materialsIn([be as Record<string, unknown>])) out.states.add(material);
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
/**
 * Variants whose texture is a built-in registry entry rather than a datapack file — cats and
 * frogs. Without these the entity index cannot pick one texture for a cat and leaves it
 * null, and every cat in the world draws nothing.
 */
function registryVariants(): Record<string, Record<string, Record<string, unknown>>> {
  const path = 'public/physics.json';
  if (!existsSync(path)) return {};
  const phys = JSON.parse(readFileSync(path, 'utf8')) as
    { entityVariants?: Record<string, Record<string, Record<string, unknown>>> };
  // Passed through as-is: each entry is `{ texture?, id? }`. The `id` is the registry's own
  // network id, which is what a metadata int means — and it is NOT the iteration position,
  // as `minecraft:calico` being id 5 while sitting first in the map demonstrates.
  return phys.entityVariants ?? {};
}

/**
 * Entity collision boxes from the physics extraction, for the spawner cage's scale rule.
 * Absent when the harness has not been run, which only costs the mob its exact size.
 */
function entitySizes(): Record<string, { w: number; h: number }> | undefined {
  // `public/`, not `harness/out/` — the baker sidecar's image carries public/ and the
  // extraction outputs beside it, but not the harness tree. A path outside the image reads
  // as "absent" in the sidecar and the field silently vanishes from every bundle it writes.
  const path = 'public/physics.json';
  if (!existsSync(path)) return undefined;
  const phys = JSON.parse(readFileSync(path, 'utf8')) as
    { entitySizes?: Record<string, { w: number; h: number }> };
  return phys.entitySizes;
}

/** Every entity type the extraction can draw — the atlas is built from exactly these. */
function bakedEntityTypes(): string[] {
  if (!existsSync(DEFAULTS.entityIndex)) return [];
  const index = JSON.parse(readFileSync(DEFAULTS.entityIndex, 'utf8')) as EntityIndex;
  return [...Object.keys(index), PLAYER_TYPE];
}

function entitySprites(entityTypes: Set<string>): Set<string> {
  if (!existsSync(DEFAULTS.entityModels) || !existsSync(DEFAULTS.entityIndex)) {
    console.warn('  no extracted entity models; mob textures will be absent from the atlas');
    return new Set();
  }
  const models = JSON.parse(readFileSync(DEFAULTS.entityModels, 'utf8')) as EntityModels;
  const index = JSON.parse(readFileSync(DEFAULTS.entityIndex, 'utf8')) as EntityIndex;
  // EVERY entity type the extraction knows, not just the ones the region scan happened to
  // see. Which mobs a world contains is not a property of the world — it is a property of
  // the moment you looked: mobs spawn, despawn and wander. A cave spider that walked into
  // a loaded chunk after the bake had no texture in the atlas and drew nothing, and no
  // amount of runtime work could fix it. Measured: the scan found 33 types where the
  // extraction knows 135, and covering all of them costs 98 sprites in a 567-sprite atlas.
  //
  // The player is in here for the same reason — it is not in the save files at all, live
  // players come over RCON, and the first one to log in must not draw untextured.
  const withPlayer = new Set([...entityTypes, ...Object.keys(index), PLAYER_TYPE]);
  const set = makeEntityModelSet(models, withPlayerRow(index));
  // The same stand-in the renderer uses, so a variant-textured mob's sprite is collected.
  const variants = registryVariants();
  set.useDefaultTextures((type) => defaultVariantTexture(type, {
    variant: (registry, id) => variants[registry]?.[id] ?? null,
    variantIds: (registry) => Object.keys(variants[registry] ?? {}),
  }));
  const out = set.spriteIds(withPlayer);
  // Secondary layers: a sheep's wool, a horse's actual coat colour. `spriteIds` returns one
  // texture per entity TYPE, so a layer's texture is named by nothing and never reaches the
  // atlas — the destroy_stage / fluid trap again, and with the same silent symptom.
  for (const path of appearanceTextures()) {
    const id = spriteIdForTexture(path);
    if (id) out.add(id);
  }
  return out;
}

/**
 * Wolf coats, which are datapack data: `data/<ns>/wolf_variant/<name>.json` names the
 * wild / tame / angry texture. Enumerated from the packs so a mod's variant is covered
 * without this file knowing it exists.
 */
function entityVariants(pack: Pack, registry: string): Record<string, Record<string, unknown>> {
  const read = variantLookup((path) => readJson<Record<string, unknown>>(pack, path));
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of variantIdsIn(registry, pack.list('data/'))) {
    const entry = read(registry, id);
    if (entry) out[id] = entry;
  }
  return out;
}

/** The coat textures every wolf variant in the packs could need. */
function wolfCoatSprites(variants: Record<string, Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  const read = (_r: string, id: string) => variants[id] ?? null;
  for (const path of wolfCoatTextures(Object.keys(variants), read)) {
    const id = spriteIdForTexture(path);
    if (id) out.add(id);
  }
  return out;
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

interface BakeOptions {
  world: string;
  mods: string;
  client: string;
  out: string;
  regions: string[];
}

function readOptions(): BakeOptions {
  const world = arg('--world', DEFAULTS.world);
  return {
    world,
    mods: arg('--mods', DEFAULTS.mods),
    client: arg('--client', DEFAULTS.client),
    out: arg('--out', DEFAULTS.out),
    // The same variable the viewer container autoloads from, so one setting names the
    // regions both for serving and for baking.
    regions: regionList(world, arg('--regions', process.env.MCWV_REGIONS ?? '')),
  };
}

/** The served bundle, if there is one, for the staleness comparison. */
function readBundle(out: string): BakedAssets | null {
  const path = join(out, 'assets.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BakedAssets;
  } catch {
    return null; // half-written or corrupt: bake over it
  }
}

/**
 * Write to a sibling and rename into place. nginx serves this directory while it is being
 * written and the browser fetches assets.json and atlas.png as two requests; a truncated
 * JSON is a broken page, and rename is atomic where a write is not. Rename also succeeds
 * over a file another user owns, which matters when the baker container and `npm run
 * bake-assets` on the host take turns writing the same directory.
 */
/**
 * `minecraft:block/destroy_stage_0` .. `_9`.
 *
 * Ten, because that is how many `destroy_stage_N.png` files the client jar contains — the
 * count is the game's, and `breakStage()` clamps to the same range.
 */
/**
 * The four fluid textures. `*_still` is the animated surface (water_still is 32 frames, and
 * rides the existing `anim` vertex attribute); `*_flow` is used on the sides.
 */
export const FLUID_SPRITES = [
  'minecraft:block/water_still', 'minecraft:block/water_flow',
  'minecraft:block/lava_still', 'minecraft:block/lava_flow',
];

export const DESTROY_STAGE_SPRITES = Array.from(
  { length: 10 }, (_, i) => `minecraft:block/destroy_stage_${i}`,
);

function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function scanAndReport(opts: BakeOptions): WorldScan {
  const scan = scanRegions(opts.world, opts.regions);
  console.log(`scanned ${scan.chunks} chunks: ${scan.states.size} states,`
    + ` ${scan.biomes.size} biomes, ${scan.entityTypes.size} entity types`);
  return scan;
}

function stamp(): string {
  return new Date().toISOString();
}

function main(): void {
  const opts = readOptions();
  console.log(`world ${opts.world}\nregions: ${opts.regions.join(', ') || '(none)'}`);
  const watchMs = Number(arg('--watch', '0'));
  if (!(watchMs > 0)) {
    bake(opts, scanAndReport(opts));
    return;
  }
  void watchLoop(opts, Math.max(watchMs, MIN_WATCH_MS));
}

/** A scan reads and decodes every chunk of every region; asking more often than this is noise. */
const MIN_WATCH_MS = 5000;

/**
 * The baker. Scan, compare, bake only on a difference, sleep, repeat — for ever.
 *
 * The comparison is the whole point: the world changes every second (incremental chunk
 * saves) but its INVENTORY of states changes rarely, so this loop is almost always a scan
 * that decides nothing needs doing. Errors are logged and the loop goes on: a region
 * caught mid-write or a jar being replaced is a reason to try again, not to stop.
 */
async function watchLoop(opts: BakeOptions, everyMs: number): Promise<void> {
  console.log(`${stamp()} watching every ${everyMs} ms — baking only when the world`
    + ' contains something the served bundle does not');
  for (;;) {
    try {
      const scan = scanRegions(opts.world, opts.regions);
      const previous = readBundle(opts.out);
      const plan = planBake(
        {
          states: scan.states,
          biomes: scan.biomes,
          entityTypes: scan.entityTypes,
          regions: opts.regions,
        },
        previous,
      );
      if (plan.needed) {
        console.log(`${stamp()} re-bake: ${plan.reasons.join('; ')}`);
        bake(opts, widen(scan, previous));
      }
    } catch (e) {
      console.log(`${stamp()} bake skipped: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * In watch mode the bundle is the inventory EVER seen, not the inventory right now.
 *
 * Mobs spawn and despawn and turtles turn away and back; baking only what is present would
 * drop a turtle's south-facing state the moment it turned north and bake it again when it
 * turned back, and a bee flying through would cost two bakes. The union only ever adds, so
 * once the world has shown the baker something it stays drawable. A one-shot bake still
 * produces the minimal bundle for the world as it is.
 */
function widen(scan: WorldScan, previous: BakedAssets | null): WorldScan {
  if (!previous) return scan;
  return {
    ...scan,
    states: new Set([...scan.states, ...Object.keys(previous.states)]),
    biomes: new Set([...scan.biomes, ...Object.keys(previous.biomes)]),
    entityTypes: new Set([...scan.entityTypes, ...(previous.entityTypes ?? [])]),
    blockEntityBlocks: new Set([...scan.blockEntityBlocks, ...(previous.blockEntityBlocks ?? [])]),
  };
}

function bake(opts: BakeOptions, scan: WorldScan): void {
  const { out, regions } = opts;
  const pack = loadPacks(opts.mods, opts.client);
  const t0 = Date.now();

  const registry = new BlockRegistry(pack, { blockEntityBlocks: scan.blockEntityBlocks });
  // An item frame is an ENTITY whose appearance is a BLOCK model. No item frame is ever a
  // block in the world, so the region scan never names these states and they bake to nothing
  // — the same shape of miss as destroy_stage and the fluid sprites, in state form rather
  // than sprite form. See render/item-frames.ts.
  for (const k of ENTITY_BLOCK_STATES) scan.states.add(k);
  const states = resolveAll(registry, scan.states);
  console.log(`baked ${states.size} states (${registry.unresolved.size} unresolved)`);

  const sprites = new Set<string>();
  for (const s of states.values()) for (const q of s.quads) sprites.add(q.texture);
  for (const s of entitySprites(scan.entityTypes)) sprites.add(s);
  // The mining crack overlay. These are the one set of sprites NOTHING in the world
  // references — no block state names them, so the collection above never finds them — and
  // without being asked for explicitly they are simply absent from the atlas and the
  // overlay draws nothing. Vanilla ships exactly ten stages.
  for (const s of DESTROY_STAGE_SPRITES) sprites.add(s);
  // Particle textures. `textures/particle/` is named by no block state and no entity index,
  // so nothing else collects them — the same trap, now for the fifth time. See
  // render/particles.ts.
  for (const s of particleSprites()) sprites.add(s);
  // Wolf coats. Datapack data, so enumerated from the packs rather than listed: a mod that
  // adds a wolf variant gets its textures baked with no change here.
  const wolfVariants = entityVariants(pack, 'wolf_variant');
  for (const s of wolfCoatSprites(wolfVariants)) sprites.add(s);
  // Villager robes. Professions and biome types are an open registry — a mod adds its own —
  // so these come from the pack's own texture files rather than a list here.
  for (const path of villagerOverlayTextures(pack.list('assets/'))) {
    const id = spriteIdForTexture(path);
    if (id) sprites.add(id);
  }
  // Cat and frog coats. Referenced by no entity index row (that is the whole problem), so
  // they reach the atlas only by being asked for here — the trap for the fifth time.
  for (const rows of Object.values(registryVariants())) {
    for (const row of Object.values(rows)) {
      const tex = typeof row.texture === 'string' ? row.texture : null;
      const id = tex ? spriteIdForTexture(assetPathOf(tex)) : null;
      if (id) sprites.add(id);
    }
  }
  // Fluid surfaces, for the same reason: a fluid's model JSON has no `elements`, so no
  // block state ever names `water_still` and the collection above never finds it. Without
  // these four the generated fluid geometry samples nothing and the ocean stays invisible.
  for (const s of FLUID_SPRITES) sprites.add(s);

  const atlas = bakeAtlas(pack, sprites);
  console.log(`atlas ${atlas.width}x${atlas.height},`
    + ` ${Object.keys(atlas.sprites).length} sprites (${atlas.missing.length} missing)`);

  const biomes = BiomeColors.load(pack);
  const serialised = serialiseAll(states);

  const bundle: BakedAssets = {
    version: BAKE_FORMAT,
    generated: new Date().toISOString(),
    textures: serialised.textures,
    atlas: { width: atlas.width, height: atlas.height, sprites: atlas.sprites },
    states: serialised.states,
    biomes: biomeTints(biomes, scan.biomes),
    regions,
    blockEntityBlocks: [...scan.blockEntityBlocks].sort(),
    unresolved: [...registry.unresolved],
    missingSprites: atlas.missing,
    // What the bundle HAS TEXTURES FOR, not what the region scan happened to see. The
    // staleness check compares this against the live world's entity types, so recording
    // only the scanned ones meant a mob wandering into view marked the bundle stale for
    // ever: the baker re-baked every 30 seconds, and the bundle it produced was stale again
    // immediately. Measured on the reference server: 275 re-bakes, 6 in one 25-minute
    // window. Now that the atlas carries every type the extraction knows, say so.
    entityTypes: [...new Set([...scan.entityTypes, ...bakedEntityTypes()])].sort(),
    // Datapack variants (wolf) and built-in registry variants (cat, frog) side by side: the
    // two have different shapes — an object of wild/tame/angry vs a plain texture — and
    // entity-layers.ts reads each accordingly. See its `registryCoat`.
    entityVariants: { wolf_variant: wolfVariants, ...registryVariants() },
    // The biome registry size, counted from the packs' own definitions. A biome container
    // holds at most 8 biomes before it is promoted to the global palette's width, and this
    // world's densest section already holds 7 — one biome from being misread. See
    // core/chunk.ts. There is no equivalent offline source for the block-state registry.
    registrySizes: { biomes: biomes.count },
    entitySizes: entitySizes(),
    atlasHash: createHash('sha1').update(atlas.png).digest('hex').slice(0, 12),
  };

  // Item icons go in their OWN files, fetched only by live mode. Folding them into the
  // main bundle would grow the ?auto=1 payload for a feature it never uses, and the size
  // of that payload is the whole point of the bake.
  const items = bakeItems(pack);
  console.log(`items ${Object.keys(items.meta.icons).length} icons`
    + ` (${Object.keys(items.meta.atlas.sprites).length} flat sprites,`
    + ` ${items.meta.missing.length} missing)`);

  mkdirSync(out, { recursive: true });
  // The atlas BEFORE the JSON that describes it: a reader that sees the new assets.json
  // is then guaranteed the PNG its hash names is already on disk.
  writeAtomic(join(out, 'atlas.png'), atlas.png);
  writeAtomic(join(out, 'items.png'), items.png);
  const itemsJson = Buffer.from(JSON.stringify(items.meta));
  writeAtomic(join(out, 'items.json'), itemsJson);
  writeAtomic(join(out, 'items.json.gz'), gzipSync(new Uint8Array(itemsJson), { level: 9 }));

  // Recipes: every mod's own data, read structurally. See server/recipe-bake.ts.
  const recipes = bakeRecipes(pack);
  const recipeJson = Buffer.from(JSON.stringify(recipes));
  writeAtomic(join(out, 'recipes.json'), recipeJson);
  writeAtomic(join(out, 'recipes.json.gz'), gzipSync(new Uint8Array(recipeJson), { level: 9 }));
  // Block tags: what a tool's mining rules actually refer to. See server/tag-bake.ts.
  const tags = bakeTags(pack);
  const tagJson = Buffer.from(JSON.stringify(tags));
  writeAtomic(join(out, 'tags.json'), tagJson);
  writeAtomic(join(out, 'tags.json.gz'), gzipSync(new Uint8Array(tagJson), { level: 9 }));
  const mineable = Object.keys(tags).filter((t) => t.includes('mineable/')).length;
  console.log(`tags: ${Object.keys(tags).length} block tags`
    + ` (${mineable} mineable), ${(tagJson.length / 1e6).toFixed(1)} MB`);

  const rs = recipes.stats;
  const pct = rs.files ? ((rs.parsed / rs.files) * 100).toFixed(1) : '0';
  console.log(`recipes: ${rs.parsed}/${rs.files} readable (${pct}%), ${rs.types} types`
    + `, ${(recipeJson.length / 1e6).toFixed(1)} MB`);
  if (rs.unreadable) {
    const worst = Object.entries(rs.unreadableTypes).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  ${rs.unreadable} unreadable: `
      + worst.map(([t, n]) => `${t} x${n}`).join(', '));
  }
  const json = Buffer.from(JSON.stringify(bundle));
  const gz = gzipSync(new Uint8Array(json), { level: 9 });
  writeAtomic(join(out, 'assets.json.gz'), gz);
  writeAtomic(join(out, 'assets.json'), json);

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
