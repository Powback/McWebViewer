/**
 * Geometry for blocks whose visible shape lives in a Java BlockEntityRenderer.
 *
 * ~15 vanilla blocks ship a particle-only model JSON: chests, signs, beds, banners,
 * skulls, shulker boxes, decorated pots. Their blockstate resolves to a model with no
 * `elements`, so the normal blockstate -> model -> quads path legitimately produces
 * nothing. Vanilla builds them in Java instead, from `CubeListBuilder` meshes plus a
 * `PoseStack` transform in the renderer. This module re-expresses that as data: it
 * synthesises a parent-less RawModel that our existing bakeModel() can consume.
 *
 * PROVENANCE. Every number below was read out of the 1.21.1 client jar's own bytecode
 * (constant pools + `ldc` sequences of the layer-definition and render methods), not
 * from memory. The obfuscated class name is cited next to each block so the reading can
 * be reproduced; the deobfuscated name is given where it is unambiguous. Where a number
 * is a guess or an approximation it says so explicitly.
 *
 * THE THREE THINGS THAT HAVE TO BE RIGHT
 *
 * 1. The cube UV unwrap. `CubeListBuilder.texOffs(u,v).addBox(x,y,z,w,h,d)` lays the six
 *    faces out on the texture in a fixed lattice (vanilla ModelPart.Cube):
 *        uLattice = [u, u+d, u+d+w, u+d+2w, u+2d+w, u+2d+2w]
 *        vLattice = [v, v+d, v+d+h]
 *        down  -> (u+d,    v)   .. (u+d+w,   v+d)
 *        up    -> (u+d+w,  v+d) .. (u+d+2w,  v)      <- v runs backwards, vanilla flips it
 *        west  -> (u,      v+d) .. (u+d,     v+d+h)
 *        north -> (u+d,    v+d) .. (u+d+w,   v+d+h)
 *        east  -> (u+d+w,  v+d) .. (u+2d+w,  v+d+h)
 *        south -> (u+2d+w, v+d) .. (u+2d+2w, v+d+h)
 *    Verified against assets/minecraft/textures/entity/chest/normal.png: the chest lid is
 *    texOffs(0,0) addBox(1,0,0, 14,5,14), so its `down` slot is u 14..28 and its `up` slot
 *    is u 28..42 — and in the real PNG u 14..28 is the dark lid underside while u 28..42
 *    is the planked lid top. That is only consistent if `down` takes the FIRST slot, which
 *    is the opposite of the "up first" layout one might assume. Also verified against
 *    entity/signs/oak.png and entity/decorated_pot/decorated_pot_base.png.
 *
 * 2. Which model corner gets which UV. Vanilla's ModelPart.Polygon assigns the rect
 *    corners to the four vertices in a specific order, and our bakeModel() assigns
 *    RawFace.uv to FACE_CORNERS[dir] in a *different* fixed order. Rather than hand-derive
 *    the permutation per face (and get it wrong once the renderer's transform rotates the
 *    box onto a different axis, as the bed's XP-90 does), `solveFaceUv` below matches the
 *    two corner orders geometrically and solves for the (uv, rotation) pair that
 *    reproduces vanilla exactly. That makes the whole thing transform-agnostic.
 *
 * 3. Orientation. We deliberately do NOT lean on the caller's Variant {x,y} rotation.
 *    Signs, banners and floor skulls rotate in 22.5-degree steps, which a Variant cannot
 *    express at all; and the block-centre position rotation in bakeModel() turns +Z into
 *    +X for y=90, whereas vanilla's BlockModelRotation (verified: it builds its quaternion
 *    with `new Quaternionf().rotateYXZ(-y*DEG_TO_RAD, -x*DEG_TO_RAD, 0)`) turns +Z into -X.
 *    Element-level `rotation` on the other hand *does* match vanilla — applyElementRotation
 *    for axis 'y' is exactly Axis.YP.rotationDegrees(+angle) — so all yaw here is baked
 *    either into the from/to (for 90-degree multiples, folded into the affine transform)
 *    or into an element rotation about the y axis. `berVariantRotation` therefore always
 *    returns {}; it exists so the caller has a stable API.
 */

import type { Direction, RawElement, RawFace, RawModel } from '../assets/model.js';

// ---------------------------------------------------------------------------
// Small affine helper. Mirrors PoseStack: each call post-multiplies, so the FIRST
// call is the outermost transform, exactly as in the vanilla renderers.

/** row-major 3x4: [m00,m01,m02,tx, m10,m11,m12,ty, m20,m21,m22,tz] */
type Mat = readonly number[];

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function matMul(a: Mat, b: Mat): Mat {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    }
    out[r * 4 + 3] =
      a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

/** poseStack.translate(x,y,z) — arguments here are MODEL units (1/16 block). */
function mTranslate(m: Mat, x: number, y: number, z: number): Mat {
  return matMul(m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
}
function mScale(m: Mat, x: number, y: number, z: number): Mat {
  return matMul(m, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]);
}
/** Axis.XP.rotationDegrees(deg): y -> z */
function mRotX(m: Mat, deg: number): Mat {
  const c = cos(deg);
  const s = sin(deg);
  return matMul(m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
}
/** Axis.YP.rotationDegrees(deg): z -> x */
function mRotY(m: Mat, deg: number): Mat {
  const c = cos(deg);
  const s = sin(deg);
  return matMul(m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
}
/** Axis.ZP.rotationDegrees(deg): x -> y */
function mRotZ(m: Mat, deg: number): Mat {
  const c = cos(deg);
  const s = sin(deg);
  return matMul(m, [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
}

/** Snap cos/sin at multiples of 90 so axis-aligned boxes stay exactly axis-aligned. */
function cos(deg: number): number {
  const n = ((deg % 360) + 360) % 360;
  if (n === 0) return 1;
  if (n === 90 || n === 270) return 0;
  if (n === 180) return -1;
  return Math.cos((n * Math.PI) / 180);
}
function sin(deg: number): number {
  const n = ((deg % 360) + 360) % 360;
  if (n === 0 || n === 180) return 0;
  if (n === 90) return 1;
  if (n === 270) return -1;
  return Math.sin((n * Math.PI) / 180);
}

function applyPoint(m: Mat, p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}
function applyVec(m: Mat, p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2],
  ];
}

// ---------------------------------------------------------------------------
// Face corner tables.
//
// LOCAL_FACES is vanilla ModelPart.Cube: for each face, the four vertices in the order
// the Polygon constructor uses, as [xIsMax, yIsMax, zIsMax] selectors, plus which entries
// of the u/v lattice bound the rect. Polygon then remaps vertex 0->(u1,v0), 1->(u0,v0),
// 2->(u0,v1), 3->(u1,v1).
//
// BAKER_CORNERS must stay identical to FACE_CORNERS in ../assets/model.ts — it is the
// order our own baker walks the four vertices of a face in. It is not exported there, so
// it is duplicated here; if that table ever changes this one has to change with it.

type Sel = readonly [0 | 1, 0 | 1, 0 | 1];

interface LocalFace {
  verts: readonly [Sel, Sel, Sel, Sel];
  /** indices into the u lattice [u, u+d, u+d+w, u+d+2w, u+2d+w, u+2d+2w] */
  u0: number;
  u1: number;
  /** indices into the v lattice [v, v+d, v+d+h] */
  v0: number;
  v1: number;
}

const LOCAL_FACES: Record<Direction, LocalFace> = {
  down: { verts: [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], u0: 1, u1: 2, v0: 0, v1: 1 },
  up: { verts: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]], u0: 2, u1: 3, v0: 1, v1: 0 },
  west: { verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], u0: 0, u1: 1, v0: 1, v1: 2 },
  north: { verts: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], u0: 1, u1: 2, v0: 1, v1: 2 },
  east: { verts: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], u0: 2, u1: 4, v0: 1, v1: 2 },
  south: { verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], u0: 4, u1: 5, v0: 1, v1: 2 },
};

