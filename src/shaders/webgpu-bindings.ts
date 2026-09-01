/**
 * Bind group layouts and bind groups, built from the WGSL the translator actually
 * produced.
 *
 * `layout: 'auto'` would be simpler and is not usable here. Chrome infers `sampleType:
 * 'float'` and `type: 'filtering'` for every sampled texture, and two of the Iris
 * bindings cannot be that:
 *
 *  - `depthtex0/1/2` are `r32float`, which is NOT filterable without the optional
 *    `float32-filterable` feature; they must be declared `unfilterable-float` with a
 *    `non-filtering` sampler.
 *  - `shadowtex0/1` are declared `sampler2DShadow` by the composite passes, which becomes
 *    `texture_depth_2d` + `sampler_comparison`, and `sampler2D` by the gbuffers passes,
 *    which becomes an ordinary sampled texture. The same Iris buffer therefore needs two
 *    different WebGPU bindings, chosen per program from the reflected WGSL type.
 *
 * Getting either wrong fails at pipeline creation with a message that names a binding
 * index and nothing else, which is why the decision is table-driven and commented here.
 */

import { classifySampler, type SamplerRole } from './iris-pipeline.js';
import type { ReflectedBinding } from './bundle.js';
import type { ShaderTargets } from './webgpu-targets.js';

export const UNIFORM_GROUP = 0;
export const TEXTURE_GROUP = 1;

/**
 * Evaluated lazily, NOT at module scope. `GPUShaderStage` does not exist in a browser
 * without WebGPU, and a top-level reference makes the whole bundle throw on load — which
 * takes the ordinary renderer down with it, the exact opposite of degrading.
 */
function visibility(): number {
  return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
}

/** Strip the `_T` / `_S` suffix the translator adds when splitting a combined sampler. */
function baseName(name: string): { base: string; kind: 'texture' | 'sampler' | null } {
  if (name.endsWith('_T')) return { base: name.slice(0, -2), kind: 'texture' };
  if (name.endsWith('_S')) return { base: name.slice(0, -2), kind: 'sampler' };
  return { base: name, kind: null };
}

function isDepthTexture(wgslType: string): boolean {
  return wgslType.includes('texture_depth');
}

function isComparisonSampler(wgslType: string): boolean {
  return wgslType.includes('sampler_comparison');
}

/** Roles whose backing texture is `r32float` and therefore unfilterable. */
const UNFILTERABLE: ReadonlySet<SamplerRole> = new Set<SamplerRole>(['depthtex']);

interface Resolved {
  readonly role: SamplerRole;
  readonly index: number;
}

function roleOf(base: string, roles: Readonly<Record<string, SamplerRole>>): Resolved {
  const classified = classifySampler(base, 'sampler2D');
  return { role: roles[base] ?? classified.role, index: classified.index };
}

export function buildLayout(
  device: GPUDevice,
  bindings: readonly ReflectedBinding[],
  roles: Readonly<Record<string, SamplerRole>>,
): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [];
  for (const b of bindings) {
    if (b.group !== TEXTURE_GROUP) continue;
    const { base, kind } = baseName(b.name);
    const { role } = roleOf(base, roles);
    if (kind === 'sampler') {
      entries.push({ binding: b.binding, visibility: visibility(), sampler: samplerType(b, role) });
    } else {
      entries.push({ binding: b.binding, visibility: visibility(), texture: textureType(b, role) });
    }
  }
  return device.createBindGroupLayout({ entries });
}

function samplerType(b: ReflectedBinding, role: SamplerRole): GPUSamplerBindingLayout {
  if (isComparisonSampler(b.wgslType)) return { type: 'comparison' };
  // The block atlas must be point-sampled or the world stops looking like Minecraft, but
  // that is a property of the sampler object, not of the layout; only filterability is.
  return { type: UNFILTERABLE.has(role) ? 'non-filtering' : 'filtering' };
}

function textureType(b: ReflectedBinding, role: SamplerRole): GPUTextureBindingLayout {
  if (isDepthTexture(b.wgslType)) return { sampleType: 'depth' };
  return { sampleType: UNFILTERABLE.has(role) ? 'unfilterable-float' : 'float' };
}

export interface SamplerSet {
  readonly filtering: GPUSampler;
  readonly nearest: GPUSampler;
  readonly nonFiltering: GPUSampler;
  readonly comparison: GPUSampler;
}

export function createSamplers(device: GPUDevice): SamplerSet {
  return {
    filtering: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }),
    nonFiltering: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }),
    comparison: device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }),
  };
}

export interface ResourceContext {
  readonly targets: ShaderTargets;
  readonly samplers: SamplerSet;
  /** 1x1 stand-ins so a missing optional map degrades instead of failing validation */
  readonly fallbackTexture: GPUTextureView;
  readonly flatNormalTexture: GPUTextureView;
}

/**
 * Which texture backs a role. `normals` and `specular` are the LabPBR maps a resource pack
 * supplies; this project has none, so they resolve to a flat-normal and a black texture
 * rather than being left unbound — an unbound entry is a validation failure, whereas a flat
 * normal is exactly what "this surface has no normal map" means.
 */
function indexedView(r: Resolved, b: ReflectedBinding, ctx: ResourceContext): GPUTextureView | null {
  const t = ctx.targets;
  if (r.role === 'colortex') return t.readView(r.index);
  if (r.role === 'depthtex') return t.depthCopyView(r.index);
  if (r.role === 'shadowtex') {
    return isDepthTexture(b.wgslType) ? t.shadowDepthView() : t.shadowCopyTexture().createView();
  }
  if (r.role === 'shadowcolor') return t.shadowColorView();
  return null;
}

function viewFor(r: Resolved, b: ReflectedBinding, ctx: ResourceContext): GPUTextureView {
  const indexed = indexedView(r, b, ctx);
  if (indexed) return indexed;
  const t = ctx.targets;
  if (r.role === 'noisetex') return t.noisetex.createView();
  if (r.role === 'lightmap') return t.lightmap.createView();
  if (r.role === 'atlas') return t.atlas?.createView() ?? ctx.fallbackTexture;
  if (r.role === 'normals') return ctx.flatNormalTexture;
  return ctx.fallbackTexture;
}

function samplerFor(r: Resolved, b: ReflectedBinding, ctx: ResourceContext): GPUSampler {
  if (isComparisonSampler(b.wgslType)) return ctx.samplers.comparison;
  if (UNFILTERABLE.has(r.role)) return ctx.samplers.nonFiltering;
  return r.role === 'atlas' ? ctx.samplers.nearest : ctx.samplers.filtering;
}

export function buildTextureBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  bindings: readonly ReflectedBinding[],
  roles: Readonly<Record<string, SamplerRole>>,
  ctx: ResourceContext,
): GPUBindGroup {
  const entries: GPUBindGroupEntry[] = [];
  for (const b of bindings) {
    if (b.group !== TEXTURE_GROUP) continue;
    const { base, kind } = baseName(b.name);
    const r = roleOf(base, roles);
    entries.push({
      binding: b.binding,
      resource: kind === 'sampler' ? samplerFor(r, b, ctx) : viewFor(r, b, ctx),
    });
  }
  return device.createBindGroup({ layout, entries });
}

export function uniformLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: visibility(), buffer: { type: 'uniform' } }],
  });
}

/** A 1x1 texture used wherever a pack asks for a map this renderer cannot supply. */
export function makeSolidTexture(
  device: GPUDevice,
  rgba: readonly [number, number, number, number],
): GPUTextureView {
  const tex = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: tex }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1],
  );
  return tex.createView();
}
