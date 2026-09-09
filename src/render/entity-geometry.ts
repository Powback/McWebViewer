/**
 * Entity geometry from the offline Java-model extraction.
 *
 * Mobs have no model JSON anywhere in the jars: their shape is built in Java by a
 * `LayerDefinition` (a tree of `PartDefinition`s, each holding `CubeListBuilder` cubes).
 * `harness/out/entity-models.json` is that tree captured as data — the same numbers the
 * game's own `createBodyLayer()` returns — so this module needs no Java at all, only the
 * two conversions vanilla applies between a `ModelPart` and the screen.
 *
 * 1. THE CUBE UNWRAP is identical to the one `ber-models.ts` already implements for
 *    block-entity renderers (`texOffs(u,v).addBox(...)` laying six faces out on a fixed
 *    u/v lattice), so `box()` is reused verbatim rather than reimplemented. That unwrap is
 *    verified against real textures over there; sharing it means entity and block-entity
 *    geometry cannot drift apart.
 *
 * 2. THE COORDINATE SPACE. Vanilla entity models are authored Y-DOWN with the origin at
 *    the entity's feet, in 1/16-block units. `LivingEntityRenderer.render` turns that into
 *    world space with, in PoseStack order,
 *        mulPose(YP.rotationDegrees(180 - yBodyRot));
 *        scale(-1, -1, 1);
 *        translate(0, -1.501, 0);
 *    and `ModelPart.Cube` divides its vertices by 16. Applied to a point that is
 *        (x, y, z) units  ->  (-x/16, 1.5 - y/16, z/16)  ->  yaw by (180 - Rotation[0]).
 *    ROOT below is exactly that translate-then-scale pair; the yaw is left to the caller
 *    because the viewer applies it as a mesh transform. Note the x negation: the "obvious"
 *    (x/16, (24-y)/16, z/16) differs from it by a 180 degree yaw, which would leave every
 *    mob facing backwards. `-1.501` is vanilla's z-fight nudge; 1.5 is used here so a
 *    model whose feet sit at y=24 units lands exactly on y=0.
 */

import { box, type BoxSpec } from './ber-models.js';
import { bakeModel, type BakedQuad, type Direction, type RawElement } from '../assets/model.js';
import type { TextureAtlas } from './atlas.js';
import type { Layer, LayerBuffers } from './mesher.js';
import type { EntityGeometrySource } from './entities.js';

// ---------------------------------------------------------------------------
// The extracted data, exactly as `harness/out/*.json` writes it.

export interface EntityCube {
  from: [number, number, number];
  to: [number, number, number];
  /** addBox w,h,d — drives the UV lattice, and is NOT changed by grow */
  size: [number, number, number];
  /** CubeListBuilder.texOffs */
  uv: [number, number];
  /** scalar summary of growXYZ; growXYZ is the authoritative per-axis value */
  grow: number;
  growXYZ: [number, number, number];
  mirror: boolean;
}

export interface EntityPart {
  /** PartPose offset, in model units */
  pos: [number, number, number];
  /** PartPose rotation, in RADIANS */
  rot: [number, number, number];
  cubes: EntityCube[];
  children?: Record<string, EntityPart>;
}

export interface EntityModel {
  texWidth: number;
  texHeight: number;
  parts: Record<string, EntityPart>;
}

export interface EntityIndexEntry {
  renderer: string;
  /** key into the model file, or null when the extractor could not resolve one */
  model: string | null;
  /** `assets/<ns>/textures/<path>.png` */
  texture: string | null;
  allModels?: string[];
  allTextures?: string[];
}

export type EntityModels = Record<string, EntityModel>;
export type EntityIndex = Record<string, EntityIndexEntry>;

// ---------------------------------------------------------------------------
// Affine helper. Row-major 3x4, matching ber-models' convention.

type Mat = readonly number[];

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** See the header note: translate(0,-1.5,0) followed by scale(-1,-1,1). */
const ROOT: Mat = [-1, 0, 0, 0, 0, -1, 0, 1.5, 0, 0, 1, 0];