/** Mirror of FACE_CORNERS in ../assets/model.ts, as [xIsMax, yIsMax, zIsMax]. */
const BAKER_CORNERS: Record<Direction, readonly [Sel, Sel, Sel, Sel]> = {
  down: [[1, 0, 1], [1, 0, 0], [0, 0, 0], [0, 0, 1]],
  up: [[0, 1, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};

const DIR_VECTORS: Record<Direction, readonly [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

const ALL_DIRS: readonly Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];

// ---------------------------------------------------------------------------
// box(): one CubeListBuilder cube, transformed into block space.

export interface BoxSpec {
  /** CubeListBuilder.texOffs(u, v) */
  texOffs: [number, number];
  /** addBox origin, in the part's own model space */
  from: [number, number, number];
  /** addBox w,h,d */
  size: [number, number, number];
  /** sprite id, or a `#var` reference into the model's texture map */
  texture: string;
  /** LayerDefinition.create(mesh, texWidth, texHeight) */
  texSize: [number, number];
  /** CubeDeformation: grows the geometry but NOT the UVs, like vanilla */
  grow?: number;
  /** restrict to these faces (vanilla's addBox(..., Set<Direction>) overload) */
  only?: readonly Direction[];
  /** extra offset applied to the cube before `mat`, i.e. the part's PartPose offset */
  partOffset?: [number, number, number];
}

interface Solved {
  uv: [number, number, number, number];
  rotation: number;
}

type Uv = readonly [number, number];
type Corner = { p: readonly [number, number, number]; uv: Uv };

function samePoint(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  return (
    Math.abs(a[0] - b[0]) < 1e-4 &&
    Math.abs(a[1] - b[1]) < 1e-4 &&
    Math.abs(a[2] - b[2]) < 1e-4
  );
}

/**
 * Vanilla's UV for each of the four corners in the order OUR baker walks them, i.e. the
 * per-slot UVs that the rotation search below has to reproduce. Null if the transformed
 * cube does not actually have a corner where the baker expects one.
 */
function bakerSlotUvs(
  dir: Direction,
  boxFrom: readonly [number, number, number],
  boxTo: readonly [number, number, number],
  corners: readonly Corner[],
): Uv[] | null {
  const bounds = [boxFrom, boxTo];
  const slotUv: Uv[] = [];
  for (const sel of BAKER_CORNERS[dir]) {
    const want: [number, number, number] = [
      bounds[sel[0]][0],
      bounds[sel[1]][1],
      bounds[sel[2]][2],
    ];
    const hit = corners.find((c) => samePoint(c.p, want));
    if (!hit) return null;
    slotUv.push(hit.uv);
  }
  return slotUv;
}

/** Fold one corner's u-or-v onto slot `i` of RawFace.uv. NaN marks a slot not yet set. */
function agree(out: number[], i: number, x: number): boolean {
  if (Number.isNaN(out[i])) {
    out[i] = x;
    return true;
  }
  return Math.abs(out[i] - x) < 1e-4;
}

/**
 * The RawFace.uv implied by one candidate face rotation, or null if the corners disagree.
 *
 * bakeModel: j = (i + rotation/90) & 3; u = (j===0||j===1 ? uv[0] : uv[2]);
 *                                       v = (j===0||j===3 ? uv[1] : uv[3])
 * so a rotation pins each corner's u onto uv[0] or uv[2] and its v onto uv[1] or uv[3];
 * a consistent assignment means this is the rotation vanilla used.
 */
function uvForShift(slotUv: readonly Uv[], shift: number): Solved['uv'] | null {
  const out: [number, number, number, number] = [NaN, NaN, NaN, NaN];
  for (let i = 0; i < 4; i++) {
    const j = (i + shift) & 3;
    const [uu, vv] = slotUv[i];
    if (!agree(out, j === 0 || j === 1 ? 0 : 2, uu)) return null;
    if (!agree(out, j === 0 || j === 3 ? 1 : 3, vv)) return null;
  }
  return out.some(Number.isNaN) ? null : out;
}

/**
 * Find the RawFace.uv (+ face rotation) that makes our baker reproduce vanilla's
 * per-corner UV assignment for this face, whatever axis the transform put it on.
 */
function solveFaceUv(
  dir: Direction,
  boxFrom: readonly [number, number, number],
  boxTo: readonly [number, number, number],
  corners: readonly Corner[],
): Solved | null {
  const slotUv = bakerSlotUvs(dir, boxFrom, boxTo, corners);
  if (!slotUv) return null;
  for (let shift = 0; shift < 4; shift++) {
    const uv = uvForShift(slotUv, shift);
    if (uv) return { uv, rotation: shift * 90 };
  }
  return null;
}

/** Which block-space direction a local face normal ends up pointing. */
function transformedDir(mat: Mat, dir: Direction): Direction {
  const v = applyVec(mat, DIR_VECTORS[dir]);
  let best: Direction = 'up';
  let bestMag = -Infinity;
  for (const d of ALL_DIRS) {
    const dv = DIR_VECTORS[d];
    const dot = v[0] * dv[0] + v[1] * dv[1] + v[2] * dv[2];
    if (dot > bestMag) {
      bestMag = dot;
      best = d;
    }
  }
  return best;
}

/** The cube's own model-space bounds, after CubeDeformation and the part's PartPose offset. */
function cubeBounds(spec: BoxSpec): {
  lo: [number, number, number];
  hi: [number, number, number];
} {
  const g = spec.grow ?? 0;
  const off = spec.partOffset ?? [0, 0, 0];
  return {
    lo: [
      spec.from[0] - g + off[0],
      spec.from[1] - g + off[1],
      spec.from[2] - g + off[2],
    ],
    hi: [
      spec.from[0] + spec.size[0] + g + off[0],
      spec.from[1] + spec.size[1] + g + off[1],
      spec.from[2] + spec.size[2] + g + off[2],
    ],
  };
}

/**
 * Block-space AABB of the transformed cube. `mat` is always an axis permutation with
 * scales, so transforming the two extreme corners and re-min/maxing is exact.
 */
function transformedAabb(
  mat: Mat,
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): { from: [number, number, number]; to: [number, number, number] } {
  const c0 = applyPoint(mat, lo);
  const c1 = applyPoint(mat, hi);
  return {
    from: [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.min(c0[2], c1[2])],
    to: [Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]), Math.max(c0[2], c1[2])],
  };
}

