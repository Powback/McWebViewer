/**
 * Block registry: resolves a block-state key to renderable geometry, and answers the
 * occlusion questions the mesher needs.
 *
 * Everything here is derived from assets rather than hardcoded tables, with two
 * deliberate exceptions that cannot be derived because vanilla defines them in Java:
 *   - the render layer for vanilla blocks (`render_type` is a NeoForge-only JSON field;
 *     vanilla resolves it from `ItemBlockRenderTypes`), and
 *   - which blocks take a biome tint (`BlockColors` handlers).
 * Both tables are small, explicit and commented, rather than silently wrong.
 */

import {
  bakeModel,
  DIRECTIONS,
  ModelLoader,
  selectVariants,
  type BakedModel,
  type BakedQuad,
  type RawBlockstate,
  type RenderType,
  type Variant,
} from '../assets/model.js';
import { bakeWithLoader } from '../assets/loaders.js';
import { berModel, BER_BLOCKS } from './ber-models.js';
import { backdropModel } from './ber-overlays.js';
import { INTERIOR_DARK_SPRITE } from '../assets/builtin-pack.js';
import { bakeTurtleUpgrade, TURTLE_UPGRADE_STATE } from './turtle-upgrades.js';
import { blockstatePath, readJson, texturePath, type Pack } from '../assets/pack.js';
import { canonicalStateKey } from '../core/chunk.js';
import { classifyAlpha, type AlphaClass } from '../assets/png.js';

export interface RenderableState {
  key: string;
  name: string;
  props: Record<string, string>;
  quads: BakedQuad[];
  renderType: RenderType;
  /** occludes neighbouring faces entirely */
  opaqueFullCube: boolean;
  ambientOcclusion: boolean;
  /** 0 = grass-style, 1 = foliage-style, 2 = water, -1 = none */
  tintSource: TintSource;
  /** how this state got its geometry — drives the coverage audit */
  provenance: 'asset' | 'fluid' | 'extracted' | 'air' | 'block-entity' | 'none';
  /** 0-15 light emitted; used for emissive shading */
  lightEmission: number;
  /** geometry came from a custom model loader (NeoForge obj/composite, fusion, ...) */
  usedCustomLoader?: boolean;
}

export type TintSource = -1 | 0 | 1 | 2;

/** Blocks whose tintindex is fed by a biome colour handler (vanilla BlockColors). */
const GRASS_TINT = new Set([
  'minecraft:grass_block', 'minecraft:short_grass', 'minecraft:tall_grass',
  'minecraft:fern', 'minecraft:large_fern', 'minecraft:potted_fern',
  'minecraft:sugar_cane', 'minecraft:pink_petals',
]);
const FOLIAGE_TINT_SUFFIX = ['_leaves'];
const FOLIAGE_TINT = new Set(['minecraft:vine']);
const WATER_TINT = new Set([
  'minecraft:water', 'minecraft:bubble_column', 'minecraft:water_cauldron',
]);

function endsWithAny(s: string, suffixes: string[]): boolean {
  for (const suf of suffixes) if (s.endsWith(suf)) return true;
  return false;
}

function resolveProvenance(
  quadCount: number,
  sawElements: boolean,
): RenderableState['provenance'] {
  if (quadCount > 0) return 'asset';
  return sawElements ? 'none' : 'block-entity';
}

function tintSourceFor(name: string): TintSource {
  if (GRASS_TINT.has(name)) return 0;
  if (FOLIAGE_TINT.has(name) || endsWithAny(name, FOLIAGE_TINT_SUFFIX)) return 1;
  if (WATER_TINT.has(name)) return 2;
  return -1;
}

export const AIR_STATES = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air',
]);

/**
 * Render layer derived from the sprites a model actually uses.
 *
 * Vanilla decides this in Java (`ItemBlockRenderTypes`) and ships no data file for it,
 * so the usual approach is a hardcoded block-name table — which is wrong for every
 * modded block. But the distinction the layers encode *is* an alpha property, and the
 * PNGs answer it: no alpha -> solid, on/off alpha -> cutout, partial alpha -> translucent.
 * Derived this way it is correct for mods we have never heard of.
 */
function renderTypeFromAlpha(worst: AlphaClass): RenderType {
  if (worst === 'partial') return 'translucent';
  if (worst === 'binary') return 'cutout';
  return 'solid';
}

