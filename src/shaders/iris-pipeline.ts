/**
 * The Iris pipeline contract: which programs exist, what falls back to what, what order
 * the passes run in, and which samplers a program may bind.
 *
 * This file is the authority the rest of the shader path defers to. It is data, not
 * behaviour, so the same table drives the offline translator, the coverage audit and the
 * WebGPU runtime and they cannot drift apart.
 *
 * Sources: shaders.properties (shaders.properties/), IrisShaders/ShaderDoc.
 */

export type StageKind =
  | 'setup' | 'begin' | 'shadow' | 'shadowcomp' | 'prepare'
  | 'gbuffers' | 'deferred' | 'composite' | 'final';

/**
 * Pipeline order. Compute is permitted in `setup` and in the five composite-style stages
 * and runs before their vertex stage; it is not permitted in gbuffers or shadow.
 */
export const STAGE_ORDER: readonly StageKind[] = [
  'setup', 'begin', 'shadow', 'shadowcomp', 'prepare',
  'gbuffers', 'deferred', 'composite', 'final',
];

/**
 * Program fallback graph, rooted at `gbuffers_basic`. A missing gbuffers program uses its
 * parent's; a missing composite-style program is simply skipped (no fallback).
 */
export const GBUFFERS_PARENT: Readonly<Record<string, string | null>> = {
  gbuffers_basic: null,
  gbuffers_line: 'gbuffers_basic',
  gbuffers_skybasic: 'gbuffers_basic',
  gbuffers_textured: 'gbuffers_basic',
  gbuffers_spidereyes: 'gbuffers_textured',
  gbuffers_armor_glint: 'gbuffers_textured',
  gbuffers_textured_lit: 'gbuffers_textured',
  gbuffers_skytextured: 'gbuffers_textured',
  gbuffers_clouds: 'gbuffers_textured',
  gbuffers_terrain: 'gbuffers_textured_lit',
  gbuffers_damagedblock: 'gbuffers_terrain',
  gbuffers_terrain_solid: 'gbuffers_terrain',
  gbuffers_terrain_cutout: 'gbuffers_terrain',
  gbuffers_terrain_cutout_mip: 'gbuffers_terrain',
  gbuffers_water: 'gbuffers_terrain',
  gbuffers_block_translucent: 'gbuffers_water',
  gbuffers_block: 'gbuffers_textured_lit',
  gbuffers_beaconbeam: 'gbuffers_textured_lit',
  gbuffers_item: 'gbuffers_textured_lit',
  gbuffers_entities: 'gbuffers_textured_lit',
  gbuffers_entities_translucent: 'gbuffers_entities',
  gbuffers_entities_glowing: 'gbuffers_entities',
  gbuffers_hand: 'gbuffers_textured_lit',
  gbuffers_hand_water: 'gbuffers_hand',
  gbuffers_weather: 'gbuffers_textured_lit',
  gbuffers_particles: 'gbuffers_textured_lit',
  gbuffers_particles_translucent: 'gbuffers_particles',
};

/** Resolve a program name against the packs's available programs, Iris-style. */
export function resolveProgram(want: string, available: ReadonlySet<string>): string | null {
  let name: string | null = want;
  while (name) {
    if (available.has(name)) return name;
    name = GBUFFERS_PARENT[name] ?? null;
  }
  return null;
}

export function stageOf(program: string): StageKind {
  if (program.startsWith('gbuffers_')) return 'gbuffers';
  if (program.startsWith('shadowcomp')) return 'shadowcomp';
  if (program.startsWith('shadow')) return 'shadow';
  if (program.startsWith('prepare')) return 'prepare';
  if (program.startsWith('deferred')) return 'deferred';
  if (program.startsWith('composite')) return 'composite';
  if (program === 'final') return 'final';
  if (program === 'begin' || program.startsWith('begin')) return 'begin';
  return 'setup';
}

/** Composite-style stages are full-screen and ping-pong their colour attachments. */
export function isFullscreenStage(stage: StageKind): boolean {
  return stage === 'deferred' || stage === 'composite' || stage === 'final'
    || stage === 'prepare' || stage === 'shadowcomp' || stage === 'begin';
}

/**
 * `gcolor`/`gdepth`/... are the pre-1.13 names for colortex0..7 and must resolve to the
 * same attachment, or a pack that mixes both spellings gets two buffers where it wants one.
 */
export const LEGACY_COLORTEX: Readonly<Record<string, number>> = {
  gcolor: 0, gdepth: 1, gnormal: 2, composite: 3,
  gaux1: 4, gaux2: 5, gaux3: 6, gaux4: 7,
};

export const MAX_COLOR_BUFFERS = 16;

export type SamplerRole =
  | 'atlas' | 'lightmap' | 'normals' | 'specular'
  | 'colortex' | 'depthtex' | 'shadowtex' | 'shadowcolor' | 'noisetex'
  | 'unknown';