/**
 * The cube's u/v lattices (see the header note), already scaled into sprite space:
 * entity textures are addressed in their own pixel space, our baker wants 0..16 of the
 * sprite, so scale by 16/texSize.
 */
function uvLattice(spec: BoxSpec): { uLat: number[]; vLat: number[] } {
  const [u, v] = spec.texOffs;
  const [w, h, d] = spec.size;
  const su = 16 / spec.texSize[0];
  const sv = 16 / spec.texSize[1];
  return {
    uLat: [u, u + d, u + d + w, u + d + 2 * w, u + 2 * d + w, u + 2 * d + 2 * w].map(
      (x) => x * su,
    ),
    vLat: [v, v + d, v + d + h].map((x) => x * sv),
  };
}

/** Local axis a face's normal lies on: x=0, y=1, z=2. */
const FACE_AXIS: Record<Direction, 0 | 1 | 2> = {
  east: 0, west: 0, up: 1, down: 1, north: 2, south: 2,
};

/** Zero-area face? Flat plates keep only the two faces normal to the flat axis. */
function isDegenerateFace(
  dir: Direction,
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
): boolean {
  const axis = FACE_AXIS[dir];
  for (let i = 0; i < 3; i++) {
    if (i !== axis && Math.abs(hi[i] - lo[i]) < 1e-6) return true;
  }
  return false;
}

/** Everything solveBoxFace needs about the cube, computed once per box(). */
interface BoxGeom {
  mat: Mat;
  lo: [number, number, number];
  hi: [number, number, number];
  from: [number, number, number];
  to: [number, number, number];
  uLat: number[];
  vLat: number[];
  texture: string;
}

/**
 * One local face of the cube, moved into block space: which block-space direction it
 * ended up facing, and the RawFace that reproduces vanilla's UVs there.
 */
function solveBoxFace(g: BoxGeom, dir: Direction): { dir: Direction; face: RawFace } | null {
  const lf = LOCAL_FACES[dir];
  const rectU: [number, number] = [g.uLat[lf.u0], g.uLat[lf.u1]];
  const rectV: [number, number] = [g.vLat[lf.v0], g.vLat[lf.v1]];
  // Polygon: vertex0 -> (u1,v0), 1 -> (u0,v0), 2 -> (u0,v1), 3 -> (u1,v1)
  const vertUv: Array<readonly [number, number]> = [
    [rectU[1], rectV[0]],
    [rectU[0], rectV[0]],
    [rectU[0], rectV[1]],
    [rectU[1], rectV[1]],
  ];

  const corners = lf.verts.map((sel, i) => ({
    p: applyPoint(g.mat, [
      sel[0] ? g.hi[0] : g.lo[0],
      sel[1] ? g.hi[1] : g.lo[1],
      sel[2] ? g.hi[2] : g.lo[2],
    ]),
    uv: vertUv[i],
  }));

  const outDir = transformedDir(g.mat, dir);
  const solved = solveFaceUv(outDir, g.from, g.to, corners);
  if (!solved) return null; // should not happen for axis-aligned transforms
  const face: RawFace = { uv: solved.uv, texture: g.texture };
  if (solved.rotation) face.rotation = solved.rotation;
  return { dir: outDir, face };
}

/**
 * Build one RawElement from a vanilla cube plus the renderer's transform.
 * `mat` maps the part's model space (0..16 units) straight into block model space.
 */
export function box(mat: Mat, spec: BoxSpec, rotation?: RawElement['rotation']): RawElement {
  const { lo, hi } = cubeBounds(spec);
  const { from, to } = transformedAabb(mat, lo, hi);
  const { uLat, vLat } = uvLattice(spec);
  const geom: BoxGeom = { mat, lo, hi, from, to, uLat, vLat, texture: spec.texture };

  const wanted = spec.only ? new Set<Direction>(spec.only) : null;
  const faces: Partial<Record<Direction, RawFace>> = {};

  for (const dir of ALL_DIRS) {
    if (wanted && !wanted.has(dir)) continue;
    if (isDegenerateFace(dir, lo, hi)) continue;
    const solved = solveBoxFace(geom, dir);
    if (solved) faces[solved.dir] = solved.face;
  }

  const el: RawElement = { from, to, faces };
  if (rotation) el.rotation = rotation;
  return el;
}

// ---------------------------------------------------------------------------
// Shared vocabulary

/** Direction.toYRot(): south=0, west=90, north=180, east=270. */
const Y_ROT: Record<string, number> = { south: 0, west: 90, north: 180, east: 270 };
const STEP_X: Record<string, number> = { north: 0, south: 0, west: -1, east: 1 };
const STEP_Z: Record<string, number> = { north: -1, south: 1, west: 0, east: 0 };

function yRot(facing: string | undefined): number {
  return Y_ROT[facing ?? 'south'] ?? 0;
}

/** RotationSegment.convertToDegrees: 16 segments over 360 degrees. */
function segmentDegrees(rotation: string | undefined): number {
  const n = Number.parseInt(rotation ?? '0', 10);
  return (Number.isFinite(n) ? n : 0) * 22.5;
}

