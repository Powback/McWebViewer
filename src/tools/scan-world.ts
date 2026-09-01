/**
 * Scans a save directory and produces the world inventory: every distinct block
 * state, block-entity type and entity type actually present, with counts.
 *
 * This is the denominator of the coverage audit. Run:
 *   npx tsx src/tools/scan-world.ts <worldDir> [--out inventory.json] [--limit N]
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RegionFile, ExternalChunkError, type ChunkEntry } from '../core/region.js';
import { decodeChunk } from '../core/chunk.js';
import { parseNbt, type NbtCompound, type NbtList } from '../core/nbt.js';

export interface Inventory {
  world: string;
  dimensions: string[];
  chunksScanned: number;
  chunksFailed: number;
  blockStates: Record<string, number>;
  blockNames: Record<string, number>;
  blockEntityTypes: Record<string, number>;
  entityTypes: Record<string, number>;
  biomes: Record<string, number>;
  dataVersions: Record<string, number>;
  errors: string[];
}

function bump(m: Record<string, number>, k: string, n = 1) {
  m[k] = (m[k] ?? 0) + n;
}

export function scanWorld(worldDir: string, opts: { limitRegions?: number } = {}): Inventory {
  const inv: Inventory = {
    world: worldDir,
    dimensions: [],
    chunksScanned: 0,
    chunksFailed: 0,
    blockStates: {},
    blockNames: {},
    blockEntityTypes: {},
    entityTypes: {},
    biomes: {},
    dataVersions: {},
    errors: [],
  };

  const dims: Array<{ name: string; base: string }> = [{ name: 'overworld', base: worldDir }];
  for (const d of ['DIM-1', 'DIM1']) {
    if (existsSync(join(worldDir, d))) dims.push({ name: d, base: join(worldDir, d) });
  }

  for (const dim of dims) {
    inv.dimensions.push(dim.name);
    scanRegionDir(join(dim.base, 'region'), inv, 'block', opts);
    scanRegionDir(join(dim.base, 'entities'), inv, 'entity', opts);
  }
  return inv;
}

function scanRegionDir(
  dir: string,
  inv: Inventory,
  kind: 'block' | 'entity',
  opts: { limitRegions?: number },
) {
  if (!existsSync(dir)) return;
  let files = readdirSync(dir).filter((f) => f.endsWith('.mca'));
  if (opts.limitRegions) files = files.slice(0, opts.limitRegions);

  for (const f of files) scanRegionFile(dir, f, inv, kind);
}

/**
 * Opens one .mca file and ingests every chunk it holds. A file that cannot be read or
 * whose header does not parse is recorded as an error and skipped whole.
 */
function scanRegionFile(dir: string, f: string, inv: Inventory, kind: 'block' | 'entity') {
  const coords = RegionFile.parseName(f);
  if (!coords) return;
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(readFileSync(join(dir, f)));
  } catch (e) {
    inv.errors.push(`${f}: ${(e as Error).message}`);
    return;
  }
  if (buf.byteLength === 0) return;
  let region: RegionFile;
  try {
    region = new RegionFile(buf, coords.x, coords.z);
  } catch (e) {
    inv.errors.push(`${f}: ${(e as Error).message}`);
    return;
  }
  for (const e of region.entries()) scanChunkEntry(region, e, f, inv, kind);
}

/** Ingests a single chunk; a chunk that fails to decode counts as failed, never fatal. */
function scanChunkEntry(
  region: RegionFile,
  e: ChunkEntry,
  f: string,
  inv: Inventory,
  kind: 'block' | 'entity',
) {
  try {
    const root = region.chunk(e.localX, e.localZ);
    if (!root) return;
    if (kind === 'block') ingestBlockChunk(root, inv);
    else ingestEntityChunk(root, inv);
    inv.chunksScanned++;
  } catch (err) {
    inv.chunksFailed++;
    const msg = err instanceof ExternalChunkError ? err.message : (err as Error).message;
    if (inv.errors.length < 40) inv.errors.push(`${f}[${e.localX},${e.localZ}]: ${msg}`);
  }
}