function worseAlpha(a: AlphaClass, b: AlphaClass): AlphaClass {
  if (a === 'partial' || b === 'partial') return 'partial';
  if (a === 'binary' || b === 'binary') return 'binary';
  return 'opaque';
}

export const FLUID_STATES = new Set([
  'minecraft:water', 'minecraft:flowing_water', 'minecraft:lava', 'minecraft:flowing_lava',
  // bubble_column's model is particle-only; vanilla draws it as moving water via the
  // fluid renderer, so it belongs on the fluid path rather than counting as unhandled.
  'minecraft:bubble_column',
]);

export class BlockRegistry {
  private cache = new Map<string, RenderableState>();
  private blockstateCache = new Map<string, RawBlockstate | null>();
  readonly models: ModelLoader;
  /** state keys with no geometry from any path — the number the audit must drive to 0 */
  readonly unresolved = new Set<string>();

  private alphaCache = new Map<string, AlphaClass>();

  /**
   * Block names the WORLD has block entities for — read from the region files by whoever
   * builds the registry (the bake's scan, or the browser's loaded chunks). It is what tells
   * a painted-surface block from a merely cutout one (ber-overlays.ts); the jars alone do
   * not say which blocks have a renderer.
   */
  private blockEntityBlocks: ReadonlySet<string>;

  constructor(private pack: Pack, opts: { blockEntityBlocks?: Iterable<string> } = {}) {
    this.models = new ModelLoader(pack);
    this.blockEntityBlocks = new Set(opts.blockEntityBlocks ?? []);
  }

  /** Alpha class of a sprite, read from the PNG itself and memoised. */
  alphaOf(spriteId: string): AlphaClass {
    const hit = this.alphaCache.get(spriteId);
    if (hit) return hit;
    const png = this.pack.get(texturePath(spriteId));
    // A missing texture must not be assumed opaque — that would let it occlude.
    const cls: AlphaClass = png ? classifyAlpha(png) : 'binary';
    this.alphaCache.set(spriteId, cls);
    return cls;
  }

  private blockstate(name: string): RawBlockstate | null {
    const cached = this.blockstateCache.get(name);
    if (cached !== undefined) return cached;
    let bs = readJson<RawBlockstate>(this.pack, blockstatePath(name)) ?? null;

    // Some mods re-register a vanilla block under their own namespace with the original
    // id kept as the path, and ship no assets at all — EasyAnvils registers
    // `easyanvils:minecraft/damaged_anvil` and relies on the vanilla model. When the
    // path itself looks like `<namespace>/<path>`, retry against that.
    if (!bs) {
      const slash = name.indexOf('/');
      const colon = name.indexOf(':');
      if (slash > colon) {
        const inner = name.slice(colon + 1);
        const cut = inner.indexOf('/');
        const rebased = `${inner.slice(0, cut)}:${inner.slice(cut + 1)}`;
        bs = readJson<RawBlockstate>(this.pack, blockstatePath(rebased)) ?? null;
      }
    }

    this.blockstateCache.set(name, bs);
    return bs;
  }

