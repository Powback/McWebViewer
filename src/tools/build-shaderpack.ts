/**
 * Offline shaderpack translator: a pack directory (or zip) in, a WGSL bundle out.
 *
 *   npx tsx src/tools/build-shaderpack.ts <packDir|zip> [--out <bundle.json>] [--dim world0]
 *
 * Why offline rather than in the browser: the translation is `glslang` + `naga`, two
 * native toolchains, and SHADERPACKS.md §8 already establishes that the browser API
 * accepting only WGSL "is irrelevant as an obstacle: the translation is a build step".
 * Doing it here also keeps the pack's own source out of the shipped bundle — Sildur's
 * licence forbids redistribution, so every artefact this writes stays under `.cache/`.
 *
 * Degrade, never refuse: a program that fails to translate is recorded with the actual
 * compiler message and the run continues. A pack at 95% is worth far more than a pack
 * rejected over its Distant Horizons passes.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { irisUniformLayout } from '../shaders/iris-uniforms.js';
import {
  classifySampler, mapFormat, stageOf, type SamplerRole,
} from '../shaders/iris-pipeline.js';
import {
  parseDrawBuffers, resolveIncludes, scrapeConsts, type PackFiles,
} from '../shaders/glsl-source.js';
import { planProgram, type Stage } from '../shaders/glsl-plan.js';
import { normaliseStageSource, uplift } from '../shaders/glsl-uplift.js';
import { hostDefines } from '../shaders/host-defines.js';
import {
  classifyFailure, parseBlockProperties, parseProperties, scrapeSettings,
} from '../shaders/pack-config.js';

const GLSLANG = process.env.MCWV_GLSLANG ?? 'glslangValidator';
const NAGA = process.env.MCWV_NAGA ?? `${process.env.HOME}/.cargo/bin/naga`;

interface Args {
  pack: string;
  out: string;
  dim: string;
  work: string;
}

function parseArgs(argv: string[]): Args {
  const pack = argv.find((a) => !a.startsWith('--')) ?? '';
  const opt = (name: string, def: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const id = basename(pack).replace(/\.zip$/i, '');
  return {
    pack,
    out: opt('--out', `.cache/shaderpacks/${id}.bundle.json`),
    dim: opt('--dim', 'shaders'),
    work: opt('--work', `.cache/shaderpacks/.build/${id}`),
  };
}

/* ------------------------------------------------------------------ pack loading */

/**
 * Shaderpacks ship CRLF. Every line-anchored regex in the translator — `#include`,
 * `varying`, `uniform`, `attribute` — ends with `$`, which a trailing `\r` defeats, so a
 * CRLF pack silently expands no includes at all and then fails to compile for reasons
 * that look nothing like the cause.
 */
function normaliseEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function loadFromDir(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, normaliseEol(readFileSync(full, 'latin1')));
    }
  };
  const shaders = join(root, 'shaders');
  walk(existsSync(shaders) ? shaders : root, '');
  return files;
}