function ingestBlockChunk(root: NbtCompound, inv: Inventory) {
  const c = decodeChunk(root);
  bump(inv.dataVersions, String(c.dataVersion));

  for (const s of c.sections) {
    if (!s.blockIndices) {
      // Uniform section: 4096 of palette[0]
      if (s.palette.length) {
        const p = s.palette[0];
        bump(inv.blockStates, p.key, 4096);
        bump(inv.blockNames, p.name, 4096);
      }
    } else {
      // Count per palette entry via a histogram — far cheaper than 4096 map writes.
      const hist = new Uint32Array(s.palette.length);
      const idx = s.blockIndices;
      for (let i = 0; i < idx.length; i++) hist[idx[i]]++;
      for (let p = 0; p < s.palette.length; p++) {
        if (!hist[p]) continue;
        bump(inv.blockStates, s.palette[p].key, hist[p]);
        bump(inv.blockNames, s.palette[p].name, hist[p]);
      }
    }
    for (const b of s.biomePalette) bump(inv.biomes, b);
  }

  for (const be of c.blockEntities) {
    const id = (be.id as string) ?? '<missing id>';
    bump(inv.blockEntityTypes, id);
  }
}

function ingestEntityChunk(root: NbtCompound, inv: Inventory) {
  const list = (root.Entities as NbtList) ?? [];
  for (const raw of list) collectEntity(raw as NbtCompound, inv);
}

function collectEntity(e: NbtCompound, inv: Inventory) {
  const id = (e.id as string) ?? '<missing id>';
  bump(inv.entityTypes, id);
  // Passengers and vehicles nest arbitrarily deep (minecarts, boats, Create carriages).
  const pass = e.Passengers as NbtList | undefined;
  if (Array.isArray(pass)) for (const p of pass) collectEntity(p as NbtCompound, inv);
}

export function sortedTop(m: Record<string, number>, n = Infinity): Array<[string, number]> {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

if (process.argv[1] && process.argv[1].endsWith('scan-world.ts')) {
  const args = process.argv.slice(2);
  const world = args[0];
  if (!world) {
    console.error('usage: tsx src/tools/scan-world.ts <worldDir> [--out file.json] [--limit N]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const limIdx = args.indexOf('--limit');
  const t0 = Date.now();
  const inv = scanWorld(world, {
    limitRegions: limIdx >= 0 ? Number(args[limIdx + 1]) : undefined,
  });
  const dt = (Date.now() - t0) / 1000;

  console.log(`world:              ${inv.world}`);
  console.log(`dimensions:         ${inv.dimensions.join(', ')}`);
  console.log(`chunks scanned:     ${inv.chunksScanned}  (failed: ${inv.chunksFailed})`);
  console.log(`scan time:          ${dt.toFixed(1)}s  (${(inv.chunksScanned / dt).toFixed(0)} chunks/s)`);
  console.log(`DataVersions:       ${sortedTop(inv.dataVersions).map(([k, v]) => `${k}(${v})`).join(' ')}`);
  console.log(`distinct block states:  ${Object.keys(inv.blockStates).length}`);
  console.log(`distinct block names:   ${Object.keys(inv.blockNames).length}`);
  console.log(`distinct block entities:${Object.keys(inv.blockEntityTypes).length}`);
  console.log(`distinct entity types:  ${Object.keys(inv.entityTypes).length}`);
  console.log(`distinct biomes:        ${Object.keys(inv.biomes).length}`);
  console.log('\ntop 15 blocks:');
  for (const [k, v] of sortedTop(inv.blockNames, 15)) console.log(`  ${v.toString().padStart(10)}  ${k}`);
  console.log('\nblock entity types:');
  for (const [k, v] of sortedTop(inv.blockEntityTypes, 30)) console.log(`  ${v.toString().padStart(8)}  ${k}`);
  console.log('\nentity types:');
  for (const [k, v] of sortedTop(inv.entityTypes, 30)) console.log(`  ${v.toString().padStart(8)}  ${k}`);
  if (inv.errors.length) {
    console.log(`\nerrors (${inv.errors.length} shown, up to 40):`);
    for (const e of inv.errors.slice(0, 10)) console.log('  ' + e);
  }
  if (outIdx >= 0) {
    writeFileSync(args[outIdx + 1], JSON.stringify(inv, null, 1));
    console.log(`\nwrote ${args[outIdx + 1]}`);
  }
}
void parseNbt;
