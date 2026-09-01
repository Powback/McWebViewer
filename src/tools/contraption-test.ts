/**
 * Verifies the Create contraption decoder against the real reference world.
 * Scans entity regions for contraption entities and dumps their decoded block sets.
 *   npx tsx src/tools/contraption-test.ts [worldDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RegionFile } from '../core/region.js';
import type { NbtCompound, NbtList } from '../core/nbt.js';
import { decodeContraption, isContraptionId } from '../render/entities.js';

const world = process.argv[2] ?? '/Users/macback/Projects/minecraft-create121/data/world';
const found: NbtCompound[] = [];

/** Appends every contraption entity stored in one entity chunk to `out`. */
function collectFromChunk(root: NbtCompound, out: NbtCompound[]) {
  for (const raw of ((root.Entities as NbtList) ?? [])) {
    const ent = raw as NbtCompound;
    if (isContraptionId((ent.id as string) ?? '')) out.push(ent);
  }
}

/** Walks one entity region file, skipping chunks that fail to decompress. */
function collectFromRegionFile(dir: string, file: string, out: NbtCompound[]) {
  const c = RegionFile.parseName(file);
  if (!c) return;
  const buf = new Uint8Array(readFileSync(join(dir, file)));
  if (!buf.byteLength) return;
  const region = new RegionFile(buf, c.x, c.z);
  for (const e of region.entries()) {
    let root;
    try { root = region.chunk(e.localX, e.localZ); } catch { continue; }
    if (!root) continue;
    collectFromChunk(root, out);
  }
}

for (const base of [world, join(world, 'DIM-1'), join(world, 'DIM1')]) {
  const dir = join(base, 'entities');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mca'))) {
    collectFromRegionFile(dir, f, found);
  }
}

console.log(`contraption entities found: ${found.length}`);
for (const ent of found) {
  const d = decodeContraption(ent);
  if (!d) { console.log(`  ${ent.id}: DECODE FAILED`); continue; }
  const names = new Map<string, number>();
  for (const b of d.blocks) names.set(b.stateKey, (names.get(b.stateKey) ?? 0) + 1);
  const xs = d.blocks.map((b) => b.x), ys = d.blocks.map((b) => b.y), zs = d.blocks.map((b) => b.z);
  console.log(`\n${d.id}`);
  console.log(`  pos    ${d.pos.map((n) => n.toFixed(1)).join(', ')}`);
  console.log(`  angle  ${d.angle.toFixed(2)} about ${d.axis}`);
  console.log(`  anchor ${d.anchor?.join(', ') ?? 'none'}`);
  console.log(`  blocks ${d.blocks.length}, ${names.size} distinct states`);
  console.log(`  bounds x[${Math.min(...xs)}..${Math.max(...xs)}] y[${Math.min(...ys)}..${Math.max(...ys)}] z[${Math.min(...zs)}..${Math.max(...zs)}]`);
  console.log(`  states:`);
  for (const [k, v] of [...names].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(v).padStart(4)}  ${k}`);
  }
}