function loadFromZip(zipPath: string): Map<string, string> {
  const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const files = new Map<string, string>();
  const decoder = new TextDecoder('latin1');
  for (const [path, data] of Object.entries(entries)) {
    const rel = path.replace(/^.*?shaders\//, '');
    if (rel.endsWith('/')) continue;
    files.set(rel, normaliseEol(decoder.decode(data)));
  }
  return files;
}

function packFiles(source: string): { files: Map<string, string>; api: PackFiles } {
  const files = statSync(source).isDirectory() ? loadFromDir(source) : loadFromZip(source);
  return {
    files,
    api: { has: (p) => files.has(p), read: (p) => files.get(p) ?? '' },
  };
}

/* ------------------------------------------------------------------ program discovery */

const STAGE_EXT: Record<string, Stage> = {
  vsh: 'vertex', fsh: 'fragment', csh: 'compute', gsh: 'geometry',
};

interface ProgramSources {
  readonly name: string;
  /** stage -> path within the pack */
  readonly stages: Map<Stage, string>;
}

/**
 * Programs come from the dimension folder if present, otherwise the pack root. Iris
 * resolves per dimension with the root as fallback; a pack that ships `world0/` copies
 * every program into it, so preferring the folder and filling gaps from the root matches.
 */
function listPrograms(files: Map<string, string>, dim: string): Map<string, ProgramSources> {
  const out = new Map<string, ProgramSources>();
  const prefix = dim === 'shaders' || dim === '' ? '' : `${dim}/`;
  for (const path of files.keys()) {
    const m = /^(.*)\.(vsh|fsh|csh|gsh)$/.exec(path);
    if (!m) continue;
    const inDim = prefix ? path.startsWith(prefix) : !path.includes('/');
    if (!inDim) continue;
    const name = prefix ? m[1].slice(prefix.length) : m[1];
    if (name.includes('/')) continue;
    const entry = out.get(name) ?? { name, stages: new Map<Stage, string>() };
    entry.stages.set(STAGE_EXT[m[2]], path);
    out.set(name, entry);
  }
  return out;
}

/* ------------------------------------------------------------------ compilation */

const GLSLANG_STAGE: Record<Stage, string> = {
  vertex: 'vert', fragment: 'frag', compute: 'comp', geometry: 'geom',
};

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` };
  }
}

export interface StageArtifact {
  readonly wgsl: string;
  readonly bindings: readonly ReflectedBinding[];
}

export interface ReflectedBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly wgslType: string;
}

const BINDING_RE = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)\s*:\s*([^;]+);/g;

/** What actually survived compilation — glslang eliminates unused uniforms, and the
 * runtime's bind group layout has to match reality rather than our intent. */
function reflectBindings(wgsl: string): ReflectedBinding[] {
  const out: ReflectedBinding[] = [];
  for (const m of wgsl.matchAll(BINDING_RE)) {
    out.push({
      group: Number(m[1]),
      binding: Number(m[2]),
      name: m[3],
      wgslType: m[4].trim(),
    });
  }
  return out;
}

function compileStage(
  glsl: string,
  stage: Stage,
  work: string,
  tag: string,
): { artifact?: StageArtifact; error?: string } {
  mkdirSync(work, { recursive: true });
  const src = join(work, `${tag}.glsl`);
  const spv = join(work, `${tag}.spv`);
  const wgslPath = join(work, `${tag}.wgsl`);
  writeFileSync(src, glsl);

  const gl = run(GLSLANG, [
    '-V', '--target-env', 'vulkan1.1', '-S', GLSLANG_STAGE[stage], src, '-o', spv,
  ]);
  if (!gl.ok) return { error: `glslang: ${firstError(gl.output)}` };

  // --keep-coordinate-space: naga's SPIR-V frontend assumes Vulkan conventions and flips
  // Y to reach WGSL's. Our source is OpenGL-authored GLSL, and OpenGL's NDC Y already
  // matches WGSL's, so that flip is a spurious second correction and mirrors the world.
  // The Z range genuinely does differ ([-w,w] vs [0,w]) and is fixed in the shader
  // epilogue instead — see CLIP_SPACE_FIXUP.
  const naga = run(NAGA, ['--keep-coordinate-space', spv, wgslPath]);
  if (!naga.ok) return { error: `naga: ${firstError(naga.output)}` };

  const wgsl = readFileSync(wgslPath, 'utf8');
  return { artifact: { wgsl, bindings: reflectBindings(wgsl) } };
}

function firstError(output: string): string {
  const lines = output.split('\n').filter((l) => /ERROR|error/.test(l) && !/\d+ error/.test(l));
  return (lines[0] ?? output.split('\n')[0] ?? 'unknown').trim().slice(0, 400);
}

/* ------------------------------------------------------------------ drawbuffers */

const MARKER = 'IRIS_DB_';

/**
 * The DRAWBUFFERS directive lives in a block comment, so it does not survive
 * preprocessing — and some files carry two behind `#ifdef` (this pack's
 * `gbuffers_water.fsh` has exactly that). Rewriting each into a token and running the
 * preprocessor tells us which one is actually live for the current settings.
 */
