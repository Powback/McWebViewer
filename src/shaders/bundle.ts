/**
 * The shape of a translated shaderpack bundle, shared by the offline translator that
 * writes it and the runtime that executes it.
 *
 * Kept as a separate module so the two cannot drift: the runtime builds bind groups from
 * `bindings`, and those come from reflecting the *produced* WGSL rather than from what the
 * translator intended to emit. glslang eliminates unused uniforms, so intent and reality
 * differ routinely, and a bind group built from intent fails validation at pipeline
 * creation with a message that points nowhere useful.
 */

import type { SamplerRole } from './iris-pipeline.js';

export interface ReflectedBinding {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly wgslType: string;
}

export interface BundleStage {
  readonly wgsl: string;
  readonly bindings: readonly ReflectedBinding[];
}

export interface BundleProgram {
  readonly name: string;
  readonly stage: string;
  readonly ok: boolean;
  /** colortex index per fragment output location */
  readonly drawBuffers: readonly number[];
  readonly stages: Partial<Record<'vertex' | 'fragment' | 'compute', BundleStage>>;
  readonly attributes: readonly string[];
  readonly uniforms: readonly string[];
  readonly unknownUniforms: readonly string[];
  readonly samplerRoles: Readonly<Record<string, SamplerRole>>;
  readonly notes: readonly string[];
  readonly errors: Readonly<Record<string, string>>;
  readonly failureClass?: string;
}

export interface ColorTexInfo {
  readonly index: number;
  readonly declared: string;
  readonly webgpu: string;
  readonly substitutedFor: string | null;
  readonly note: string | null;
}

export interface ShaderBundle {
  readonly id: string;
  readonly dimension: string;
  readonly colortex: readonly ColorTexInfo[];
  readonly consts: {
    readonly sunPathRotation: number | null;
    readonly shadowMapResolution: number | null;
    readonly shadowDistance: number | null;
    readonly shadowFiltering: Readonly<Record<number, boolean>>;
  };
  readonly properties: {
    readonly entries: Readonly<Record<string, string>>;
    readonly programEnabled: Readonly<Record<string, string>>;
  };
  readonly blockIds: Readonly<Record<string, number>>;
  readonly settings: Readonly<Record<string, string>>;
  readonly programs: Readonly<Record<string, BundleProgram>>;
}

/** Programs that translated and therefore could be run. */
export function availablePrograms(bundle: ShaderBundle): Set<string> {
  return new Set(Object.values(bundle.programs).filter((p) => p.ok).map((p) => p.name));
}

/**
 * `block.properties` gives ids per block name; the mesher asks per block STATE. Matching on
 * the name prefix is what makes `minecraft:short_grass[...]` resolve to the pack's id for
 * `minecraft:short_grass`. -1 is Iris' documented "not listed" value.
 */
export function blockIdLookup(bundle: ShaderBundle): (stateKey: string) => number {
  const table = bundle.blockIds;
  const cache = new Map<string, number>();
  return (stateKey: string) => {
    const hit = cache.get(stateKey);
    if (hit !== undefined) return hit;
    const name = stateKey.split('[')[0];
    const id = table[stateKey] ?? table[name] ?? -1;
    cache.set(stateKey, id);
    return id;
  };
}