function yawRotation(
  angle: number,
  originX = 8,
  originZ = 8,
): RawElement['rotation'] | undefined {
  const a = ((angle % 360) + 360) % 360;
  if (a === 0) return undefined;
  return { origin: [originX, 8, originZ], axis: 'y', angle: a > 180 ? a - 360 : a };
}

const WOOD_TYPES = [
  'oak', 'spruce', 'birch', 'acacia', 'cherry', 'jungle', 'dark_oak', 'mangrove',
  'bamboo', 'crimson', 'warped',
];
const DYE_COLOURS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

function model(elements: RawElement[], textures: Record<string, string>): RawModel {
  return { textures, elements, ambientocclusion: false };
}

// ---------------------------------------------------------------------------
// 1. SIGNS — vanilla SignRenderer / SignModel (obf ghn), HangingSignRenderer (obf ghj)
//
// SignRenderer.createSignLayer, LayerDefinition.create(mesh, 64, 32):
//     "sign"  texOffs(0,0)  addBox(-12,-14,-1, 24,12,2)
//     "stick" texOffs(0,14) addBox( -1, -2,-1,  2,14,2)   (standing signs only)
// SignRenderer.translateSign:
//     translate(0.5, 0.75 * RENDER_SCALE, 0.5); mulPose(YP.rotationDegrees(yRot));
//     if (!standing) translate(0, -0.3125, -0.4375);
// SignRenderer.renderSignModel: scale(RENDER_SCALE, -RENDER_SCALE, -RENDER_SCALE),
//     RENDER_SCALE = 0.6666667, so the first translate is really (0.5, 0.5, 0.5).
//
// Yaw: the unrotated model sits on the low-z side of the block and reads from +z, i.e. it
// faces SOUTH — same canonical orientation as the chest, whose renderer demonstrably uses
// -facing.toYRot(). So the effective yaw is -toYRot(facing) for wall signs and
// -(rotation * 22.5) for standing signs (rotation=0 is a sign facing south).

const SIGN_SCALE = 0.6666667;

function signModel(wood: string, wall: boolean, props: Record<string, string>): RawModel {
  // T(0.5,0.5,0.5) [* T(0,-0.3125,-0.4375) for wall] * S(s,-s,-s), with the yaw peeled
  // out into an element rotation about the block's vertical centre line.
  let mat = mTranslate(IDENTITY, 8, 8, 8);
  if (wall) mat = mTranslate(mat, 0, -5, -7);
  mat = mScale(mat, SIGN_SCALE, -SIGN_SCALE, -SIGN_SCALE);

  const yaw = wall ? -yRot(props.facing) : -segmentDegrees(props.rotation);
  const rot = yawRotation(yaw);
  const tex = '#sign';
  const texSize: [number, number] = [64, 32];

  const els: RawElement[] = [
    box(mat, { texOffs: [0, 0], from: [-12, -14, -1], size: [24, 12, 2], texture: tex, texSize }, rot),
  ];
  if (!wall) {
    els.push(
      box(mat, { texOffs: [0, 14], from: [-1, -2, -1], size: [2, 14, 2], texture: tex, texSize }, rot),
    );
  }
  return model(els, { sign: `minecraft:entity/signs/${wood}`, particle: `minecraft:block/${wood}_planks` });
}

// HangingSignRenderer (obf ghj): getSignModelRenderScale() = 1.0, translateSign:
//     translate(0.5, 0.9375, 0.5); mulPose(YP.rotationDegrees(yRot)); translate(0, -0.3125, 0)
// then scale(1, -1, -1). Layer (64x32):
//     "board" texOffs(0,12) addBox(-7, 0,-1, 14,10,2)
//     "plank" texOffs(0, 0) addBox(-8,-6,-2, 16, 2,4)
//     "vChains" texOffs(14,6) addBox(-6,-6,0, 12,6,0)
//     four diagonal "chainL1/L2/R1/R2" plates, each texOffs(0|6,6) addBox(-1.5,0,0, 3,6,0)
//     at PartPose.offsetAndRotation(+-5,-6,0, 0, +-PI/4, 0)
// APPROXIMATION: the four diagonal chains need a second, non-axis-aligned rotation that a
// single RawElement cannot carry alongside the sign's own yaw, so we always draw the
// axis-aligned `vChains` plate instead (what vanilla uses when attached=true). Visually
// it is a flat link plate in the same place; the X-crossing of the loose chains is lost.

function hangingSignModel(wood: string, wall: boolean, props: Record<string, string>): RawModel {
  let mat = mTranslate(IDENTITY, 8, 15, 8);
  mat = mTranslate(mat, 0, -5, 0);
  mat = mScale(mat, 1, -1, -1);

  const yaw = wall ? -yRot(props.facing) : -segmentDegrees(props.rotation);
  const rot = yawRotation(yaw);
  const tex = '#sign';
  const texSize: [number, number] = [64, 32];

  return model(
    [
      box(mat, { texOffs: [0, 12], from: [-7, 0, -1], size: [14, 10, 2], texture: tex, texSize }, rot),
      box(mat, { texOffs: [0, 0], from: [-8, -6, -2], size: [16, 2, 4], texture: tex, texSize }, rot),
      box(
        mat,
        {
          texOffs: [14, 6], from: [-6, -6, 0], size: [12, 6, 0], texture: tex, texSize,
          only: ['north', 'south'],
        },
        rot,
      ),
    ],
    { sign: `minecraft:entity/signs/hanging/${wood}`, particle: `minecraft:block/${wood}_planks` },
  );
}

// ---------------------------------------------------------------------------
// 2. CHESTS — vanilla ChestRenderer / ChestModel (obf ghf)
//
// Three layer definitions, all LayerDefinition.create(mesh, 64, 64):
//   single: bottom texOffs(0,19) addBox(1,0,1, 14,10,14)
//           lid    texOffs(0, 0) addBox(1,0,0, 14, 5,14) @ PartPose.offset(0,9,1)
//           lock   texOffs(0, 0) addBox(7,-2,14, 2,4,1)  @ PartPose.offset(0,9,1)
//   "c":    bottom addBox(1,0,1, 15,10,14) / lid addBox(1,0,0, 15,5,14) / lock addBox(15,-2,14, 1,4,1)
//   "d":    bottom addBox(0,0,1, 15,10,14) / lid addBox(0,0,0, 15,5,14) / lock addBox( 0,-2,14, 1,4,1)
// ChestRenderer.render: translate(0.5,0.5,0.5); mulPose(YP.rotationDegrees(-facing.toYRot()));
//                       translate(-0.5,-0.5,-0.5)     — no scale, no axis flip.
// The lid's xRot is -openness*PI/2, i.e. 0 for a closed chest, which is all we render.
//
// LEFT vs RIGHT: resolved from the textures, not guessed. In normal_left.png the WEST face
// slot of the side strip (u 0..14) is blank; in normal_right.png the EAST slot (u 29..43)
// is blank. A blank slot is the seam that butts against the other half. Model "d" spans
// x 0..15 so its open end is at -x (west) -> that is the LEFT half; model "c" spans x 1..16
// so its open end is at +x (east) -> RIGHT. We drop the seam face entirely rather than
// emit a transparent quad coplanar with the neighbour's.