/** Vanilla renders the body yawed by `180 - yBodyRot`, so `Rotation[0]` needs the same. */
export function entityYawDeg(rotationYaw: number): number {
  return 180 - rotationYaw;
}

function matMul(a: Mat, b: Mat): Mat {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    }
    out[r * 4 + 3] =
      a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

/**
 * `ModelPart.translateAndRotate`: translate by the PartPose offset, then mulPose zRot,
 * yRot, xRot in that order — which, because PoseStack post-multiplies, means a point is
 * rotated about X first and translated last.
 */
function partMatrix(parent: Mat, part: EntityPart): Mat {
  const [px, py, pz] = part.pos;
  let m = matMul(parent, [1, 0, 0, px / 16, 0, 1, 0, py / 16, 0, 0, 1, pz / 16]);
  const [rx, ry, rz] = part.rot;
  if (rz) m = matMul(m, rotZ(rz));
  if (ry) m = matMul(m, rotY(ry));
  if (rx) m = matMul(m, rotX(rx));
  return m;
}

function rotX(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}
function rotY(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}
function rotZ(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

// ---------------------------------------------------------------------------
// The model set

/** `assets/minecraft/textures/entity/chicken.png` -> `minecraft:entity/chicken` */
export function spriteIdForTexture(path: string): string | null {
  const m = /^assets\/([^/]+)\/textures\/(.+)\.png$/.exec(path);
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * The extracted models plus the entity-type -> model/texture index.
 *
 * `hasGeometry` is what the audit and the renderer both key off, so it must mean "this
 * type really does reach the screen": a model with parts AND a texture the caller can
 * actually supply. The texture check is injected because the model set is loaded before
 * the atlas (or the pack stack) exists.
 */
export class EntityModelSet implements EntityGeometrySource {
  private textureAvailable: (spriteId: string) => boolean = () => true;

  constructor(
    readonly models: EntityModels,
    readonly index: EntityIndex,
  ) {}

  geometryFor(entityType: string): { model: EntityModel; sprite: string } | null {
    const entry = this.index[entityType];
    if (!entry || !entry.model || !entry.texture) return null;
    const model = this.models[entry.model];
    if (!model || Object.keys(model.parts).length === 0) return null;
    const sprite = spriteIdForTexture(entry.texture);
    if (!sprite || !this.textureAvailable(sprite)) return null;
    return { model, sprite };
  }

  hasGeometry(entityType: string): boolean {
    return this.geometryFor(entityType) !== null;
  }

  /**
   * Every entity sprite these types could need. Deliberately ignores `textureAvailable`:
   * this is what the atlas is BUILT from, so filtering by what the atlas already has
   * would be circular.
   */
  spriteIds(entityTypes: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const t of entityTypes) {
      const tex = this.index[t]?.texture;
      const sprite = tex ? spriteIdForTexture(tex) : null;
      if (sprite) out.add(sprite);
    }
    return out;
  }

  /** Install the "can this sprite be drawn?" test once the atlas/pack stack is known. */
  useTextureFilter(fn: (spriteId: string) => boolean): void {
    this.textureAvailable = fn;
  }
}

export function makeEntityModelSet(models: EntityModels, index: EntityIndex): EntityModelSet {
  return new EntityModelSet(models, index);
}

/**
 * Fetch both halves of the extraction. `base` is a URL prefix; the files are served from
 * `public/` in dev and from the built bundle in production.
 */
export async function loadEntityModels(base = ''): Promise<EntityModelSet> {
  const [models, index] = await Promise.all([
    fetchJson<EntityModels>(`${base}/entity-models.json`),
    fetchJson<EntityIndex>(`${base}/entity-index.json`),
  ]);
  return new EntityModelSet(models, index);
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// Building quads

interface EmitContext {
  texSize: [number, number];
  texture: string;
}

/**
 * All of one entity type's quads, in entity-local block space (feet at y=0, +Z forward
 * before the caller's yaw). Null when the type has no extracted geometry, or when its
 * texture is not in the atlas — in that case drawing it would produce invisible quads,
 * and reporting it as drawn would be a lie.
 */
export function buildEntityQuads(
  modelSet: EntityModelSet,
  entityType: string,
  atlas: TextureAtlas,
): BakedQuad[] | null {
  const geom = modelSet.geometryFor(entityType);
  if (!geom || !atlas.get(geom.sprite)) return null;
  const ctx: EmitContext = {
    texSize: [geom.model.texWidth, geom.model.texHeight],
    texture: geom.sprite,
  };
  const quads: BakedQuad[] = [];
  emitParts(geom.model.parts, ROOT, ctx, quads);
  return quads.length ? quads : null;
}

function emitParts(
  parts: Record<string, EntityPart>,
  parent: Mat,
  ctx: EmitContext,
  out: BakedQuad[],
): void {
  for (const part of Object.values(parts)) {
    const mat = partMatrix(parent, part);
    emitCubes(part, mat, ctx, out);
    if (part.children) emitParts(part.children, mat, ctx, out);
  }
}

function emitCubes(part: EntityPart, mat: Mat, ctx: EmitContext, out: BakedQuad[]): void {
  if (!part.cubes.length) return;
  // Each cube bakes as its own throwaway model so its centre is known: the winding of every
  // face is fixed against it BEFORE the part transform, which is a proper rotation and so
  // preserves it. bakeModel divides from/to by 16, landing the cube in block units for `mat`.
  for (const c of part.cubes) {
    const el = cubeElement(c, ctx);
    const centre: [number, number, number] = [
      (el.from[0] + el.to[0]) / 32, (el.from[1] + el.to[1]) / 32, (el.from[2] + el.to[2]) / 32,
    ];
    for (const q of bakeModel({ elements: [el] }, { model: '' }).quads) {
      out.push(transformQuad(orientOutward(q, centre), mat));
    }
  }
}

/**
 * Make triangle (0,1,2) of the quad wind counter-clockwise as seen from outside its cube,
 * and its normal point that way too.
 *
 * Vanilla's corner order is not uniform across faces (see mesher.ts), and the mesh builder
 * below uses a fixed index order — so without this, whichever faces happened to be wound
 * the other way were back-face culled: the wolf had no back, the cow's head no top. The
 * outward direction is the face centre relative to the CUBE centre, which cannot disagree
 * with the geometry it is compared against, however the box was mirrored or inflated.
 */
export function orientOutward(q: BakedQuad, cubeCentre: readonly [number, number, number]): BakedQuad {
  const p = q.positions;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < 4; i++) { cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]; }
  const outward: [number, number, number] = [cx / 4 - cubeCentre[0], cy / 4 - cubeCentre[1], cz / 4 - cubeCentre[2]];
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  let positions = p;
  let uvs = q.uvs;
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
    // Reverse the corner order (0,3,2,1): same quad, opposite winding, uvs travel with corners.
    positions = new Float32Array(12);
    uvs = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      const j = (4 - i) & 3;
      positions.set(p.subarray(j * 3, j * 3 + 3), i * 3);
      uvs.set(q.uvs.subarray(j * 2, j * 2 + 2), i * 2);
    }
    nx = -nx; ny = -ny; nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return { ...q, positions, uvs, normal: [nx / len, ny / len, nz / len] };
}

