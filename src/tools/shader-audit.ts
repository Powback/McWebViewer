/**
 * Shaderpack coverage audit: per pack, per pass — translated / skipped, each skip with a
 * reason and its class.
 *
 *   npx tsx src/tools/shader-audit.ts .cache/shaderpacks/*.bundle.json
 *
 * The classes come from SHADERPACKS.md §5 and the distinction is the whole point: of 149
 * failures across the four-pack corpus, only 3 were inherent to WebGPU. Reporting a bare
 * failure count invites reading "12 failures" as "12 things WebGPU cannot do", when almost
 * all of them are a transformer gap or a documented mechanical rewrite.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { stageOf } from '../shaders/iris-pipeline.js';
import type { BundleProgram, ShaderBundle } from '../shaders/bundle.js';

interface PassRow {
  pack: string;
  program: string;
  stage: string;
  translated: boolean;
  reason: string | null;
  failureClass: string | null;
  drawBuffers: readonly number[];
  unknownUniforms: readonly string[];
  notes: readonly string[];
}

function rowFor(pack: string, p: BundleProgram): PassRow {
  return {
    pack,
    program: p.name,
    stage: stageOf(p.name),
    translated: p.ok,
    reason: p.ok ? null : (Object.values(p.errors)[0] ?? 'unknown'),
    failureClass: p.ok ? null : (p.failureClass ?? 'unknown'),
    drawBuffers: p.drawBuffers,
    unknownUniforms: p.unknownUniforms,
    notes: p.notes,
  };
}

function tally<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function printPerStage(rows: readonly PassRow[]): void {
  console.log('\nper pass type');
  console.log('  stage         translated  total   rate');
  for (const [stage, list] of [...tally(rows, (r) => r.stage)].sort()) {
    const ok = list.filter((r) => r.translated).length;
    console.log(
      `  ${stage.padEnd(13)} ${String(ok).padStart(9)}  ${String(list.length).padStart(5)}`
      + `   ${pct(ok, list.length).padStart(6)}`,
    );
  }
}

function printSkips(rows: readonly PassRow[]): void {
  const failed = rows.filter((r) => !r.translated);
  if (!failed.length) {
    console.log('\nno skipped passes');
    return;
  }
  console.log(`\nskipped (${failed.length})`);
  for (const r of failed) {
    console.log(`  ${r.pack}/${r.program}  [${r.failureClass}]`);
    console.log(`      ${r.reason}`);
  }
  console.log('\nby class');
  for (const [cls, list] of tally(failed, (r) => r.failureClass ?? 'unknown')) {
    console.log(`  ${cls.padEnd(14)} ${list.length}`);
  }
}

function printFormats(bundles: readonly ShaderBundle[]): void {
  console.log('\nbuffer formats');
  for (const b of bundles) {
    for (const c of b.colortex) {
      const note = c.substitutedFor ? `  SUBSTITUTED: ${c.note}` : '';
      console.log(`  ${b.id} colortex${c.index}  ${c.declared} -> ${c.webgpu}${note}`);
    }
  }
}

function main(): void {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: shader-audit <bundle.json ...>');
    process.exit(2);
  }
  const bundles = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ShaderBundle);
  const rows: PassRow[] = [];
  for (const b of bundles) {
    for (const p of Object.values(b.programs)) rows.push(rowFor(b.id, p));
  }

  console.log('=== shaderpack coverage ===');
  for (const b of bundles) {
    const mine = rows.filter((r) => r.pack === b.id);
    const ok = mine.filter((r) => r.translated).length;
    console.log(`\n${b.id} (${basename(b.dimension || 'shaders')}):`
      + ` ${ok}/${mine.length} programs translated  ${pct(ok, mine.length)}`);
    for (const r of mine.sort((a, c) => a.program.localeCompare(c.program))) {
      const flag = r.translated ? 'ok  ' : 'SKIP';
      const db = r.drawBuffers.length ? ` -> colortex[${r.drawBuffers.join(',')}]` : '';
      console.log(`  ${flag} ${r.program.padEnd(30)}${db}`);
    }
  }

  printPerStage(rows);
  printSkips(rows);
  printFormats(bundles);

  const unknown = new Set(rows.flatMap((r) => r.unknownUniforms));
  if (unknown.size) {
    console.log(`\nuniforms bound to zero (not in the Iris table): ${[...unknown].join(', ')}`);
  }

  mkdirSync('out', { recursive: true });
  writeFileSync('out/shader-audit.json', JSON.stringify({ rows }, null, 2));
  console.log('\nwrote out/shader-audit.json');
}

main();