interface ChestHalf {
  bottomFrom: [number, number, number];
  bottomSize: [number, number, number];
  lidFrom: [number, number, number];
  lidSize: [number, number, number];
  lockFrom: [number, number, number];
  lockSize: [number, number, number];
  /** face omitted because it is the double-chest seam */
  seam?: Direction;
  suffix: string;
}

const CHEST_SINGLE: ChestHalf = {
  bottomFrom: [1, 0, 1], bottomSize: [14, 10, 14],
  lidFrom: [1, 0, 0], lidSize: [14, 5, 14],
  lockFrom: [7, -2, 14], lockSize: [2, 4, 1],
  suffix: '',
};
const CHEST_LEFT: ChestHalf = {
  bottomFrom: [0, 0, 1], bottomSize: [15, 10, 14],
  lidFrom: [0, 0, 0], lidSize: [15, 5, 14],
  lockFrom: [0, -2, 14], lockSize: [1, 4, 1],
  seam: 'west',
  suffix: '_left',
};
const CHEST_RIGHT: ChestHalf = {
  bottomFrom: [1, 0, 1], bottomSize: [15, 10, 14],
  lidFrom: [1, 0, 0], lidSize: [15, 5, 14],
  lockFrom: [15, -2, 14], lockSize: [1, 4, 1],
  seam: 'east',
  suffix: '_right',
};

function chestModel(base: string, props: Record<string, string>): RawModel {
  const type = props.type ?? 'single';
  // Ender chests have no double variant.
  const half =
    base === 'ender' || type === 'single'
      ? CHEST_SINGLE
      : type === 'left'
        ? CHEST_LEFT
        : CHEST_RIGHT;

  const rot = yawRotation(-yRot(props.facing));
  const tex = '#chest';
  const texSize: [number, number] = [64, 64];
  const only = half.seam
    ? (ALL_DIRS.filter((d) => d !== half.seam) as Direction[])
    : undefined;

  const mat = IDENTITY; // translate/rotate/translate cancels once the yaw is peeled off

  return model(
    [
      box(mat, { texOffs: [0, 19], from: half.bottomFrom, size: half.bottomSize, texture: tex, texSize, only }, rot),
      box(mat, { texOffs: [0, 0], from: half.lidFrom, size: half.lidSize, texture: tex, texSize, only, partOffset: [0, 9, 1] }, rot),
      box(mat, { texOffs: [0, 0], from: half.lockFrom, size: half.lockSize, texture: tex, texSize, partOffset: [0, 9, 1] }, rot),
    ],
    {
      chest: `minecraft:entity/chest/${base}${base === 'ender' ? '' : half.suffix}`,
      particle: 'minecraft:block/oak_planks',
    },
  );
}

// ---------------------------------------------------------------------------
// 3. DECORATED POT — vanilla DecoratedPotRenderer / DecoratedPotModel (obf ghh)
//
// Base layer, LayerDefinition.create(mesh, 32, 32):
//   "neck"   texOffs(0,0) addBox(4,17,4, 8,3,8, CubeDeformation(0.2))
//            texOffs(0,5) addBox(5,20,5, 6,1,6, CubeDeformation(-0.1))
//            @ PartPose.offsetAndRotation(0, 37, 16, PI, 0, 0)
//   "top"/"bottom" share texOffs(-14,13) addBox(0,0,0, 14,0,14)
//            @ PartPose.offset(1,16,1) and (1,0,1)
// Sides layer, LayerDefinition.create(mesh, 16, 16): one texOffs(1,0) addBox(0,0,0, 14,16,0)
//   plate reused four times, at offsetAndRotation
//   back (15,16,1, 0,0,PI) / left (1,16,1, 0,-PI/2,PI) / right (15,16,15, 0,PI/2,PI) /
//   front (1,16,15, PI,0,0)  -> four flat 14x16 quads at x=1, x=15, z=1, z=15.
// DecoratedPotRenderer.render: translate(0.5,0,0.5);
//   mulPose(YP.rotationDegrees(180 - facing.toYRot())); translate(-0.5,0,-0.5).
//
// HONEST APPROXIMATION: taken literally, PartPose y=37 with the PI x-rotation puts the neck
// at y 16.8..20.2 — above the block, which cannot be what is drawn. We could not find the
// compensating transform in the renderer's bytecode, so the neck is shifted down 4 units
// (as if the offset were 33) to cap the pot at y 12.8..16.2. Everything else here is literal.
const POT_NECK_FUDGE = -4;

/** PartPose.offsetAndRotation(x, y, z, xRot, yRot, zRot), degrees rather than radians. */
interface PartPose {
  x: number;
  y: number;
  z: number;
  xr: number;
  yr: number;
  zr: number;
}