function cubeElement(c: EntityCube, ctx: EmitContext): RawElement {
  const spec: BoxSpec = {
    texOffs: c.uv,
    from: c.from,
    size: c.size,
    texture: ctx.texture,
    texSize: ctx.texSize,
  };
  // Vanilla's `mirror` leaves the box exactly where it is and flips which corner gets
  // which u — i.e. a reflection about the box's own x centre. Handing box() that
  // reflection lets its UV solver work the permutation out, instead of hand-swapping six
  // faces here; box() rebuilds each face from the (unchanged) AABB, so the winding stays
  // outward and nothing turns inside-out.
  const el = box(c.mirror ? mirrorAboutX(c) : IDENTITY, spec);
  inflate(el, c.growXYZ);
  return el;
}

function mirrorAboutX(c: EntityCube): Mat {
  const cx = c.from[0] + c.size[0] / 2;
  return [-1, 0, 0, 2 * cx, 0, 1, 0, 0, 0, 0, 1, 0];
}

/** CubeDeformation: grows the geometry but NOT the UVs, so this runs after box(). */
function inflate(el: RawElement, grow: [number, number, number]): void {
  for (let i = 0; i < 3; i++) {
    if (!grow[i]) continue;
    el.from[i] -= grow[i];
    el.to[i] += grow[i];
  }
}