  /** All sprite ids reachable from a set of state keys — used to size the atlas. */
  spritesFor(stateKeys: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const key of stateKeys) {
      const r = this.resolve(key);
      for (const q of r.quads) out.add(q.texture);
    }
    return out;
  }

  resolve(stateKey: string): RenderableState {
    const hit = this.cache.get(stateKey);
    if (hit) return hit;

    const { name, props } = splitStateKey(stateKey);
    const state = this.build(stateKey, name, props);
    this.cache.set(stateKey, state);
    if (state.provenance === 'none') this.unresolved.add(stateKey);
    return state;
  }

  private build(key: string, name: string, props: Record<string, string>): RenderableState {
    const base = {
      key,
      name,
      props,
      tintSource: tintSourceFor(name),
      lightEmission: 0,
    };

    if (AIR_STATES.has(name)) {
      return {
        ...base, quads: [], renderType: 'solid', opaqueFullCube: false,
        ambientOcclusion: true, provenance: 'air',
      };
    }

    // Fluids carry no elements in their model JSON; they are generated geometry.
    if (FLUID_STATES.has(name)) {
      return {
        ...base, quads: [], renderType: 'translucent', opaqueFullCube: false,
        ambientOcclusion: false, provenance: 'fluid',
      };
    }

    // Not a block at all: the synthetic state a turtle's upgrade is drawn from. It has no
    // blockstate JSON; its geometry comes from the upgrade definition + the mod's models.
    if (name === TURTLE_UPGRADE_STATE) return this.buildTurtleUpgrade(base, props);

    const bs = this.blockstate(name);
    if (!bs) {
      return {
        ...base, quads: [], renderType: 'solid', opaqueFullCube: false,
        ambientOcclusion: true, provenance: 'none',
      };
    }

    const variants = selectVariants(bs, props);
    const b = this.bakeVariants(variants);
    const fromBer = this.addBlockEntityGeometry(name, props, b);
    this.addPaintedSurfaces(name, variants, b);

    return {
      ...base,
      quads: b.quads,
      renderType: this.renderTypeOf(b),
      opaqueFullCube: this.isOpaqueFullCube(b),
      ambientOcclusion: b.ao,
      provenance: fromBer ? 'extracted' : resolveProvenance(b.quads.length, b.sawElements),
      usedCustomLoader: b.usedCustomLoader,
    };
  }

  private buildTurtleUpgrade(
    base: Omit<RenderableState, 'quads' | 'renderType' | 'opaqueFullCube' | 'ambientOcclusion' | 'provenance'>,
    props: Record<string, string>,
  ): RenderableState {
    const baked = bakeTurtleUpgrade(this.pack, this.models, props);
    if (!baked) {
      return {
        ...base, quads: [], renderType: 'cutout', opaqueFullCube: false,
        ambientOcclusion: false, provenance: 'none',
      };
    }
    let worst: AlphaClass = 'opaque';
    for (const q of baked.quads) worst = worseAlpha(worst, this.alphaOf(q.texture));
    return {
      ...base,
      quads: baked.quads,
      renderType: renderTypeFromAlpha(worst),
      opaqueFullCube: false,
      // Upgrades hang off the body; vanilla's entity-style renderer does not AO them.
      ambientOcclusion: false,
      provenance: 'extracted',
    };
  }

  /**
   * Vanilla builds ~15 blocks in a BlockEntityRenderer rather than in model JSON, so
   * bakeVariants correctly finds no elements and no quads for them. ber-models.ts
   * re-expresses that Java geometry as data. Feeding it in here rather than short-
   * circuiting earlier means everything downstream — the alpha-derived render layer,
   * spritesFor()'s atlas collection — treats it exactly like any other model.
   *
   * Returns whether it contributed anything, which is what makes the state 'extracted'.
   */
  private addBlockEntityGeometry(
    name: string,
    props: Record<string, string>,
    b: VariantBake,
  ): boolean {
    if (b.quads.length > 0 || !BER_BLOCKS.has(name)) return false;
    const synthetic = berModel(name, props);
    if (!synthetic) return false;
    const baked = bakeModel(synthetic, { model: '' });
    if (baked.quads.length === 0) return false;

    b.quads.push(...baked.quads);
    // Entity models are not ambient-occluded, and a chest is emphatically not a
    // full cube even though its blockstate selected a (particle-only) variant.
    b.ao = baked.ambientOcclusion;
    b.fullCube = false;
    return true;
  }

  /**
   * The complement of addBlockEntityGeometry: a full-cube block the world has a block
   * entity for, with a see-through face — the renderer paints that face (a monitor's
   * screen). Each such face gets a dark backdrop 1/16 behind it, baked with the SAME variant
   * rotation as the block's model so it lands where the face does, and counts as opaque for
   * occlusion: the surface now is. See ber-overlays.ts for the rule and why it is structural.
   */
  private addPaintedSurfaces(name: string, variants: Variant[], b: VariantBake): void {
    if (!b.fullCube || b.cubeTextures.length !== DIRECTIONS.length) return;
    if (!this.blockEntityBlocks.has(name)) return;
    const covered = b.cubeTextures.map((t) => this.alphaOf(t) === 'binary');
    if (!covered.some(Boolean)) return;
    for (const v of variants) {
      for (let i = 0; i < DIRECTIONS.length; i++) {
        if (covered[i]) b.quads.push(...bakeModel(backdropModel(DIRECTIONS[i]), v).quads);
      }
    }
    b.cubeTextures = b.cubeTextures.map((t, i) => (covered[i] ? INTERIOR_DARK_SPRITE : t));
  }

  /**
   * A mod's explicit `render_type` is authoritative; otherwise derive it from the
   * sprites' alpha (see renderTypeFromAlpha).
   */
  private renderTypeOf(b: VariantBake): RenderType {
    let worst: AlphaClass = 'opaque';
    for (const q of b.quads) worst = worseAlpha(worst, this.alphaOf(q.texture));
    return b.declaredType ?? renderTypeFromAlpha(worst);
  }

  /**
   * Occlusion is a property of the full-cube element's own six textures, not of the
   * render layer. Grass blocks are a full cube plus a transparent overlay element and
   * DO occlude; glass is a full cube whose texture has alpha and does NOT. Keying off
   * the layer alone gets one of those two wrong whichever way you choose.
   */
  private isOpaqueFullCube(b: VariantBake): boolean {
    return b.fullCube && b.cubeTextures.length > 0 &&
      b.cubeTextures.every((t) => this.alphaOf(t) === 'opaque');
  }

  /** Bake every variant a blockstate selected and fold them into one accumulator. */
  private bakeVariants(variants: Variant[]): VariantBake {
    const acc: VariantBake = {
      quads: [],
      // A blockstate that resolves to models with no `elements` at all is the signature of
      // a block whose geometry lives in a BlockEntityRenderer (vanilla ships a
      // particle-only model for chests, beds, signs, banners, skulls, ...). Detecting it
      // structurally means modded block entities are classified correctly too, with no
      // block-name list to maintain.
      sawElements: false,
      ao: true,
      fullCube: variants.length > 0,
      declaredType: null,
      usedCustomLoader: false,
      cubeTextures: [],
    };

    for (const v of variants) {
      const resolved = this.models.resolve(v.model);
      if (!resolved) {
        acc.fullCube = false;
        continue;
      }
      const { baked, usedCustomLoader, loaderFailed } = this.bakeOne(resolved, v);
      if (usedCustomLoader) acc.usedCustomLoader = true;
      if (loaderFailed) acc.fullCube = false;
      foldBaked(acc, resolved.model, baked);
    }
    return acc;
  }

  /**
   * A custom loader means `elements` is not the real geometry (NeoForge obj/composite),
   * so hand it to the loader registry first. A loader that succeeds owns the geometry
   * outright, including whether it occludes; one we have no implementation for records
   * itself for the audit and falls back to the vanilla elements, which is better than a
   * hole but must not be trusted to claim full-cube occlusion.
   */
  private bakeOne(
    resolved: ResolvedModel,
    v: Variant,
  ): { baked: BakedModel; usedCustomLoader: boolean; loaderFailed: boolean } {
    let baked: BakedModel | null = null;
    let usedCustomLoader = false;
    let loaderFailed = false;
    if (resolved.model.loader) {
      baked = bakeWithLoader(resolved.model.loader, {
        pack: this.pack,
        models: this.models,
        chain: resolved.chain,
        resolved: resolved.model,
        variant: v,
      });
      if (baked) usedCustomLoader = true;
      else loaderFailed = true;
    }
    if (!baked) baked = bakeModel(resolved.model, v);
    return { baked, usedCustomLoader, loaderFailed };
  }
}