function decoratedPotModel(props: Record<string, string>): RawModel {
  const rot = yawRotation(180 - yRot(props.facing));
  const base = '#base';
  const side = '#side';
  const bs: [number, number] = [32, 32];
  const ss: [number, number] = [16, 16];

  // "neck": PartPose.offsetAndRotation(0, 37 + fudge, 16, PI, 0, 0)
  const neck = mRotX(mTranslate(IDENTITY, 0, 37 + POT_NECK_FUDGE, 16), 180);
  // The two flat plates carry no rotation, just an offset.
  const top = mTranslate(IDENTITY, 1, 16, 1);
  const bottom = mTranslate(IDENTITY, 1, 0, 1);
  // Four side plates. rotateZYX(zRot, yRot, xRot) is how ModelPart composes a PartPose.
  const sideMat = (p: PartPose): Mat =>
    mRotX(mRotY(mRotZ(mTranslate(IDENTITY, p.x, p.y, p.z), p.zr), p.yr), p.xr);

  const plate: Omit<BoxSpec, 'texOffs' | 'from' | 'size' | 'texture' | 'texSize'> = {
    only: ['north'],
  };

  return model(
    [
      box(neck, { texOffs: [0, 0], from: [4, 17, 4], size: [8, 3, 8], grow: 0.2, texture: base, texSize: bs }, rot),
      box(neck, { texOffs: [0, 5], from: [5, 20, 5], size: [6, 1, 6], grow: -0.1, texture: base, texSize: bs }, rot),
      box(top, { texOffs: [-14, 13], from: [0, 0, 0], size: [14, 0, 14], texture: base, texSize: bs }, rot),
      box(bottom, { texOffs: [-14, 13], from: [0, 0, 0], size: [14, 0, 14], texture: base, texSize: bs }, rot),
      // back
      box(sideMat({ x: 15, y: 16, z: 1, xr: 0, yr: 0, zr: 180 }), { texOffs: [1, 0], from: [0, 0, 0], size: [14, 16, 0], texture: side, texSize: ss, ...plate }, rot),
      // left
      box(sideMat({ x: 1, y: 16, z: 1, xr: 0, yr: -90, zr: 180 }), { texOffs: [1, 0], from: [0, 0, 0], size: [14, 16, 0], texture: side, texSize: ss, ...plate }, rot),
      // right
      box(sideMat({ x: 15, y: 16, z: 15, xr: 0, yr: 90, zr: 180 }), { texOffs: [1, 0], from: [0, 0, 0], size: [14, 16, 0], texture: side, texSize: ss, ...plate }, rot),
      // front
      box(sideMat({ x: 1, y: 16, z: 15, xr: 180, yr: 0, zr: 0 }), { texOffs: [1, 0], from: [0, 0, 0], size: [14, 16, 0], texture: side, texSize: ss, ...plate }, rot),
    ],
    {
      base: 'minecraft:entity/decorated_pot/decorated_pot_base',
      // Sherds would each need their own pattern sprite plus a per-face material; we draw
      // the plain terracotta side on all four faces instead.
      side: 'minecraft:entity/decorated_pot/decorated_pot_side',
      particle: 'minecraft:block/terracotta',
    },
  );
}

// ---------------------------------------------------------------------------
// 4. BEDS — vanilla BedRenderer / BedModel (obf ggw)
//
// head layer (64x64): main texOffs(0, 0) addBox(0,0,0, 16,16,6)
//                     left_leg  texOffs(50, 6) addBox(  0,6,  0, 3,3,3) @ rotation(PI/2, 0, PI/2)
//                     right_leg texOffs(50,18) addBox(-16,6,  0, 3,3,3) @ rotation(PI/2, 0, PI)
// foot layer (64x64): main texOffs(0,22) addBox(0,0,0, 16,16,6)
//                     left_leg  texOffs(50, 0) addBox(  0,6,-16, 3,3,3) @ rotation(PI/2, 0, 0)
//                     right_leg texOffs(50,12) addBox(-16,6,-16, 3,3,3) @ rotation(PI/2, 0, 3PI/2)
// BedRenderer.renderPiece:
//     translate(0, 0.5625, isItem ? -1 : 0); mulPose(XP.rotationDegrees(90));
//     translate(0.5,0.5,0.5); mulPose(ZP.rotationDegrees(180 + facing.toYRot()));
//     translate(-0.5,-0.5,-0.5)
// The boolean is an ITEM flag, not a head flag: the in-world call site passes `false` and
// the inventory call site renders head(false) + foot(true) to place the two halves a block
// apart. So there is no z shift for world beds. Checked: this puts the mattress at
// y 3..9 spanning the full footprint and the legs at the outer end, as vanilla does.

function bedModel(colour: string, props: Record<string, string>): RawModel {
  const head = (props.part ?? 'foot') === 'head';
  let mat = mTranslate(IDENTITY, 0, 9, 0);
  mat = mRotX(mat, 90);
  mat = mTranslate(mat, 8, 8, 8);
  mat = mRotZ(mat, 180 + yRot(props.facing));
  mat = mTranslate(mat, -8, -8, -8);

  const tex = '#bed';
  const texSize: [number, number] = [64, 64];
  // PartPose.rotation(x,y,z) is applied as rotateZYX(z, y, x).
  const leg = (xr: number, zr: number): Mat => mRotX(mRotZ(mat, zr), xr);

  const els = head
    ? [
        box(mat, { texOffs: [0, 0], from: [0, 0, 0], size: [16, 16, 6], texture: tex, texSize }),
        box(leg(90, 90), { texOffs: [50, 6], from: [0, 6, 0], size: [3, 3, 3], texture: tex, texSize }),
        box(leg(90, 180), { texOffs: [50, 18], from: [-16, 6, 0], size: [3, 3, 3], texture: tex, texSize }),
      ]
    : [
        box(mat, { texOffs: [0, 22], from: [0, 0, 0], size: [16, 16, 6], texture: tex, texSize }),
        box(leg(90, 0), { texOffs: [50, 0], from: [0, 6, -16], size: [3, 3, 3], texture: tex, texSize }),
        box(leg(90, 270), { texOffs: [50, 12], from: [-16, 6, -16], size: [3, 3, 3], texture: tex, texSize }),
      ];

  return model(els, {
    bed: `minecraft:entity/bed/${colour}`,
    particle: `minecraft:block/${colour}_wool`,
  });
}

// ---------------------------------------------------------------------------
// 5. BANNERS — vanilla BannerRenderer / BannerModel (obf ggu)
//
// LayerDefinition.create(mesh, 64, 64):
//     "flag" texOffs( 0, 0) addBox(-10,   0,-2, 20,40,1)
//     "pole" texOffs(44, 0) addBox( -1, -30,-1,  2,42,2)
//     "bar"  texOffs( 0,42) addBox(-10, -32,-1, 20, 2,2)
// BannerRenderer.render, standing:
//     translate(0.5,0.5,0.5); mulPose(YP.rotationDegrees(-rotationSegmentDegrees)); pole visible
// wall:
//     translate(0.5,-0.16666667,0.5); mulPose(YP.rotationDegrees(-facing.toYRot()));
//     translate(0, -0.3125, -0.4375); pole hidden
// then scale(0.6666667, -0.6666667, -0.6666667), and the flag part is given y = -32.
// The tiny animated flag.xRot (about -2.25 degrees at rest) is dropped.
//
// COLOUR: vanilla draws the flag twice — once with entity/banner_base, once with
// entity/banner/base tinted by the dye colour, plus a layer per pattern. We have no
// per-block tint channel for arbitrary dyes, so the flag gets the untinted
// entity/banner_base sprite and banners render in the base wood/white colours.

