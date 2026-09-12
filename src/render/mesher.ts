/**
 * Section mesher: 16^3 of blocks -> interleaved vertex buffers, one per render layer.
 *
 * Approach: per-block quad emission with cullface testing, not greedy meshing.
 * Greedy meshing only merges identical axis-aligned full faces, which describes
 * terrain but not the arbitrary geometry of block models (stairs, fences, Create
 * machinery) — so a greedy mesher still needs this path for everything interesting,
 * and the win over face culling alone is modest. Face culling is where the real
 * reduction is: it removes ~90% of quads in solid terrain. A greedy merge pass for
 * runs of identical full-cube faces is applied afterwards where it is safe.
 *
 * Lighting is baked into vertex colours, matching vanilla:
 *   - directional shade: down 0.5, up 1.0, north/south 0.8, east/west 0.6
 *   - smooth lighting from the chunk's stored block/sky light
 *   - ambient occlusion from the 3 neighbours touching each vertex
 */

import { DIR_VEC, DIRECTIONS, type BakedQuad, type Direction } from '../assets/model.js';
import { readTurtleUpgrades, upgradeStateKeys } from './turtle-upgrades.js';
import type { RenderableState } from './registry.js';
import type { TextureAtlas } from './atlas.js';

/**
 * The mesher depends on these three capabilities, not on the concrete classes.
 *
 * That is what lets a bundle baked on the server stand in for the in-browser
 * `BlockRegistry` and `BiomeColors` without the mesher knowing which it has — the
 * baked path and the jar path produce identical geometry because they run identical code
 * from here down. `BlockRegistry` and `BiomeColors` satisfy these structurally.
 */
export interface StateSource {
  resolve(stateKey: string): RenderableState;
  /**
   * Diagnostics, filled in AS STATES ARE RESOLVED — so they are only complete after
   * meshing, and anything that reports them must read them live rather than copy them
   * once at load. `unresolved` is every key that produced no geometry; `missing` is the
   * subset a served bake simply did not contain (the world gained the block after the
   * bake), which is the one a re-bake fixes.
   */
  readonly unresolved?: ReadonlySet<string>;
  readonly missing?: ReadonlySet<string>;
}

export interface TintLookup {
  tint(biomeId: string, source: 0 | 1 | 2): readonly [number, number, number];
}
import { cornerHeights, fluidOf, fluidQuads, holdsFluid, type FluidCell } from './fluids.js';
import { retextureQuads, textureMapOf } from './retexture.js';
import { AIR_ID, World, type StoredSection } from './world.js';
import { SECTION_VOLUME } from '../core/chunk.js';

type Vec3 = [number, number, number];

export type Layer = 'solid' | 'cutout' | 'translucent';

export interface LayerBuffers {
  positions: Float32Array;
  /** unit vectors as normalized int8: 3 bytes instead of 12, exact for axis-aligned faces */
  normals: Int8Array;
  /** atlas coordinates as normalized uint16: 4 bytes instead of 8 */
  uvs: Uint16Array;
  /** lighting x shade x AO x tint as normalized uint8: 4 bytes instead of 16 */
  colors: Uint8Array;
  indices: Uint32Array;
  /**
   * Per-vertex animation: `(frames, frametimeTicks, vStep)`.
   *
   * A vanilla animated texture is a vertical strip of frames in the atlas, and the mesher
   * already maps into frame 0's rect — so scrolling is just `uv.y += frame * vStep`, done in
   * the vertex shader against a clock uniform. Carrying it per vertex rather than per
   * material is what keeps ONE draw call per layer: a chunk mixes still stone with animated
   * lava and a Create belt, and splitting materials per sprite would multiply the draw calls
   * by the number of animated textures on screen.
   *
   * `frames === 1` (every still texture) makes the shader term exactly zero.
   */
  anim: Float32Array;
  /** present only in shaderpack mode; see ShaderAttribs */
  shader?: ShaderAttribs;
}

/**
 * The extra per-vertex data an Iris shaderpack requires and the vanilla path has no use
 * for. Emitted only when `MeshContext.blockIdOf` is set, because it costs 6 floats a
 * vertex and the ordinary renderer would carry it for nothing.
 *
 * `mc_midTexCoord` and `at_tangent` are deliberately NOT here — both are derivable from
 * the uvs and positions this already emits, so deriving them at buffer-build time keeps
 * the mesher's hot loop smaller.
 */