type ResolvedModel = NonNullable<ReturnType<ModelLoader['resolve']>>;

/** running result of baking a blockstate's variants */
interface VariantBake {
  quads: BakedQuad[];
  sawElements: boolean;
  ao: boolean;
  fullCube: boolean;
  declaredType: RenderType | null;
  usedCustomLoader: boolean;
  cubeTextures: string[];
}

function foldBaked(acc: VariantBake, model: ResolvedModel['model'], baked: BakedModel): void {
  if (model.elements?.length) acc.sawElements = true;
  acc.quads.push(...baked.quads);
  acc.ao = acc.ao && baked.ambientOcclusion;
  if (!baked.fullCube) acc.fullCube = false;
  else if (baked.fullCubeTextures) acc.cubeTextures = baked.fullCubeTextures;
  if (model.render_type) acc.declaredType = baked.renderType;
}

export function splitStateKey(key: string): { name: string; props: Record<string, string> } {
  const i = key.indexOf('[');
  if (i < 0) return { name: key, props: {} };
  const name = key.slice(0, i);
  const props: Record<string, string> = {};
  const body = key.slice(i + 1, key.lastIndexOf(']'));
  if (body) {
    for (const part of body.split(',')) {
      const j = part.indexOf('=');
      if (j > 0) props[part.slice(0, j)] = part.slice(j + 1);
    }
  }
  return { name, props };
}

export { canonicalStateKey };
