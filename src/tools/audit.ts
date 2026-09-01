/**
 * COVERAGE AUDIT — the project's primary success metric.
 *
 * Takes the inventory of everything actually present in the reference world (every
 * distinct block state, block-entity type and entity type) and reports, for each, which
 * rendering path supplies its geometry. The number that matters is `unhandled`: the
 * count of things that would render as nothing.
 *
 * Run:
 *   npx tsx src/tools/audit.ts <worldDir> [--mods <dir>] [--client <jar>]
 *                              [--inventory out/inventory.json] [--json out/audit.json]
 *
 * This is deliberately a repeatable command, not a one-off measurement.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PackStack, ZipPack, texturePath } from '../assets/pack.js';
import { BlockRegistry, splitStateKey, type RenderableState } from '../render/registry.js';
import { scanWorld, type Inventory } from './scan-world.js';
import { ENTITY_STRATEGY, classifyEntity, type EntityStrategy } from '../render/entities.js';
import {
  makeEntityModelSet,
  type EntityIndex,
  type EntityModelSet,
  type EntityModels,
} from '../render/entity-geometry.js';

const DEFAULTS = {
  mods: '/Users/macback/Projects/minecraft-create121/data/mods',
  client: '.cache/client-1.21.1.jar',
  entityModels: 'harness/out/entity-models.json',
  entityIndex: 'harness/out/entity-index.json',
};

/** How a block state obtains geometry. */
type BlockPath =
  | 'asset' // blockstate JSON -> model JSON -> quads
  | 'asset-custom-loader' // model declares a NeoForge/mod custom loader
  | 'fluid' // generated geometry (water/lava)
  | 'air' // intentionally nothing
  // base model is empty AND we supply the geometry ourselves (ber-models.ts). Counted as
  // rendered, but reported separately — this geometry is authored from vanilla's Java
  // models rather than read from assets, so it deserves its own line in the report.
  | 'block-entity-synthesized'
  // base model is empty and nothing supplies the geometry: renders as nothing.
  | 'block-entity'
  | 'unhandled';

function loadPacks(modsDir: string, clientJar: string): PackStack {
  const stack = new PackStack();
  if (existsSync(clientJar)) {
    stack.add(ZipPack.fromZip('client-1.21.1.jar', new Uint8Array(readFileSync(clientJar))));
  } else {
    console.warn(`WARNING: no vanilla client jar at ${clientJar} — vanilla blocks will all`
      + ` report unhandled. Run: npm run fetch-assets`);
  }
  if (existsSync(modsDir)) {
    for (const f of readdirSync(modsDir).filter((f) => f.endsWith('.jar')).sort()) {
      try {
        stack.add(ZipPack.fromZip(f, new Uint8Array(readFileSync(join(modsDir, f)))));
      } catch (e) {
        console.warn(`  skipped ${f}: ${(e as Error).message}`);
      }
    }
  }
  return stack;
}

export interface AuditResult {
  blockStates: Record<BlockPath, string[]>;
  blockStateCounts: Record<BlockPath, number>;
  entities: Record<EntityStrategy, string[]>;
  totals: {
    blockStates: number;
    blockStatesUnhandled: number;
    entityTypes: number;
    entityTypesUnhandled: number;
  };
}

/**
 * Which path supplied this state's geometry. Everything here reads the registry's own
 * structural classification — there is no block-name table.
 */
function classifyBlockState(st: RenderableState): BlockPath {
  if (st.provenance === 'air') return 'air';
  if (st.provenance === 'fluid') return 'fluid';
  if (st.provenance === 'extracted') return 'block-entity-synthesized';
  if (st.provenance === 'block-entity') return 'block-entity';
  if (st.quads.length > 0) return st.usedCustomLoader ? 'asset-custom-loader' : 'asset';
  return 'unhandled';
}

/**
 * The extracted Java entity models, with the texture test wired to the real pack stack.
 * A type only counts as covered when its texture is genuinely in one of the jars —
 * otherwise the renderer would emit quads that sample nothing, and calling that "rendered"
 * would inflate the number this whole tool exists to keep honest.
 */