export interface SamplerBinding {
  /** name as the shader declares it */
  readonly name: string;
  readonly role: SamplerRole;
  /** colortex index / depthtex index / shadowtex index, else -1 */
  readonly index: number;
  /** declared as sampler2DShadow — needs a comparison sampler */
  readonly shadow: boolean;
}

/** Samplers whose name alone fixes their role. */
const EXACT_ROLES: Readonly<Record<string, SamplerRole>> = {
  texture: 'atlas', gtexture: 'atlas', tex: 'atlas',
  lightmap: 'lightmap', normals: 'normals', specular: 'specular', noisetex: 'noisetex',
};

/** Samplers whose role is a prefix plus an index; longest prefix must win. */
const INDEXED_ROLES: ReadonlyArray<readonly [string, SamplerRole]> = [
  ['shadowcolor', 'shadowcolor'],
  ['shadowtex', 'shadowtex'],
  ['colortex', 'colortex'],
  ['depthtex', 'depthtex'],
];

function indexedRole(name: string): { role: SamplerRole; index: number } | null {
  for (const [prefix, role] of INDEXED_ROLES) {
    if (!name.startsWith(prefix)) continue;
    const n = Number(name.slice(prefix.length));
    if (Number.isInteger(n)) return { role, index: n };
  }
  return null;
}

/** Classify one declared sampler against the Iris sampler set. */
export function classifySampler(name: string, glslType: string): SamplerBinding {
  const shadow = glslType.endsWith('Shadow');
  const legacy = LEGACY_COLORTEX[name];
  if (legacy !== undefined) return { name, role: 'colortex', index: legacy, shadow: false };
  const exact = EXACT_ROLES[name];
  if (exact) return { name, role: exact, index: -1, shadow: false };
  const indexed = indexedRole(name);
  if (indexed) return { name, ...indexed, shadow };
  return { name, role: 'unknown', index: -1, shadow };
}

/**
 * Buffer formats a pack may declare. WebGPU cannot render to every one of them; the
 * substitution is recorded rather than silently applied so the audit can report it.
 */
export interface FormatMapping {
  readonly webgpu: GPUTextureFormat;
  /** null when the format maps exactly */
  readonly substitutedFor: string | null;
  readonly note: string | null;
}

const EXACT: Record<string, GPUTextureFormat> = {
  RGBA8: 'rgba8unorm',
  RGBA16F: 'rgba16float',
  RGBA32F: 'rgba32float',
  R11F_G11F_B10F: 'rg11b10ufloat',
  R8: 'r8unorm', R16F: 'r16float', R32F: 'r32float',
  RG8: 'rg8unorm', RG16F: 'rg16float', RG32F: 'rg32float',
  RGBA8_SNORM: 'rgba8snorm',
  R32UI: 'r32uint', R32I: 'r32sint',
  RGBA16I: 'rgba16sint', RGBA16UI: 'rgba16uint',
  RGBA32UI: 'rgba32uint', RGBA32I: 'rgba32sint',
};

const SUBSTITUTED: Record<string, [GPUTextureFormat, string]> = {
  // 3-component formats are not renderable in WebGPU; promoting to 4 components costs
  // bytes per sample but nothing else.
  RGB8: ['rgba8unorm', 'promoted to 4 components (RGB is not renderable in WebGPU)'],
  RGB16F: ['rgba16float', 'promoted to 4 components (RGB is not renderable in WebGPU)'],
  RGB32F: ['rgba32float', 'promoted to 4 components (RGB is not renderable in WebGPU)'],
  RGB16: ['rgba16float', 'RGB16 unorm does not exist in WebGPU; substituted rgba16float'],
  // rgba16unorm is not in core WebGPU at all. rgba16float has the same footprint and more
  // range but less precision in 0..1, which changes packed normal/material encodings.
  RGBA16: ['rgba16float', 'rgba16unorm is not in core WebGPU; precision differs in 0..1'],
  RGB8_SNORM: ['rgba8snorm', 'promoted to 4 components; snorm is not colour-renderable'],
  RGB10_A2: ['rgb10a2unorm', 'exact footprint, different component packing'],
};

export function mapFormat(declared: string): FormatMapping | null {
  const key = declared.toUpperCase();
  const exact = EXACT[key];
  if (exact) return { webgpu: exact, substitutedFor: null, note: null };
  const sub = SUBSTITUTED[key];
  if (sub) return { webgpu: sub[0], substitutedFor: key, note: sub[1] };
  return null;
}

/** Bytes per sample a colour attachment costs against `maxColorAttachmentBytesPerSample`. */
export function formatBytes(format: GPUTextureFormat): number {
  if (format.startsWith('rgba32') || format === 'rg32float') return 16;
  if (format.startsWith('rgba16') || format.startsWith('rg32')) return 8;
  return 4;
}