function activeDrawBuffers(
  source: string,
  work: string,
  tag: string,
): { targets: readonly number[]; note: string | null } {
  const all = [...source.matchAll(/\/\*\s*(?:DRAWBUFFERS|RENDERTARGETS)[^*]*\*\//g)];
  if (all.length === 0) return { targets: [], note: null };
  const first = parseDrawBuffers(all[0][0])?.targets ?? [];
  if (all.length === 1) return { targets: first, note: null };

  const marked = source.replace(/\/\*\s*((?:DRAWBUFFERS|RENDERTARGETS)[^*]*)\*\//g, (_m, body) => {
    const t = parseDrawBuffers(`/*${body}*/`)?.targets ?? [];
    return `\n${MARKER}${t.join('_')};\n`;
  });
  const path = join(work, `${tag}.db.glsl`);
  mkdirSync(work, { recursive: true });
  writeFileSync(path, marked);
  const pre = run(GLSLANG, ['-E', '-S', 'frag', path]);
  const found = pre.ok ? [...pre.output.matchAll(/IRIS_DB_([0-9_]+)/g)] : [];
  if (found.length === 0) {
    return { targets: first, note: `${all.length} DRAWBUFFERS variants; preprocessor did not resolve one, used the first` };
  }
  return {
    targets: found[0][1].split('_').filter((s) => s !== '').map(Number),
    note: found.length > 1 ? `${found.length} DRAWBUFFERS variants live; used the first` : null,
  };
}

/* ------------------------------------------------------------------ program build */

export interface ProgramResult {
  readonly name: string;
  readonly stage: string;
  readonly ok: boolean;
  readonly drawBuffers: readonly number[];
  readonly stages: Record<string, StageArtifact>;
  readonly attributes: readonly string[];
  readonly unknownAttributes: readonly string[];
  readonly uniforms: readonly string[];
  readonly unknownUniforms: readonly string[];
  readonly notes: readonly string[];
  /** declared sampler name -> what the Iris contract says it binds to */
  readonly samplerRoles: Record<string, SamplerRole>;
  readonly errors: Record<string, string>;
  readonly failureClass?: string;
}

interface BuildCtx {
  readonly api: PackFiles;
  readonly work: string;
  readonly defines: ReadonlyMap<string, string>;
}

function buildProgram(prog: ProgramSources, ctx: BuildCtx): ProgramResult {
  const layout = irisUniformLayout();
  const expanded = new Map<Stage, string>();
  for (const [stage, path] of prog.stages) {
    // Normalise before planning: the plan is keyed by declared names, and the sampler
    // rename changes one of them. See normaliseStageSource.
    expanded.set(stage, normaliseStageSource(resolveIncludes(ctx.api, path).source));
  }

  const fragSrc = expanded.get('fragment') ?? '';
  const db = activeDrawBuffers(fragSrc, ctx.work, prog.name);
  const plan = planProgram([...expanded.values()]);

  const stages: Record<string, StageArtifact> = {};
  const errors: Record<string, string> = {};
  const notes = db.note ? [db.note] : [];
  const meta = { attrs: new Set<string>(), unknownAttrs: new Set<string>(),
    uniforms: new Set<string>(), unknownUniforms: new Set<string>() };

  for (const [stage, src] of expanded) {
    const up = uplift(src, {
      stage, plan, layout, drawBuffers: db.targets, hostDefines: ctx.defines,
    });
    up.attributesUsed.forEach((a) => meta.attrs.add(a));
    up.unknownAttributes.forEach((a) => meta.unknownAttrs.add(a));
    up.uniformsUsed.forEach((u) => meta.uniforms.add(u));
    up.unknownUniforms.forEach((u) => meta.unknownUniforms.add(u));
    notes.push(...up.notes);

    const r = compileStage(up.code, stage, ctx.work, `${prog.name}.${stage}`);
    if (r.artifact) stages[stage] = r.artifact;
    else errors[stage] = r.error ?? 'unknown';
  }

  const ok = Object.keys(errors).length === 0 && Object.keys(stages).length > 0;
  return {
    name: prog.name,
    stage: stageOf(prog.name),
    ok,
    drawBuffers: db.targets,
    stages,
    attributes: [...meta.attrs],
    unknownAttributes: [...meta.unknownAttrs],
    uniforms: [...meta.uniforms],
    unknownUniforms: [...meta.unknownUniforms],
    notes,
    samplerRoles: Object.fromEntries(
      [...plan.samplers.values()].map((s) => [s.name, classifySampler(s.name, s.type).role]),
    ),
    errors,
    failureClass: ok ? undefined : classifyFailure(Object.values(errors).join(' ')),
  };
}

/* ------------------------------------------------------------------ pack-level data */

export interface ColorTexInfo {
  readonly index: number;
  readonly declared: string;
  readonly webgpu: string;
  readonly substitutedFor: string | null;
  readonly note: string | null;
}

function collectFormats(files: Map<string, string>): ColorTexInfo[] {
  const declared = new Map<number, string>();
  for (const src of files.values()) {
    for (const [i, fmt] of scrapeConsts(src).bufferFormats) declared.set(i, fmt);
  }
  const out: ColorTexInfo[] = [];
  for (const [index, fmt] of [...declared].sort((a, b) => a[0] - b[0])) {
    const mapped = mapFormat(fmt);
    out.push({
      index,
      declared: fmt,
      webgpu: mapped?.webgpu ?? 'rgba16float',
      substitutedFor: mapped ? mapped.substitutedFor : fmt,
      note: mapped ? mapped.note : `unrecognised format ${fmt}; defaulted to rgba16float`,
    });
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pack) {
    console.error('usage: build-shaderpack <packDir|zip> [--out f] [--dim world0]');
    process.exit(2);
  }
  const { files, api } = packFiles(resolve(args.pack));
  const programs = listPrograms(files, args.dim);
  const defines = hostDefines(scrapeSettings(files));

  console.log(`pack ${basename(args.pack)}: ${files.size} files, ${programs.size} programs`
    + ` in '${args.dim}'`);

  const results: Record<string, ProgramResult> = {};
  for (const prog of [...programs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const r = buildProgram(prog, { api, work: args.work, defines });
    results[prog.name] = r;
    const detail = r.ok ? 'ok' : Object.values(r.errors)[0];
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${prog.name.padEnd(32)} ${detail}`);
  }

  const bundle = {
    id: basename(args.pack).replace(/\.zip$/i, ''),
    dimension: args.dim,
    colortex: collectFormats(files),
    consts: serialiseConsts(files),
    properties: parseProperties(files.get('shaders.properties') ?? ''),
    blockIds: parseBlockProperties(files.get('block.properties') ?? ''),
    settings: Object.fromEntries(scrapeSettings(files)),
    programs: results,
  };
  mkdirSync(resolve(args.out, '..'), { recursive: true });
  writeFileSync(args.out, JSON.stringify(bundle));
  writeIndex(resolve(args.out, '..'));

  const pass = Object.values(results).filter((r) => r.ok).length;
  console.log(`\n${pass}/${programs.size} programs translated -> ${args.out}`);
}

/**
 * The list the in-page shaderpack selector reads, rebuilt from what is actually on disk.
 *
 * Written HERE rather than maintained by hand because a hand-written list goes stale the
 * first time someone builds a second pack, and a selector offering a pack that 404s is worse
 * than one offering none. The directory is the truth; this just publishes it.
 */
function writeIndex(dir: string): void {
  const packs = readdirSync(dir)
    .filter((f) => f.endsWith('.bundle.json'))
    .map((f) => ({ id: f.replace(/\.bundle\.json$/, '') }))
    .sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ packs }, null, 1));
}

function serialiseConsts(files: Map<string, string>) {
  let sunPathRotation: number | null = null;
  let shadowMapResolution: number | null = null;
  let shadowDistance: number | null = null;
  const shadowFiltering: Record<number, boolean> = {};
  for (const src of files.values()) {
    const c = scrapeConsts(src);
    sunPathRotation ??= c.sunPathRotation;
    shadowMapResolution ??= c.shadowMapResolution;
    shadowDistance ??= c.shadowDistance;
    for (const [i, v] of c.shadowFiltering) shadowFiltering[i] = v;
  }
  return { sunPathRotation, shadowMapResolution, shadowDistance, shadowFiltering };
}

main();