function bannerModel(wall: boolean, props: Record<string, string>): RawModel {
  let mat = wall
    ? mTranslate(IDENTITY, 8, -16 / 6, 8)
    : mTranslate(IDENTITY, 8, 8, 8);
  if (wall) mat = mTranslate(mat, 0, -5, -7);
  mat = mScale(mat, SIGN_SCALE, -SIGN_SCALE, -SIGN_SCALE);

  const yaw = wall ? -yRot(props.facing) : -segmentDegrees(props.rotation);
  const rot = yawRotation(yaw);
  const tex = '#banner';
  const texSize: [number, number] = [64, 64];

  const els: RawElement[] = [
    box(mat, { texOffs: [0, 0], from: [-10, 0, -2], size: [20, 40, 1], texture: tex, texSize, partOffset: [0, -32, 0] }, rot),
    box(mat, { texOffs: [0, 42], from: [-10, -32, -1], size: [20, 2, 2], texture: tex, texSize }, rot),
  ];
  if (!wall) {
    els.push(box(mat, { texOffs: [44, 0], from: [-1, -30, -1], size: [2, 42, 2], texture: tex, texSize }, rot));
  }
  return model(els, {
    banner: 'minecraft:entity/banner_base',
    particle: 'minecraft:block/oak_planks',
  });
}

// ---------------------------------------------------------------------------
// 6. SKULLS / HEADS — vanilla SkullBlockRenderer / SkullModel (obf fxg)
//
// SkullModel.createHeadModel: "head" texOffs(0,0) addBox(-4,-8,-4, 8,8,8).
// createMobHeadLayer uses a 64x32 sheet, createHumanoidHeadLayer a 64x64 sheet plus a
// "hat" texOffs(32,0) with CubeDeformation(0.25).
// SkullBlockRenderer.renderSkull:
//     floor: translate(0.5, 0, 0.5)
//     wall:  translate(0.5 - stepX*0.25, 0.25, 0.5 - stepZ*0.25)
//     then scale(-1,-1,1), and the model's head.yRot = segmentDegrees.
// scale(-1,-1,1) is a proper 180-degree rotation about z, and S*Ry(t) == Ry(-t)*S, so the
// net world yaw is -segmentDegrees about the translate point (which is NOT the block
// centre for wall skulls). Wall skulls take their segment from facing.getOpposite(), which
// is why a wall skull facing north sits against the +z wall and looks north.
//
// PIGLIN and DRAGON heads have their own models (ears / snout, a whole dragon skull); we
// draw the plain 8x8x8 head box for them. Recognisable, not faithful.

interface SkullKind {
  texture: string;
  texSize: [number, number];
  /** humanoid heads carry a second, slightly larger "hat" cube */
  hat: boolean;
}

const SKULL_KINDS: Record<string, SkullKind> = {
  skeleton: { texture: 'minecraft:entity/skeleton/skeleton', texSize: [64, 32], hat: false },
  wither_skeleton: { texture: 'minecraft:entity/skeleton/wither_skeleton', texSize: [64, 32], hat: false },
  creeper: { texture: 'minecraft:entity/creeper/creeper', texSize: [64, 32], hat: false },
  zombie: { texture: 'minecraft:entity/zombie/zombie', texSize: [64, 64], hat: true },
  player: { texture: 'minecraft:entity/player/wide/steve', texSize: [64, 64], hat: true },
  piglin: { texture: 'minecraft:entity/piglin/piglin', texSize: [64, 64], hat: false },
  dragon: { texture: 'minecraft:entity/enderdragon/dragon', texSize: [256, 256], hat: false },
};

function skullModel(kind: SkullKind, wall: boolean, props: Record<string, string>): RawModel {
  const facing = props.facing ?? 'north';
  const ox = wall ? 8 - (STEP_X[facing] ?? 0) * 4 : 8;
  const oz = wall ? 8 - (STEP_Z[facing] ?? 0) * 4 : 8;
  const oy = wall ? 4 : 0;

  let mat = mTranslate(IDENTITY, ox, oy, oz);
  mat = mScale(mat, -1, -1, 1);

  // Wall skulls: segment comes from facing.getOpposite(); floor skulls from ROTATION.
  const segDeg = wall ? yRot(OPPOSITE_H[facing] ?? 'south') : segmentDegrees(props.rotation);
  const rot = yawRotation(-segDeg, ox, oz);

  const tex = '#skull';
  const els: RawElement[] = [
    box(mat, { texOffs: [0, 0], from: [-4, -8, -4], size: [8, 8, 8], texture: tex, texSize: kind.texSize }, rot),
  ];
  if (kind.hat) {
    els.push(
      box(mat, { texOffs: [32, 0], from: [-4, -8, -4], size: [8, 8, 8], grow: 0.25, texture: tex, texSize: kind.texSize }, rot),
    );
  }
  return model(els, { skull: kind.texture, particle: 'minecraft:block/soul_sand' });
}

const OPPOSITE_H: Record<string, string> = {
  north: 'south', south: 'north', west: 'east', east: 'west',
};

// ---------------------------------------------------------------------------
// 7. SHULKER BOXES — vanilla ShulkerBoxRenderer / ShulkerModel (obf fxd)
//
// LayerDefinition.create(mesh, 64, 64):
//     "lid"  texOffs( 0, 0) addBox(-8,-16,-8, 16,12,16) @ PartPose.offset(0,24,0)
//     "base" texOffs( 0,28) addBox(-8, -8,-8, 16, 8,16) @ PartPose.offset(0,24,0)
//     "head" texOffs( 0,52) addBox(-3,  0,-3,  6, 6, 6) @ PartPose.offset(0,12,0)
// ShulkerBoxRenderer.render: translate(0.5,0.5,0.5); scale(0.9995); mulPose(facing.getRotation());
//     scale(1,-1,-1); translate(0,-1,0); lid y = 24 - progress*8 (24 => closed).
// The 0.9995 shrink is a z-fighting guard we drop. Direction.getRotation() was NOT read out
// of the jar — SHULKER_FACE_ROT below is derived from first principles (it must carry the
// model's +y onto the block face named by FACING) and matches vanilla for `up`, which is
// the only orientation we could confirm.