export interface ShaderAttribs {
  /** vaUV2: block light in .x, sky light in .y, each 0..240 as vanilla packs them */
  lightmap: Float32Array;
  /** mc_Entity.x: the id this block has in the loaded pack's block.properties, or -1 */
  entity: Float32Array;
  /** at_midBlock.xyz: offset from the vertex to the block centre, in 1/64 block units */
  midBlock: Float32Array;
}

export interface SectionMesh {
  cx: number;
  cy: number;
  cz: number;
  layers: Partial<Record<Layer, LayerBuffers>>;
  quadCount: number;
}

const DIR_INDEX: Record<Direction, number> = {
  down: 0, up: 1, north: 2, south: 3, west: 4, east: 5,
};

/** vanilla's fixed per-face brightness */
const SHADE: Record<Direction, number> = {
  down: 0.5, up: 1.0, north: 0.8, south: 0.8, west: 0.6, east: 0.6,
};

/** One quad's worth of input to LayerBuilder, grouped so the call stays under the
 * parameter limit and so shaderpack-only fields can be absent without a signature change. */
/**
 * A still `anim` buffer for geometry that never animates (entity models, block sets).
 *
 * `frames = 1` makes the shader's frame term exactly zero, so these share the same material
 * and the same single draw call as animated geometry rather than needing a second program.
 */
export function stillAnim(vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) out[i * 3] = 1;
  return out;
}

interface QuadInput {
  p: Float32Array;
  n: [number, number, number];
  uvs: Float32Array;
  rgba: Float32Array;
  /** `(frames, frametimeTicks, vStep)` — see LayerBuffers.anim */
  anim: readonly [number, number, number];
  flipDiagonal: boolean;
  /** Which way this face points out of the block — see quadOutward(). */
  outward: readonly [number, number, number];
  /** shaderpack mode only */
  shader?: {
    blockLight: number;
    skyLight: number;
    entityId: number;
    /** block centre in the same space as `p` */
    centre: [number, number, number];
  };
}

class LayerBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  lm: number[] = [];
  ent: number[] = [];
  mid: number[] = [];
  anim: number[] = [];
  vertices = 0;

  quad({ p, n, uvs, rgba, anim, flipDiagonal, outward, shader }: QuadInput) {
    const base = this.vertices;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.col.push(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);
      this.anim.push(anim[0], anim[1], anim[2]);
      if (shader) this.pushShader(shader, p, i);
    }
    // Winding is derived from the geometry rather than assumed from vanilla's corner
    // order. That order is NOT uniform across faces: it yields counter-clockwise-from-
    // outside for the side faces but clockwise for the horizontal ones, so a fixed index
    // order renders the sides and silently back-face-culls every block top under
    // THREE.FrontSide. Comparing the emitted triangle's own cross product against the
    // face's outward direction is self-correcting and cannot drift if a model rotation
    // reorders the corners.
    //
    // Vanilla flips the triangulation diagonal when AO is asymmetric, otherwise the
    // shading gradient bends visibly across the quad.
    const reversed = facesInward(p, outward);
    this.pushIndices(base, flipDiagonal, reversed);
    this.vertices += 4;
  }

  private pushIndices(base: number, flipDiagonal: boolean, reversed: boolean): void {
    const order = flipDiagonal ? [1, 2, 3, 3, 0, 1] : [0, 1, 2, 2, 3, 0];
    if (reversed) {
      // Reverse each triangle independently; reversing the whole list would also swap
      // which two triangles the diagonal splits the quad into.
      for (let t = 0; t < 6; t += 3) {
        this.idx.push(base + order[t + 2], base + order[t + 1], base + order[t]);
      }
      return;
    }
    for (const o of order) this.idx.push(base + o);
  }

  private pushShader(s: NonNullable<QuadInput['shader']>, p: Float32Array, i: number): void {
    // Vanilla packs the 0-15 light levels as 0-240 and lets gl_TextureMatrix[1] scale them
    // into the lightmap's 0..1 range; packs read the packed form, not the level.
    this.lm.push(s.blockLight * 16, s.skyLight * 16);
    this.ent.push(s.entityId);
    // 1/64 block units, the unit Iris documents for at_midBlock.
    this.mid.push(
      (s.centre[0] - p[i * 3]) * 64,
      (s.centre[1] - p[i * 3 + 1]) * 64,
      (s.centre[2] - p[i * 3 + 2]) * 64,
    );
  }

  build(): LayerBuffers | undefined {
    if (!this.idx.length) return undefined;
    return {
      positions: new Float32Array(this.pos),
      normals: toSnorm8(this.nor),
      uvs: toUnorm16(this.uv),
      colors: toUnorm8(this.col),
      indices: new Uint32Array(this.idx),
      anim: new Float32Array(this.anim),
      shader: this.lm.length
        ? {
          lightmap: new Float32Array(this.lm),
          entity: new Float32Array(this.ent),
          midBlock: new Float32Array(this.mid),
        }
        : undefined,
    };
  }
}

