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
import { AIR_ID, World } from './world.js';
import { SECTION_VOLUME } from '../core/chunk.js';

type Vec3 = [number, number, number];

export type Layer = 'solid' | 'cutout' | 'translucent';

export interface LayerBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
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
interface QuadInput {
  p: Float32Array;
  n: [number, number, number];
  uvs: Float32Array;
  rgba: Float32Array;
  flipDiagonal: boolean;
  /**
   * Which way this face points out of the block, derived from the quad's own geometry.
   * Null when the quad passes through the block centre (cross models), where "outward"
   * is meaningless and the original corner order must be kept.
   */
  outward: readonly [number, number, number] | null;
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
  vertices = 0;

  quad({ p, n, uvs, rgba, flipDiagonal, outward, shader }: QuadInput) {
    const base = this.vertices;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.col.push(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);
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
    const reversed = outward !== null && facesInward(p, outward);
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
      normals: new Float32Array(this.nor),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
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
}

export function makeContext(
  world: World,
  registry: StateSource,
  atlas: TextureAtlas,
  biomes: TintLookup,
): MeshContext {
  return { world, registry, atlas, biomes, states: [] };
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
 * Which way the quad faces out of its block: its centre relative to the block centre.
 *
 * NOT `DIR_VEC[q.facing]`. The `facing` enum goes stale under variant rotation — a chest
 * at `facing=west` reports `north` on a quad whose geometry points west — which makes the
 * dot product against it exactly zero, and float noise then reverses an arbitrary subset
 * of that block's quads. Deriving the direction from the rotated positions cannot
 * disagree with the geometry it is being compared to.
 *
 * Returns null for a quad centred on the block centre (the two planes of a cross model),
 * where there is no outside and the corner order must be left alone.
 */
function quadOutward(p: Float32Array): [number, number, number] | null {
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
  return Math.hypot(ox, oy, oz) < 1e-4 ? null : [ox, oy, oz];
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

/** The light sample a face is lit by: the neighbour it faces, as vanilla does. */
function quadLight(ctx: MeshContext, b: BlockCtx, q: BakedQuad): number {
  const d = DIR_VEC[q.facing];
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
      flipDiagonal: flip,
      outward: quadOutward(q.positions),
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

  for (let i = 0; i < SECTION_VOLUME; i++) {
    const id = section.ids ? section.ids[i] : section.uniform;
    if (id === AIR_ID) continue;
    const state = stateOf(ctx, id);
    if (!state.quads.length) continue;

    const lx = i & 15;
    const lz = (i >> 4) & 15;
    const ly = i >> 8;
    const wx = baseX + lx;
    const wy = baseY + ly;
    const wz = baseZ + lz;
    quadCount += emitBlock(
      ctx,
      { state, wx, wy, wz, lx, ly, lz, tint: tintOf(ctx, state, wx, wy, wz) },
      getBuilder,
    );
  }

  const layers = buildLayers(builders);
  return layers ? { cx, cy, cz, layers, quadCount } : null;
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