const SHULKER_FACE_ROT: Record<string, (m: Mat) => Mat> = {
  up: (m) => m,
  down: (m) => mRotX(m, 180),
  north: (m) => mRotX(m, -90),
  south: (m) => mRotX(m, 90),
  west: (m) => mRotZ(m, 90),
  east: (m) => mRotZ(m, -90),
};

function shulkerModel(colour: string | null, props: Record<string, string>): RawModel {
  const facing = props.facing ?? 'up';
  let mat = mTranslate(IDENTITY, 8, 8, 8);
  mat = (SHULKER_FACE_ROT[facing] ?? SHULKER_FACE_ROT.up)(mat);
  mat = mScale(mat, 1, -1, -1);
  mat = mTranslate(mat, 0, -16, 0);

  const tex = '#shulker';
  const texSize: [number, number] = [64, 64];
  return model(
    [
      box(mat, { texOffs: [0, 28], from: [-8, -8, -8], size: [16, 8, 16], texture: tex, texSize, partOffset: [0, 24, 0] }),
      box(mat, { texOffs: [0, 0], from: [-8, -16, -8], size: [16, 12, 16], texture: tex, texSize, partOffset: [0, 24, 0] }),
    ],
    {
      shulker: colour
        ? `minecraft:entity/shulker/shulker_${colour}`
        : 'minecraft:entity/shulker/shulker',
      particle: 'minecraft:block/purpur_block',
    },
  );
}

// ---------------------------------------------------------------------------
// Dispatch

const SIGN_WOODS = WOOD_TYPES;
const HANGING_WOODS = WOOD_TYPES; // every wood type has a hanging sign in 1.21

const SKULL_BLOCKS: Record<string, { kind: string; wall: boolean }> = {
  skeleton_skull: { kind: 'skeleton', wall: false },
  skeleton_wall_skull: { kind: 'skeleton', wall: true },
  wither_skeleton_skull: { kind: 'wither_skeleton', wall: false },
  wither_skeleton_wall_skull: { kind: 'wither_skeleton', wall: true },
  zombie_head: { kind: 'zombie', wall: false },
  zombie_wall_head: { kind: 'zombie', wall: true },
  creeper_head: { kind: 'creeper', wall: false },
  creeper_wall_head: { kind: 'creeper', wall: true },
  player_head: { kind: 'player', wall: false },
  player_wall_head: { kind: 'player', wall: true },
  piglin_head: { kind: 'piglin', wall: false },
  piglin_wall_head: { kind: 'piglin', wall: true },
  dragon_head: { kind: 'dragon', wall: false },
  dragon_wall_head: { kind: 'dragon', wall: true },
};

const CHEST_BLOCKS: Record<string, string> = {
  chest: 'normal',
  trapped_chest: 'trapped',
  ender_chest: 'ender',
};

type BerBuilder = (props: Record<string, string>) => RawModel;

/** Fill in the chest / decorated pot / skull entries, which are keyed by exact name. */
function registerNamedBlocks(m: Map<string, BerBuilder>): void {
  for (const [block, base] of Object.entries(CHEST_BLOCKS)) {
    m.set(block, (props) => chestModel(base, props));
  }

  m.set('decorated_pot', (props) => decoratedPotModel(props));

  for (const [block, skull] of Object.entries(SKULL_BLOCKS)) {
    const kind = SKULL_KINDS[skull.kind];
    if (kind) m.set(block, (props) => skullModel(kind, skull.wall, props));
  }
}

/**
 * Fill in the suffix-driven families. Expanding every `<wood>`/`<colour>` combination up
 * front rather than testing suffixes at lookup time also disposes of the ordering hazard
 * the old if-chain had to guard against by hand — that `_wall_hanging_sign` must not be
 * eaten by `_hanging_sign`, nor `_wall_sign` by `_sign`.
 */
function registerFamilies(m: Map<string, BerBuilder>): void {
  for (const wood of SIGN_WOODS) {
    m.set(`${wood}_wall_sign`, (props) => signModel(wood, true, props));
    m.set(`${wood}_sign`, (props) => signModel(wood, false, props));
  }

  for (const wood of HANGING_WOODS) {
    m.set(`${wood}_wall_hanging_sign`, (props) => hangingSignModel(wood, true, props));
    m.set(`${wood}_hanging_sign`, (props) => hangingSignModel(wood, false, props));
  }

  for (const colour of DYE_COLOURS) {
    m.set(`${colour}_bed`, (props) => bedModel(colour, props));
    m.set(`${colour}_wall_banner`, (props) => bannerModel(true, props));
    m.set(`${colour}_banner`, (props) => bannerModel(false, props));
    m.set(`${colour}_shulker_box`, (props) => shulkerModel(colour, props));
  }

  m.set('shulker_box', (props) => shulkerModel(null, props));
}

/** Un-namespaced block name -> the builder that synthesises its geometry. */
const BER_BUILDERS: Map<string, BerBuilder> = (() => {
  const m = new Map<string, BerBuilder>();
  registerNamedBlocks(m);
  registerFamilies(m);
  return m;
})();

/**
 * Synthesise geometry for a block whose vanilla model JSON is particle-only.
 * Returns a parent-less RawModel ready for bakeModel(model, { model: '' }), or null if
 * this module does not handle the block.
 */
export function berModel(blockName: string, props: Record<string, string>): RawModel | null {
  const name = blockName.startsWith('minecraft:') ? blockName.slice(10) : blockName;
  if (blockName.includes(':') && !blockName.startsWith('minecraft:')) return null;
  return BER_BUILDERS.get(name)?.(props) ?? null;
}

/**
 * Orientation is baked into the returned geometry (see the header note on why we cannot
 * use the Variant rotation), so this is always the identity. It exists so a caller can
 * do `bakeModel(berModel(n, p), { model: '', ...berVariantRotation(n, p) })` unchanged if
 * this module ever switches to the canonical-plus-rotation approach.
 */
export function berVariantRotation(
  _blockName: string,
  _props: Record<string, string>,
): { x?: number; y?: number } {
  return {};
}

/**
 * Every block name berModel() can produce geometry for. Read off the dispatch table so
 * the two cannot drift apart: a block in this set that berModel does not handle would
 * be counted as synthesised by the audit and then render as nothing.
 */
export const BER_BLOCKS: Set<string> = new Set(
  [...BER_BUILDERS.keys()].map((name) => `minecraft:${name}`),
);