/**
 * NARROWER VERTEX ATTRIBUTES, because the memory ceiling is the thing that decides how much world
 * can be resident at once.
 *
 * A vertex cost 60 bytes: position 12, normal 12, uv 8, colour 16, anim 12. Three of those are
 * carrying far more precision than their contents can use, and the section budget pays for every
 * one of them -- at a 448 MB ceiling the format IS the view distance. Narrowing normal, uv and
 * colour takes a vertex to 35 bytes, so the same ceiling holds ~70% more world and rotating costs
 * proportionally less re-meshing.
 *
 * Each is exact enough for what it carries, which is why this is a free win rather than a trade:
 *
 *   normal   axis-aligned unit vectors. int8 normalized represents -1, 0 and +1 EXACTLY
 *            (127 maps to 1.0), and no block face has a normal that is not one of those.
 *   uv       atlas coordinates in 0..1. uint16 is 65536 steps across an atlas a couple of
 *            thousand pixels wide -- about thirty steps per texel.
 *   colour   light x shade x AO x biome tint, all in 0..1, displayed on an 8-bit-per-channel
 *            screen. uint8 is the precision the picture actually has.
 *
 * Position stays float32: it is section-local but still needs sub-texel accuracy for the model
 * geometry the registry bakes. `anim` stays float32 because `vStep` is a small fraction and the
 * frame counters beside it are not, so no single normalized encoding fits all three.
 */
export function toSnorm8(v: number[]): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, v[i]!)) * 127);
  return out;
}

export function toUnorm16(v: number[]): Uint16Array {
  const out = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, v[i]!)) * 65535);
  return out;
}

export function toUnorm8(v: number[]): Uint8Array {
  const out = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, v[i]!)) * 255);
  return out;
}

export interface MeshContext {
  world: World;
  registry: StateSource;
  atlas: TextureAtlas;
  biomes: TintLookup;
  /** cached state lookups indexed by global state id */
  states: (RenderableState | undefined)[];
  /**
   * Shaderpack mode. Set to the loaded pack's `block.properties` lookup to make the mesher
   * emit ShaderAttribs. `mc_Entity.x` is a PACK-defined id, which is what couples the
   * vertex data to whichever shaderpack is loaded — see SHADERPACKS.md §7.
   */
  blockIdOf?: (stateKey: string) => number;
  /**
   * Blocks to leave out of the mesh: section key (`cx,cy,cz`) -> block indices within
   * that section, in this file's iteration order. Live mode uses it to hide the
   * region-drawn block of a turtle whose real position arrives over the bridge, so the
   * turtle is drawn once — where it is — and not also where the last flush left it.
   */
  hidden?: ReadonlyMap<string, ReadonlySet<number>>;
  /** block id -> the sprite its model draws with; filled lazily by materialTexture */
  materials?: Map<string, string | null>;
}

export function makeContext(
  world: World,
  registry: StateSource,
  atlas: TextureAtlas,
  biomes: TintLookup,
): MeshContext {
  return { world, registry, atlas, biomes, states: [] };
}

/**
 * The fluid surface for this cell, or an empty list when there is no fluid here.
 *
 * Neighbour-aware, which is exactly why it lives in the mesher rather than the registry: a
 * `RenderableState` is context-free and shared by every cell with that state, but a fluid's
 * corners depend on the eight cells around it. Two ponds at different levels are the same
 * state and must not be the same geometry.
 */
/**
 * The synthetic states the fluid surface is drawn AS.
 *
 * A waterlogged fence is a cutout, untinted state; its water is neither. Emitting the fluid
 * under the host block's state would put the ocean in the cutout layer (opaque, no blending)
 * and hand it the fence's absent tint (white water). So the fluid gets its own state — which
 * for a pure water block is exactly the state it already had, making the two paths identical.
 */
const WATER_STATE = {
  key: 'minecraft:water', name: 'minecraft:water', props: { level: '0' },
  quads: [] as BakedQuad[], renderType: 'translucent' as const, opaqueFullCube: false,
  ambientOcclusion: false, tintSource: 2 as const, provenance: 'fluid' as const,
  lightEmission: 0,
};
const LAVA_STATE = {
  ...WATER_STATE, key: 'minecraft:lava', name: 'minecraft:lava',
  tintSource: -1 as const, lightEmission: 15,
};

