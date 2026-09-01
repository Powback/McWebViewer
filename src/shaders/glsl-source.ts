/**
 * Everything that has to happen to a shaderpack file before a compiler may see it.
 *
 * Two things here are not obvious and are the reason "just feed it to a compiler" does not
 * work in either direction:
 *
 *  - `#include` uses Iris semantics, not C's: a leading `/` resolves from the pack's
 *    `shaders/` root, anything else relative to the including file. Real packs use both.
 *  - The buffer format table (`const int colortexNFormat = ...`) is deliberately written
 *    *inside a block comment*, because the format names are not GLSL. The host must
 *    text-scrape them and the compiler must never see them. Same for
 *    `shadowHardwareFiltering` and `sunPathRotation`.
 */

export interface PackFiles {
  /** path relative to `shaders/`, e.g. `world0/composite1.fsh` */
  has(path: string): boolean;
  read(path: string): string;
}

function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Iris resolution: absolute from the shaders root, relative to the including file. */
export function resolveIncludePath(spec: string, includedFrom: string): string {
  if (spec.startsWith('/')) return normalise(spec);
  return normalise(`${dirOf(includedFrom)}/${spec}`);
}

const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/;

export interface IncludeResult {
  readonly source: string;
  readonly included: readonly string[];
  readonly missing: readonly string[];
}

interface IncludeState {
  readonly files: PackFiles;
  readonly out: string[];
  readonly included: string[];
  readonly missing: string[];
  depth: number;
}

function expandLine(state: IncludeState, line: string, from: string): void {
  const m = INCLUDE_RE.exec(line);
  if (!m) {
    state.out.push(line);
    return;
  }
  const path = resolveIncludePath(m[1], from);
  if (!state.files.has(path)) {
    state.missing.push(path);
    state.out.push(`// [mcwv] missing include: ${path}`);
    return;
  }
  state.included.push(path);
  expandInto(state, state.files.read(path), path);
}

function expandInto(state: IncludeState, source: string, from: string): void {
  if (state.depth > 32) {
    state.out.push(`// [mcwv] include depth exceeded at ${from}`);
    return;
  }
  state.depth++;
  // `#line` keeps glslang's diagnostics pointing at the pack's own files, which is the
  // difference between a usable error and a line number in a 18,000-line paste.
  state.out.push(`#line 1 // ${from}`);
  for (const line of source.split('\n')) expandLine(state, line, from);
  state.depth--;
}

export function resolveIncludes(files: PackFiles, entry: string): IncludeResult {
  const state: IncludeState = { files, out: [], included: [], missing: [], depth: 0 };
  expandInto(state, files.read(entry), entry);
  return { source: state.out.join('\n'), included: state.included, missing: state.missing };
}

/* ------------------------------------------------------------------ directive scraping */

export interface DrawBuffers {
  /** colortex index per fragment output location */
  readonly targets: readonly number[];
  readonly directive: string;
}

/**
 * `/ * DRAWBUFFERS:412 * /` — one digit per output, and
 * `/ * RENDERTARGETS: 0,3,7 * /` — comma-separated, which is the only form that can name
 * buffer 10 and above.
 */
export function parseDrawBuffers(text: string): DrawBuffers | null {
  const rt = /RENDERTARGETS[ \t]*:[ \t]*([0-9, \t]+)/.exec(text);
  if (rt) {
    const targets = rt[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    return { targets, directive: rt[0].trim() };
  }
  const db = /DRAWBUFFERS[ \t]*:[ \t]*([0-9]+)/.exec(text);
  if (!db) return null;
  return { targets: [...db[1]].map((c) => Number(c)), directive: db[0].trim() };
}

export interface ScrapedConsts {
  /** colortex index -> declared format name, e.g. 4 -> 'R11F_G11F_B10F' */
  readonly bufferFormats: ReadonlyMap<number, string>;
  /** shadowtex index -> hardware (comparison) filtering requested */
  readonly shadowFiltering: ReadonlyMap<number, boolean>;
  readonly sunPathRotation: number | null;
  readonly shadowMapResolution: number | null;
  readonly shadowDistance: number | null;
}

const FORMAT_RE = /const\s+int\s+(colortex|shadowcolor|gaux|gcolor|gdepth|gnormal|composite)(\d*)Format\s*=\s*([A-Za-z0-9_]+)\s*;/g;
const HW_FILTER_RE = /const\s+bool\s+shadowHardwareFiltering(\d*)\s*=\s*(true|false)\s*;/g;
const FLOAT_CONST_RE = (name: string) =>
  new RegExp(`const\\s+(?:float|int)\\s+${name}\\s*=\\s*(-?[0-9.]+)`);

/**
 * Scrapes the whole file *including comment bodies* — that is where the format table
 * lives, and it is the documented way for a pack to declare one.
 */
export function scrapeConsts(text: string): ScrapedConsts {
  const bufferFormats = new Map<number, string>();
  for (const m of text.matchAll(FORMAT_RE)) {
    const index = m[2] === '' ? legacyIndex(m[1]) : Number(m[2]);
    if (index >= 0) bufferFormats.set(index, m[3]);
  }
  const shadowFiltering = new Map<number, boolean>();
  for (const m of text.matchAll(HW_FILTER_RE)) {
    shadowFiltering.set(m[1] === '' ? 0 : Number(m[1]), m[2] === 'true');
  }
  return {
    bufferFormats,
    shadowFiltering,
    sunPathRotation: scrapeNumber(text, 'sunPathRotation'),
    shadowMapResolution: scrapeNumber(text, 'shadowMapResolution'),
    shadowDistance: scrapeNumber(text, 'shadowDistance'),
  };
}

function scrapeNumber(text: string, name: string): number | null {
  const m = FLOAT_CONST_RE(name).exec(text);
  return m ? Number(m[1]) : null;
}

function legacyIndex(name: string): number {
  const table: Record<string, number> = { gcolor: 0, gdepth: 1, gnormal: 2, composite: 3 };
  return table[name] ?? -1;
}
