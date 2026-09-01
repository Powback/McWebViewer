/**
 * Program-level scan: the decisions that must be identical in both stages of a program.
 *
 * Varying locations and sampler bindings cannot be assigned per file. The two stages are
 * compiled separately into SPIR-V, so if the vertex shader numbers `texcoord` 3 and the
 * fragment shader numbers it 5, they link into a pipeline that silently reads the wrong
 * varying. glslang's `--auto-map-locations` assigns in declaration order, which is exactly
 * the thing that differs between two hand-written files. So both stages are scanned first
 * and every shared name is numbered here, by sorted name, once.
 */

export type Stage = 'vertex' | 'fragment' | 'compute' | 'geometry';

export const VARYING_RE = /^[ \t]*(?:flat[ \t]+|centroid[ \t]+|noperspective[ \t]+)*varying[ \t]+(\w+)[ \t]+(\w+)[ \t]*(\[[^\]]*\])?[ \t]*;/gm;
export const UNIFORM_RE = /^([ \t]*)uniform[ \t]+(\w+)[ \t]+(\w+)[ \t]*(\[[^\]]*\])?[ \t]*;/gm;
export const ATTRIBUTE_RE = /^([ \t]*)attribute[ \t]+(\w+)[ \t]+(\w+)[ \t]*;/gm;

/** How many varying locations one type consumes. mat3 is split into three vec3s. */
export function varyingSlots(type: string): number {
  if (type === 'mat3') return 3;
  if (type === 'mat4') return 4;
  if (type === 'mat2') return 2;
  return 1;
}

export interface VaryingDecl {
  readonly type: string;
  readonly name: string;
  readonly location: number;
}

export interface SamplerDecl {
  readonly type: string;
  readonly name: string;
  /** binding of the texture; the sampler sits at binding + 1 */
  readonly binding: number;
}

export interface ProgramPlan {
  readonly varyings: ReadonlyMap<string, VaryingDecl>;
  readonly samplers: ReadonlyMap<string, SamplerDecl>;
}

function collect(re: RegExp, sources: readonly string[], out: Map<string, string>): void {
  for (const src of sources) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      // Group order differs between the varying and uniform regexes; both put the type
      // immediately before the name, so read from the end of the fixed groups.
      const name = m[m.length - 2] ?? '';
      const type = m[m.length - 3] ?? '';
      if (name && type) out.set(name, type);
    }
  }
}

function collectVaryings(sources: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.matchAll(VARYING_RE)) out.set(m[2], m[1]);
  }
  return out;
}

function collectSamplers(sources: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.matchAll(UNIFORM_RE)) {
      if (m[2].startsWith('sampler') || m[2].startsWith('isampler') || m[2].startsWith('usampler')) {
        out.set(m[3], m[2]);
      }
    }
  }
  return out;
}

/**
 * Number every varying and sampler a program's stages mention. Sorted by name so the
 * numbering depends only on the set of names, never on which file declared them first.
 */
export function planProgram(sources: readonly string[]): ProgramPlan {
  const varyings = new Map<string, VaryingDecl>();
  let location = 0;
  for (const [name, type] of [...collectVaryings(sources)].sort(byName)) {
    varyings.set(name, { type, name, location });
    location += varyingSlots(type);
  }

  const samplers = new Map<string, SamplerDecl>();
  let binding = 0;
  for (const [name, type] of [...collectSamplers(sources)].sort(byName)) {
    samplers.set(name, { type, name, binding });
    binding += 2; // texture, then its sampler
  }
  return { varyings, samplers };
}

function byName(a: readonly [string, string], b: readonly [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

export { collect };