/** Emit the fluid a cell holds, if any. Returns how many quads were written. */
function emitFluid(ctx: MeshContext, b: BlockCtx, getBuilder: (l: Layer) => LayerBuilder): number {
  if (!holdsFluid(b.state.name, b.state.props)) return 0;
  const quads = fluidQuadsFor(ctx, b);
  if (!quads.length) return 0;
  const kind = fluidOf(b.state.name, b.state.props)?.kind;
  const base = kind === 'lava' ? LAVA_STATE : WATER_STATE;
  const state: RenderableState = { ...base, quads };
  return emitBlock(
    ctx,
    { ...b, state, tint: tintOf(ctx, state, b.wx, b.wy, b.wz) },
    getBuilder,
  );
}

function fluidQuadsFor(ctx: MeshContext, b: BlockCtx): BakedQuad[] {
  const cell = fluidOf(b.state.name, b.state.props);
  if (!cell) return [];
  const fluidAt = (dx: number, dy: number, dz: number): FluidCell | null => {
    const id = ctx.world.getState(b.wx + dx, b.wy + dy, b.wz + dz);
    if (id === AIR_ID) return null;
    const st = stateOf(ctx, id);
    const f = fluidOf(st.name, st.props);
    return f && f.kind === cell.kind ? f : null;
  };
  const around: Array<number | null> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) around.push(fluidAt(dx, 0, dz)?.height ?? null);
  }
  const above = fluidAt(0, 1, 0) !== null;
  const corners = cornerHeights(cell, { above, around });

  // Culling. No face between two cells of the SAME fluid — an ocean must not be a lattice
  // of internal walls — and no face into an opaque neighbour.
  const opaque = (dx: number, dy: number, dz: number): boolean => {
    const id = ctx.world.getState(b.wx + dx, b.wy + dy, b.wz + dz);
    if (id === AIR_ID) return false;
    return stateOf(ctx, id).opaqueFullCube;
  };
  const hidden = (dx: number, dy: number, dz: number): boolean =>
    fluidAt(dx, dy, dz) !== null || opaque(dx, dy, dz);
  const faces = {
    // The top is drawn only when the cell above is not the same fluid: otherwise every
    // layer of a deep ocean draws a surface and they z-fight all the way down.
    up: !above && !opaque(0, 1, 0),
    down: !hidden(0, -1, 0),
    north: !hidden(0, 0, -1),
    south: !hidden(0, 0, 1),
    west: !hidden(-1, 0, 0),
    east: !hidden(1, 0, 0),
  };
  return fluidQuads(cell, corners, faces);
}

function stateOf(ctx: MeshContext, id: number): RenderableState {
  let s = ctx.states[id];
  if (!s) {
    s = ctx.registry.resolve(ctx.world.palette[id]);
    ctx.states[id] = s;
  }
  return s;
}

/**
 * Which way the quad faces out of its block.
 *
 * First choice: the quad's centre relative to the block centre. It is derived from the
 * rotated positions, so it cannot disagree with the geometry it is compared against —
 * `facing` can: a chest at `facing=west` reports `north` on a quad whose geometry points
 * west, because its yaw is an element rotation that `facing` does not follow.
 *
 * But the centre offset says nothing about a face that passes THROUGH the block centre,
 * or whose offset is perpendicular to it: the top of a bottom slab (centre y = 0.5), the
 * riser of a stair (offset straight up, face pointing sideways), the planes of a cross
 * model. Those used to be left to the fixed corner order, and the fixed order back-face
 * culls horizontal faces — so every slab top and stair step rendered as a hole. For them
 * the declared `facing` is the right answer: slabs and stairs carry no element rotation,
 * and the element rotations that DO exist (the 45-degree cross) cannot turn a face far
 * enough to flip the sign of its dot product with the unrotated direction.
 */
export function quadOutward(q: BakedQuad): [number, number, number] {
  const p = q.positions;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < 4; i++) {
    x += p[i * 3];
    y += p[i * 3 + 1];
    z += p[i * 3 + 2];
  }
  // Block space is 0..1, so the block centre is 0.5 on every axis.
  const ox = x / 4 - 0.5;
  const oy = y / 4 - 0.5;
  const oz = z / 4 - 0.5;
  // The offset only tells the two sides of this face apart if it has a component along
  // the face's own normal (from the triangle the mesher emits, either sign).
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  //
  // Both tests are ABSOLUTE. A cross plane's centre misses the block centre by float noise
  // (1e-8), and a relative test happily accepted that noise as a direction — which flipped
  // one face of every grass tuft at random, left the tuft visible from one side only and
  // z-fighting its own twin from the other. Block space is 0..1, so 1e-4 is far below any
  // real offset and far above any noise.
  const along = Math.abs(nx * ox + ny * oy + nz * oz);
  const len = Math.hypot(nx, ny, nz);
  if (Math.hypot(ox, oy, oz) > 1e-4 && len > 0 && along > 1e-4 * len) return [ox, oy, oz];
  return DIR_VEC[q.facing];
}