function loadEntityGeometry(opts: AuditOptions, stack: PackStack): EntityModelSet | null {
  if (!existsSync(opts.entityModels) || !existsSync(opts.entityIndex)) {
    console.warn(`WARNING: no entity extraction at ${opts.entityModels} — every mob will`
      + ` report java-model.`);
    return null;
  }
  const models = JSON.parse(readFileSync(opts.entityModels, 'utf8')) as EntityModels;
  const index = JSON.parse(readFileSync(opts.entityIndex, 'utf8')) as EntityIndex;
  const set = makeEntityModelSet(models, index);
  set.useTextureFilter((spriteId) => stack.has(texturePath(spriteId)));
  return set;
}

interface AuditOptions {
  worldDir: string;
  modsDir: string;
  clientJar: string;
  invPath: string;
  jsonOut: string;
  entityModels: string;
  entityIndex: string;
}

function parseArgs(args: string[]): AuditOptions {
  const arg = (n: string, d: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  return {
    worldDir: args[0] && !args[0].startsWith('--')
      ? args[0]
      : '/Users/macback/Projects/minecraft-create121/data/world',
    modsDir: arg('--mods', DEFAULTS.mods),
    clientJar: arg('--client', DEFAULTS.client),
    invPath: arg('--inventory', 'out/inventory.json'),
    jsonOut: arg('--json', 'out/audit.json'),
    entityModels: arg('--entity-models', DEFAULTS.entityModels),
    entityIndex: arg('--entity-index', DEFAULTS.entityIndex),
  };
}

/** Reuses a previously written inventory when one exists, otherwise rescans the world. */
function loadInventory(invPath: string, worldDir: string): Inventory {
  if (existsSync(invPath)) {
    console.log(`using cached inventory ${invPath}`);
    return JSON.parse(readFileSync(invPath, 'utf8')) as Inventory;
  }
  console.log(`scanning ${worldDir} ...`);
  return scanWorld(worldDir);
}

function classifyBlockStates(inv: Inventory, registry: BlockRegistry): Record<BlockPath, string[]> {
  const blockStates: Record<BlockPath, string[]> = {
    asset: [], 'asset-custom-loader': [], fluid: [], air: [],
    'block-entity-synthesized': [], 'block-entity': [], unhandled: [],
  };

  for (const key of Object.keys(inv.blockStates)) {
    blockStates[classifyBlockState(registry.resolve(key))].push(key);
  }
  return blockStates;
}

function classifyEntities(
  inv: Inventory,
  geometry: EntityModelSet | null,
): Record<EntityStrategy, string[]> {
  const entities: Record<EntityStrategy, string[]> = {
    'block-model': [], contraption: [], 'extracted-model': [], 'java-model': [],
    invisible: [], unhandled: [],
  };
  for (const id of Object.keys(inv.entityTypes)) {
    entities[classifyEntity(id, geometry ?? undefined)].push(id);
  }
  return entities;
}

/** States whose geometry actually reaches the screen today. */
function renderedCount(counts: Record<BlockPath, number>): number {
  return (
    counts.asset + counts['asset-custom-loader'] + counts.fluid + counts.air +
    counts['block-entity-synthesized']
  );
}

function printBlockStateCoverage(counts: Record<BlockPath, number>, total: number, rendered: number) {
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log('\n================ BLOCK STATE COVERAGE ================');
  console.log(`total distinct block states in world: ${total}`);
  const order: BlockPath[] = [
    'asset', 'asset-custom-loader', 'fluid', 'air',
    'block-entity-synthesized', 'block-entity', 'unhandled',
  ];
  for (const k of order) {
    console.log(`  ${k.padEnd(20)} ${String(counts[k]).padStart(5)}  ${pct(counts[k])}`);
  }
  console.log(`  ${'-> RENDERED'.padEnd(20)} ${String(rendered).padStart(5)}  ${pct(rendered)}`);
  console.log(`  ${'-> NOT RENDERED'.padEnd(20)} ${String(total - rendered).padStart(5)}  ${pct(total - rendered)}`);
}

function printUnhandledBlockStates(unhandled: string[]) {
  if (unhandled.length) {
    console.log('\nUNHANDLED block states (no geometry from any path):');
    for (const k of unhandled.slice(0, 60)) console.log('   ' + k);
    if (unhandled.length > 60) {
      console.log(`   ... and ${unhandled.length - 60} more`);
    }
  }
}

function printBlockEntityStates(blockEntityStates: string[]) {
  if (blockEntityStates.length) {
    console.log('\nBLOCK-ENTITY states (need the geometry-capture path, not JSON):');
    const names = new Set(blockEntityStates.map((k) => splitStateKey(k).name));
    console.log('   ' + [...names].join(', '));
  }
}

/** Entity types whose geometry actually reaches the screen today. */
function renderedEntityCount(entities: Record<EntityStrategy, string[]>): number {
  return (
    entities['block-model'].length + entities.contraption.length +
    entities['extracted-model'].length + entities.invisible.length
  );
}

function printEntityCoverage(entities: Record<EntityStrategy, string[]>, entityTypes: number) {
  const pct = (n: number) => `${((n / entityTypes) * 100).toFixed(1)}%`;
  console.log('\n================ ENTITY COVERAGE ================');
  console.log(`total distinct entity types in world: ${entityTypes}`);
  const listed: EntityStrategy[] = ['extracted-model', 'java-model'];
  for (const k of Object.keys(entities) as EntityStrategy[]) {
    console.log(`  ${k.padEnd(20)} ${String(entities[k].length).padStart(5)}`);
    if (entities[k].length && !listed.includes(k)) console.log('      ' + entities[k].join(', '));
  }
  const rendered = renderedEntityCount(entities);
  console.log(`  ${'-> RENDERED'.padEnd(20)} ${String(rendered).padStart(5)}  ${pct(rendered)}`);
  console.log(
    `  ${'-> NOT RENDERED'.padEnd(20)} ${String(entityTypes - rendered).padStart(5)}` +
      `  ${pct(entityTypes - rendered)}`,
  );
  if (entities['extracted-model'].length) {
    console.log('\n  extracted-model (Java LayerDefinition captured offline, drawn as quads):');
    console.log('      ' + entities['extracted-model'].join(', '));
  }
  if (entities['java-model'].length) {
    console.log('\n  java-model (geometry is Java and the extraction has none for it):');
    console.log('      ' + entities['java-model'].join(', '));
  }
}

function printHeadline(result: AuditResult, total: number, rendered: number) {
  console.log('\n================ HEADLINE ================');
  console.log(`block states not rendered: ${total - rendered} / ${total}`);
  console.log(`entity types not rendered: ${result.totals.entityTypesUnhandled} / ${result.totals.entityTypes}`);
}

function buildResult(
  inv: Inventory,
  blockStates: Record<BlockPath, string[]>,
  entities: Record<EntityStrategy, string[]>,
): AuditResult {
  const counts = Object.fromEntries(
    Object.entries(blockStates).map(([k, v]) => [k, v.length]),
  ) as Record<BlockPath, number>;

  const total = Object.keys(inv.blockStates).length;
  return {
    blockStates,
    blockStateCounts: counts,
    entities,
    totals: {
      blockStates: total,
      blockStatesUnhandled: counts.unhandled + counts['block-entity'],
      entityTypes: Object.keys(inv.entityTypes).length,
      entityTypesUnhandled: entities.unhandled.length + entities['java-model'].length,
    },
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const inv = loadInventory(opts.invPath, opts.worldDir);

  console.log(`loading asset packs ...`);
  const stack = loadPacks(opts.modsDir, opts.clientJar);
  console.log(`  ${stack.packs.length} packs`);

  const registry = new BlockRegistry(stack);
  const entityGeometry = loadEntityGeometry(opts, stack);

  const blockStates = classifyBlockStates(inv, registry);
  const entities = classifyEntities(inv, entityGeometry);

  const result = buildResult(inv, blockStates, entities);
  const counts = result.blockStateCounts;
  const total = result.totals.blockStates;

  // ---- report ----
  const rendered = renderedCount(counts);
  printBlockStateCoverage(counts, total, rendered);
  printUnhandledBlockStates(blockStates.unhandled);
  printBlockEntityStates(blockStates['block-entity']);
  printEntityCoverage(entities, result.totals.entityTypes);
  printHeadline(result, total, rendered);

  writeFileSync(opts.jsonOut, JSON.stringify(result, null, 1));
  console.log(`\nwrote ${opts.jsonOut}`);
  void ENTITY_STRATEGY;
}

main();
