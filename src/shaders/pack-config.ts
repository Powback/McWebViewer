/**
 * `shaders.properties`, `block.properties` and the settings scraper.
 *
 * Three things here are scrapers rather than parsers, and that is not laziness — it is
 * how the format works:
 *
 *  - a setting's allowed values live in a *trailing comment* (`// [1 2 3]`) next to the
 *    `#define`, because GLSL has nowhere else to put them;
 *  - `block.properties` maps a pack-defined integer id onto block states, and the shader
 *    reads it as `mc_Entity.x` — so the mesher's vertex data is coupled to the loaded
 *    pack, which is the expensive half of shaderpack support for this project;
 *  - `shaders.properties` carries an embedded expression language for custom uniforms and
 *    `program.*.enabled`, which is evaluated per frame.
 */

/** `#define NAME value // [a b c]` — the comment is the schema. */
const SETTING_RE = /^[ \t]*#define[ \t]+(\w+)(?:[ \t]+([^\s/][^/\n]*?))?[ \t]*(?:\/\/[^\n]*)?$/gm;

/**
 * Default values for every option the pack declares. Read from all files because packs
 * split their settings across `shaders.settings` and the program headers.
 */
export function scrapeSettings(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, src] of files) {
    if (!/\.(settings|glsl|vsh|fsh|csh|gsh|properties)$/.test(path)) continue;
    for (const m of src.matchAll(SETTING_RE)) {
      out.set(m[1], (m[2] ?? '').trim());
    }
  }
  return out;
}

export interface PackProperties {
  /** raw key -> value, with line continuations joined */
  readonly entries: Record<string, string>;
  /** `program.<name>.enabled` expressions, unevaluated */
  readonly programEnabled: Record<string, string>;
  /** `uniform.<type>.<name> = expr` custom uniforms */
  readonly customUniforms: Record<string, { type: string; expr: string }>;
  /** `image.<name> = <sampler> ...` — Iris injects a sampler uniform per line */
  readonly images: Record<string, string>;
  /** `flip.<program>.<buffer> = false` overrides of the automatic ping-pong */
  readonly flips: Record<string, boolean>;
}

/**
 * `shaders.properties` is a Java properties file with `#if`/`#else` preprocessor lines in
 * it. The conditionals are dropped rather than evaluated: they gate optional settings, and
 * taking every branch's value is closer to the pack's intent than taking none.
 */
export function parseProperties(text: string): PackProperties {
  const entries: Record<string, string> = {};
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return {
    entries,
    programEnabled: prefixed(entries, /^program\.(.+)\.enabled$/),
    customUniforms: customUniforms(entries),
    images: prefixed(entries, /^image\.(.+)$/),
    flips: Object.fromEntries(
      Object.entries(prefixed(entries, /^flip\.(.+)$/)).map(([k, v]) => [k, v === 'true']),
    ),
  };
}

function prefixed(entries: Record<string, string>, re: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    const m = re.exec(k);
    if (m) out[m[1]] = v;
  }
  return out;
}

function customUniforms(
  entries: Record<string, string>,
): Record<string, { type: string; expr: string }> {
  const out: Record<string, { type: string; expr: string }> = {};
  for (const [k, v] of Object.entries(entries)) {
    const m = /^(?:uniform|variable)\.(\w+)\.(\w+)$/.exec(k);
    if (m) out[m[2]] = { type: m[1], expr: v };
  }
  return out;
}

/**
 * `block.properties`: `block.<id> = <state matchers…>`. The id is what the shader reads
 * from `mc_Entity.x`, and it is pack-defined — Sildur's uses 53 rules, Complementary 425 —
 * so this table is the coupling between a loaded pack and the chunk mesher's vertex data.
 */
export function parseBlockProperties(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^block\.(\d+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    for (const token of m[2].split(/\s+/)) {
      if (token) out[normaliseBlockToken(token)] = id;
    }
  }
  return out;
}

/** Matchers may be `stone`, `minecraft:stone` or `minecraft:stone:facing=north`. */
function normaliseBlockToken(token: string): string {
  const base = token.includes(':') ? token : `minecraft:${token}`;
  return base;
}

/* ------------------------------------------------------------------ failure taxonomy */

/**
 * The classes from SHADERPACKS.md §5. Only one of them is a real ceiling; keeping the
 * distinction in code stops "149 failures" being read as "149 things WebGPU cannot do".
 */
export type FailureClass = 'inherent' | 'mechanical' | 'tool-artifact' | 'unknown';

const PATTERNS: ReadonlyArray<readonly [RegExp, FailureClass]> = [
  [/geometry|\.gsh|EmitVertex/i, 'inherent'],
  [/imageAtomic|texture atomics/i, 'inherent'],
  [/OpTypeSampledImage|combined image sampler/i, 'mechanical'],
  [/redefinition|undeclared identifier|no matching overloaded/i, 'mechanical'],
  [/workgroup|shared memory|WorkgroupSize/i, 'mechanical'],
  [/Unknown decoration|unsupported storage class|StorageImageWriteWithoutFormat/i, 'tool-artifact'],
  [/naga:/i, 'tool-artifact'],
];

export function classifyFailure(message: string): FailureClass {
  for (const [re, cls] of PATTERNS) if (re.test(message)) return cls;
  return 'unknown';
}