/**
 * True when triangle (0,1,2) of the quad winds clockwise as seen from outside — i.e. its
 * cross product opposes the face's outward direction, which is what makes FrontSide cull it.
 */
export function facesInward(
  p: Float32Array,
  outward: readonly [number, number, number],
): boolean {
  const ax = p[3] - p[0];
  const ay = p[4] - p[1];
  const az = p[5] - p[2];
  const bx = p[6] - p[0];
  const by = p[7] - p[1];
  const bz = p[8] - p[2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return cx * outward[0] + cy * outward[1] + cz * outward[2] < 0;
}

/** A block being meshed, with everything the per-quad loop needs precomputed. */
interface BlockCtx {
  state: RenderableState;
  /** world coords */
  wx: number;
  wy: number;
  wz: number;
  /** section-local coords, which are also the mesh-local origin */
  lx: number;
  ly: number;
  lz: number;
  tint: readonly [number, number, number];
}

function layerOf(state: RenderableState): Layer {
  if (state.renderType === 'translucent') return 'translucent';
  return state.renderType === 'solid' ? 'solid' : 'cutout';
}

const NO_TINT: readonly [number, number, number] = [1, 1, 1];

function tintOf(ctx: MeshContext, state: RenderableState, wx: number, wy: number, wz: number) {
  if (state.tintSource < 0) return NO_TINT;
  const biome = ctx.world.biomePalette[ctx.world.getBiome(wx, wy, wz)];
  return ctx.biomes.tint(biome, state.tintSource as 0 | 1 | 2);
}

/**
 * Whether a quad's face is hidden by its neighbour. Only quads that declare a
 * `cullface` are eligible — that is the model telling us the face is flush with the
 * block boundary.
 */
function isCulled(ctx: MeshContext, b: BlockCtx, q: BakedQuad): boolean {
  if (!q.cullface) return false;
  const d = DIR_VEC[q.cullface];
  const nid = ctx.world.getState(b.wx + d[0], b.wy + d[1], b.wz + d[2]);
  if (nid === AIR_ID) return false;
  const ns = stateOf(ctx, nid);
  if (ns.opaqueFullCube) return true;
  // Two adjacent translucent blocks of the same kind hide their shared face — vanilla
  // does this so an ocean is not a wall of z-fighting.
  return (
    b.state.renderType === 'translucent' &&
    ns.renderType === 'translucent' &&
    ns.name === b.state.name
  );
}

/**
 * The light sample a quad is lit by, as vanilla does — and the two cases are not the same.
 *
 * A quad WITH a cullface is flush with the block boundary, so it is lit by the cell it faces
 * into: the air in front of it, never the solid it belongs to. (A cube lit by its own cell
 * would be black, since the light inside an opaque block is 0.)
 *
 * A quad WITHOUT one lives inside its own block — the X of a grass cross, a torch, a fence
 * post, a flower — and offsetting its sample reads whatever is next door. Next door to a plant
 * is very often a wall, `getLight` inside a wall is 0, and `faceBrightness(0)` is 0.05, so the
 * plant was drawn at five percent brightness: "transparent blocks such as grass when they are
 * next to a solid block, they become very dark" (the user, 2026-09-11).
 *
 * Vanilla splits it on exactly this line, in `ModelBlockRenderer`: the quads it fetches per
 * direction are lit from `pos.relative(direction)`, and the general bucket — `getQuads(state,
 * null, ...)`, the ones with no cullface — is lit from `pos` itself.
 *
 * The offset follows the CULLFACE, not the facing. They coincide on a cube, and where a model
 * gives them different values the cullface is the one that says which boundary the quad is on.
 */
function quadLight(ctx: MeshContext, b: BlockCtx, q: BakedQuad): number {
  if (!q.cullface) return ctx.world.getLight(b.wx, b.wy, b.wz);
  const d = DIR_VEC[q.cullface];
  return ctx.world.getLight(b.wx + d[0], b.wy + d[1], b.wz + d[2]);
}

/** Vanilla's lightmap ramp is not linear; this approximates it. */
function faceBrightness(packed: number): number {
  const lum = Math.max(packed & 0xf, (packed >> 4) & 0xf) / 15;
  return 0.05 + 0.95 * Math.pow(lum, 1.4);
}

function writeVertexColors(
  out: Float32Array,
  ctx: MeshContext,
  b: BlockCtx,
  q: BakedQuad,
  opts: { useAo: boolean; packedLight: number },
): void {
  const { useAo } = opts;
  const shade = q.shade ? SHADE[q.facing] : 1.0;
  const brightness = faceBrightness(opts.packedLight);
  // The biome tint belongs to the QUAD, not to the block. A grass block is one model with
  // both: `grass_block_top` and the side overlay carry `tintindex: 0` and go green with the
  // biome, while the dirt sides carry none and must stay brown. Tinting the whole state —
  // which is what a `tintSource` on its own says to do — turns every dirt side, every
  // stone face under a tinted state and every untinted overlay green, and the world ends
  // up a uniform wash in which grass no longer reads as grass.
  const tint = q.tintIndex >= 0 ? b.tint : NO_TINT;
  for (let i = 0; i < 4; i++) {
    const ao = useAo ? vertexAo(ctx, b, q, i) : 1;
    const v = shade * brightness * ao;
    out[i * 4] = v * tint[0];
    out[i * 4 + 1] = v * tint[1];
    out[i * 4 + 2] = v * tint[2];
    out[i * 4 + 3] = 1;
  }
}

/** Emit one block's visible quads. Returns how many were written. */
function emitBlock(ctx: MeshContext, b: BlockCtx, getBuilder: (l: Layer) => LayerBuilder): number {
  const builder = getBuilder(layerOf(b.state));
  const rgba = new Float32Array(16);
  const worldPos = new Float32Array(12);
  const auv = new Float32Array(8);
  let written = 0;

  const entityId = ctx.blockIdOf ? ctx.blockIdOf(b.state.key) : 0;

  for (const q of b.state.quads) {
    if (isCulled(ctx, b, q)) continue;
    const sprite = ctx.atlas.get(q.texture);
    if (!sprite) continue;

    const useAo = b.state.ambientOcclusion && q.cullface !== null;
    const packedLight = quadLight(ctx, b, q);
    writeVertexColors(rgba, ctx, b, q, { useAo, packedLight });

    for (let i = 0; i < 4; i++) {
      worldPos[i * 3] = q.positions[i * 3] + b.lx;
      worldPos[i * 3 + 1] = q.positions[i * 3 + 1] + b.ly;
      worldPos[i * 3 + 2] = q.positions[i * 3 + 2] + b.lz;
    }

    // Map sprite-local uv into the atlas rect.
    const su = sprite.u1 - sprite.u0;
    const sv = sprite.v1 - sprite.v0;
    for (let i = 0; i < 4; i++) {
      auv[i * 2] = sprite.u0 + q.uvs[i * 2] * su;
      auv[i * 2 + 1] = sprite.v0 + q.uvs[i * 2 + 1] * sv;
    }

    const flip = useAo && rgba[0] + rgba[8] < rgba[4] + rgba[12];
    builder.quad({
      p: worldPos,
      n: q.normal,
      uvs: auv,
      rgba,
      // `sv` is exactly one frame's height in atlas UV, which is the per-frame step.
      anim: [sprite.frames, sprite.frametime, sv],
      flipDiagonal: flip,
      outward: quadOutward(q),
      shader: ctx.blockIdOf
        ? {
          blockLight: packedLight & 0xf,
          skyLight: (packedLight >> 4) & 0xf,
          entityId,
          centre: [b.lx + 0.5, b.ly + 0.5, b.lz + 0.5],
        }
        : undefined,
    });
    written++;
  }
  return written;
}

const NO_HIDDEN: ReadonlySet<number> = new Set();
const NO_RETEXTURE: ReadonlyMap<number, ReadonlyMap<string, string>> = new Map();

/**
 * Blocks in this section whose textures come from their block entity.
 *
 * Built once per section, like `hiddenIn`: almost every section has no such block, and a
 * per-block block-entity lookup would cost 4,096 map probes a section for nothing.
 */
function retexturedIn(
  ctx: MeshContext, cx: number, cy: number, cz: number,
): ReadonlyMap<number, ReadonlyMap<string, string>> {
  const col = ctx.world.getChunk(cx, cz);
  if (!col || col.blockEntities.size === 0) return NO_RETEXTURE;
  const baseY = cy << 4;
  let out: Map<number, ReadonlyMap<string, string>> | null = null;
  for (const be of col.blockEntities.values()) {
    const wy = be.y as number;
    if (typeof wy !== 'number' || wy < baseY || wy >= baseY + 16) continue;
    const map = textureMapOf(be as Record<string, unknown>);
    if (!map) continue;
    const i = (((wy - baseY) & 15) << 8) | (((be.z as number) & 15) << 4) | ((be.x as number) & 15);
    (out ??= new Map()).set(i, map);
  }
  return out ?? NO_RETEXTURE;
}

/**
 * The sprite a material block draws with: its own model's most-used texture.
 *
 * Resolved through the registry rather than guessed from the name, so a mod's material
 * works. Cached on the context because a wall of the same material asks the same question
 * for every block in it.
 */
function materialTexture(ctx: MeshContext, blockId: string): string | null {
  const hit = ctx.materials?.get(blockId);
  if (hit !== undefined) return hit;
  let best: string | null = null;
  try {
    const st = ctx.registry.resolve(blockId);
    const counts = new Map<string, number>();
    for (const q of st.quads) counts.set(q.texture, (counts.get(q.texture) ?? 0) + 1);
    let top = 0;
    for (const [tex, n] of counts) if (n > top) { top = n; best = tex; }
  } catch {
    best = null;
  }
  (ctx.materials ??= new Map()).set(blockId, best);
  return best;
}

/** The live view's hidden blocks for this section, or none. */
function hiddenIn(ctx: MeshContext, cx: number, cy: number, cz: number): ReadonlySet<number> {
  return ctx.hidden?.get(`${cx},${cy},${cz}`) ?? NO_HIDDEN;
}

/** The block at index `i` of a section, with a hidden block reading as air. */
function blockIdAt(section: StoredSection, hidden: ReadonlySet<number>, i: number): number {
  if (hidden.has(i)) return AIR_ID;
  return section.ids ? section.ids[i] : section.uniform;
}

export function meshSection(
  ctx: MeshContext,
  cx: number,
  cy: number,
  cz: number,
): SectionMesh | null {
  const section = ctx.world.getChunk(cx, cz)?.sections.get(cy);
  if (!section) return null;
  // A uniform section of air contributes nothing; a uniform section of stone still
  // needs its outer shell meshed, so only air is skipped.
  if (!section.ids && stateOf(ctx, section.uniform).provenance === 'air') return null;

  const builders: Partial<Record<Layer, LayerBuilder>> = {};
  const getBuilder = (l: Layer) => (builders[l] ??= new LayerBuilder());
  const baseX = cx << 4;
  const baseY = cy << 4;
  const baseZ = cz << 4;
  let quadCount = 0;
  // Looked up once per section, not once per block: almost every section has nothing hidden.
  const hiddenHere = hiddenIn(ctx, cx, cy, cz);
  const retexturedHere = retexturedIn(ctx, cx, cy, cz);

  for (let i = 0; i < SECTION_VOLUME; i++) {
    const id = blockIdAt(section, hiddenHere, i);
    if (id === AIR_ID) continue;
    const state = stateOf(ctx, id);
    // A fluid state has NO quads — its geometry is generated below — so the cheap
    // "nothing to draw" skip has to let it through or the ocean never reaches the mesher.
    if (!state.quads.length && !holdsFluid(state.name, state.props)) continue;

    const lx = i & 15;
    const lz = (i >> 4) & 15;
    const ly = i >> 8;
    const wx = baseX + lx;
    const wy = baseY + ly;
    const wz = baseZ + lz;
    quadCount += emitFluid(
      ctx,
      { state, wx, wy, wz, lx, ly, lz, tint: NO_TINT },
      getBuilder,
    );
    // A block entity carrying a texture map makes this block a different material from the
    // one its model names — see render/retexture.ts. The substitution happens here rather
    // than in the registry because a `RenderableState` is shared by every cell with that
    // state, and two Domum blocks of the same state are routinely different materials.
    const remap = retexturedHere.get(i);
    const drawn = remap
      ? { ...state, quads: retextureQuads(state.quads, remap, (b) => materialTexture(ctx, b)) as BakedQuad[] }
      : state;
    quadCount += emitBlock(
      ctx,
      { state: drawn, wx, wy, wz, lx, ly, lz, tint: tintOf(ctx, state, wx, wy, wz) },
      getBuilder,
    );
  }
  quadCount += emitUpgrades(ctx, { section, hidden: hiddenHere, cx, cy, cz }, getBuilder);

  const layers = buildLayers(builders);
  return layers ? { cx, cy, cz, layers, quadCount } : null;
}

interface SectionScope {
  section: StoredSection;
  hidden: ReturnType<typeof hiddenIn>;
  cx: number;
  cy: number;
  cz: number;
}

/**
 * What a turtle carries is in its block entity, not its state. Walk the column's block
 * entities that fall in this section; any with `LeftUpgrade`/`RightUpgrade` (the CC:T API's
 * fields — no block name is checked) gets each upgrade's synthetic state emitted at the
 * entity's own position, facing as the block there faces. A hidden block (a live turtle
 * drawn elsewhere) takes its upgrades with it.
 */
function emitUpgrades(ctx: MeshContext, scope: SectionScope, getBuilder: (l: Layer) => LayerBuilder): number {
  const col = ctx.world.getChunk(scope.cx, scope.cz);
  if (!col || col.blockEntities.size === 0) return 0;
  const baseY = scope.cy << 4;
  let n = 0;
  for (const be of col.blockEntities.values()) {
    const wy = be.y as number;
    if (typeof wy !== 'number' || wy < baseY || wy >= baseY + 16) continue;
    const ups = readTurtleUpgrades(be);
    if (ups) n += emitEntityUpgrades(ctx, scope, { wx: be.x as number, wy, wz: be.z as number, ups }, getBuilder);
  }
  return n;
}

function emitEntityUpgrades(
  ctx: MeshContext,
  scope: SectionScope,
  at: { wx: number; wy: number; wz: number; ups: NonNullable<ReturnType<typeof readTurtleUpgrades>> },
  getBuilder: (l: Layer) => LayerBuilder,
): number {
  const { wx, wy, wz, ups } = at;
  const lx = wx & 15, ly = wy & 15, lz = wz & 15;
  const id = blockIdAt(scope.section, scope.hidden, (ly << 8) | (lz << 4) | lx);
  if (id === AIR_ID) return 0;
  const host = stateOf(ctx, id);
  let n = 0;
  for (const key of upgradeStateKeys(host.props.facing ?? 'north', ups)) {
    const state = ctx.registry.resolve(key);
    if (state.quads.length) n += emitBlock(ctx, { state, wx, wy, wz, lx, ly, lz, tint: NO_TINT }, getBuilder);
  }
  return n;
}

function buildLayers(
  builders: Partial<Record<Layer, LayerBuilder>>,
): Partial<Record<Layer, LayerBuffers>> | null {
  const layers: Partial<Record<Layer, LayerBuffers>> = {};
  for (const k of ['solid', 'cutout', 'translucent'] as Layer[]) {
    const built = builders[k]?.build();
    if (built) layers[k] = built;
  }
  return Object.keys(layers).length ? layers : null;
}

/**
 * Vanilla-style ambient occlusion: darken a vertex by how many of the three blocks
 * touching that corner are opaque. `side1 && side2` fully occludes regardless of the
 * corner block, which is what produces the characteristic hard crease in corners.
 */
const AO_LEVELS = [0.4, 0.6, 0.8, 1.0];

/** The two tangent offsets for a face, pointing toward the corner this vertex sits on. */
function tangents(
  n: readonly [number, number, number],
  vx: number,
  vy: number,
  vz: number,
): [Vec3, Vec3] {
  const sx = Math.sign(vx) || 1;
  const sy = Math.sign(vy) || 1;
  const sz = Math.sign(vz) || 1;
  if (n[1] !== 0) return [[sx, 0, 0], [0, 0, sz]];
  if (n[0] !== 0) return [[0, sy, 0], [0, 0, sz]];
  return [[sx, 0, 0], [0, sy, 0]];
}

function vertexAo(ctx: MeshContext, b: BlockCtx, q: BakedQuad, vertex: number): number {
  const n = DIR_VEC[q.facing];
  // Vertex position relative to the block centre tells us which corner we are on.
  const [t1, t2] = tangents(
    n,
    q.positions[vertex * 3] - 0.5,
    q.positions[vertex * 3 + 1] - 0.5,
    q.positions[vertex * 3 + 2] - 0.5,
  );

  const bx = b.wx + n[0];
  const by = b.wy + n[1];
  const bz = b.wz + n[2];
  const side1 = isOpaque(ctx, bx + t1[0], by + t1[1], bz + t1[2]);
  const side2 = isOpaque(ctx, bx + t2[0], by + t2[1], bz + t2[2]);
  if (side1 && side2) return AO_LEVELS[0];
  const corner = isOpaque(ctx, bx + t1[0] + t2[0], by + t1[1] + t2[1], bz + t1[2] + t2[2]);
  return AO_LEVELS[3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0))];
}

function isOpaque(ctx: MeshContext, x: number, y: number, z: number): boolean {
  const id = ctx.world.getState(x, y, z);
  if (id === AIR_ID) return false;
  return stateOf(ctx, id).opaqueFullCube;
}

export { DIRECTIONS, DIR_INDEX };