const DIR_VECTORS: Record<Direction, readonly [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
  south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

function transformQuad(q: BakedQuad, mat: Mat): BakedQuad {
  const positions = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    const [x, y, z] = [q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]];
    for (let r = 0; r < 3; r++) {
      positions[i * 3 + r] = mat[r * 4] * x + mat[r * 4 + 1] * y + mat[r * 4 + 2] * z + mat[r * 4 + 3];
    }
  }
  const normal = rotateVec(mat, q.normal);
  return { ...q, positions, normal, facing: nearestDir(normal), cullface: null };
}

/** ROOT and every part rotation are orthogonal with det +1, so normals rotate the same way. */
function rotateVec(mat: Mat, v: readonly [number, number, number]): [number, number, number] {
  return [
    mat[0] * v[0] + mat[1] * v[1] + mat[2] * v[2],
    mat[4] * v[0] + mat[5] * v[1] + mat[6] * v[2],
    mat[8] * v[0] + mat[9] * v[1] + mat[10] * v[2],
  ];
}

function nearestDir(n: readonly [number, number, number]): Direction {
  let best: Direction = 'up';
  let bestDot = -Infinity;
  for (const d of Object.keys(DIR_VECTORS) as Direction[]) {
    const v = DIR_VECTORS[d];
    const dot = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Turning quads into a drawable mesh

export interface EntityMesh {
  layers: Partial<Record<Layer, LayerBuffers>>;
  quadCount: number;
}

/**
 * Vanilla's directional face shading. Mobs are drawn through a flat, unlit material here,
 * so without this every mob reads as a single-colour silhouette; applying the same
 * constants the block mesher uses keeps their shape legible and their palette consistent
 * with the terrain around them. `facing` is recomputed from the transformed normal, so a
 * part rotated off-axis still gets the shade of the direction it ends up facing.
 */
const SHADE: Record<Direction, number> = {
  down: 0.5, up: 1.0, north: 0.8, south: 0.8, west: 0.6, east: 0.6,
};

/**
 * Entity textures are alpha-cut (wolf fur, bee wings, the villager's nose overlay), so
 * everything goes on the cutout layer — the solid layer's near-zero alphaTest would leave
 * black fringes.
 */
export function meshEntityQuads(quads: BakedQuad[], atlas: TextureAtlas): EntityMesh {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let n = 0;

  for (const q of quads) {
    const sprite = atlas.get(q.texture);
    if (!sprite) continue;
    const su = sprite.u1 - sprite.u0;
    const sv = sprite.v1 - sprite.v0;
    const v = SHADE[q.facing];
    for (let i = 0; i < 4; i++) {
      pos.push(q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]);
      nor.push(q.normal[0], q.normal[1], q.normal[2]);
      uv.push(sprite.u0 + q.uvs[i * 2] * su, sprite.v0 + q.uvs[i * 2 + 1] * sv);
      col.push(v, v, v, 1);
    }
    idx.push(n, n + 1, n + 2, n + 2, n + 3, n);
    n += 4;
  }

  if (!idx.length) return { layers: {}, quadCount: 0 };
  return {
    layers: {
      cutout: {
        positions: new Float32Array(pos),
        normals: new Float32Array(nor),
        uvs: new Float32Array(uv),
        colors: new Float32Array(col),
        indices: new Uint32Array(idx),
      },
    },
    quadCount: idx.length / 6,
  };
}
