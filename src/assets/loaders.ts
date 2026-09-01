/**
 * Custom model loaders.
 *
 * A NeoForge/mod model JSON may carry a top-level `"loader"`. When it does, the vanilla
 * `elements` array is NOT the geometry — it is either absent, or a placeholder, or (for
 * `neoforge:composite`) only a fragment. Baking it as if it were vanilla silently drops
 * or corrupts the block, which across the 128 mod jars of the reference pack is ~8400
 * models:
 *
 *   fusion:model                        6254   (rechiseled connected textures)
 *   neoforge:obj                        1848   (all of Create's non-cubic geometry)
 *   domum_ornamentum:materially_textured 208
 *   neoforge:composite                    36
 *   automobility:slope                     9
 *   computercraft:turtle                   2
 *   + 7 one-offs
 *
 * `ModelLoader.resolve()` deliberately keeps only the vanilla fields, so the loader-
 * specific keys (`model`, `children`, `visibility`, `flip_v`, ...) are not on the resolved
 * model. We recover them by re-reading the raw JSON of the chain entry that declared the
 * loader — resolve() hands back `chain` for exactly this kind of second look.
 */

import {
  bakeModel,
  DIR_VEC,
  DIRECTIONS,
  ModelLoader,
  rotateDirection,
  type BakedModel,
  type BakedQuad,
  type Direction,
  type RawElement,
  type RawModel,
  type Variant,
} from './model.js';
import { parseId, readJson, texturePath, type Pack } from './pack.js';

// ---------------------------------------------------------------------------
// Registry

export interface LoaderContext {
  pack: Pack;
  models: ModelLoader;
  /** parent chain from ModelLoader.resolve(), child first */
  chain: string[];
  /** the flattened vanilla view: merged textures, nearest `elements`, render_type, ... */
  resolved: RawModel;
  variant: Variant;
}

/** The raw JSON of the chain entry that declared `loader`, with its unknown extra keys. */
type LoaderJson = RawModel & Record<string, unknown>;

export type CustomLoader = (json: LoaderJson, ctx: LoaderContext) => BakedModel | null;

/**
 * Loaders we know how to bake. Anything not in here falls back to the vanilla `elements`
 * path in the registry and is recorded below so the coverage audit can count it, rather
 * than disappearing into a "rendered as asset" bucket it does not belong in.
 */
export const LOADERS: Record<string, CustomLoader> = {
  'neoforge:obj': bakeObj,
  'neoforge:composite': bakeComposite,
  'computercraft:turtle': bakeTurtle,
  'fusion:model': bakeFusion,
  'domum_ornamentum:materially_textured': bakeMateriallyTextured,
};

/** Loader ids encountered at runtime that `LOADERS` has no implementation for. */
export const UNHANDLED_LOADERS = new Set<string>();
/** How many bake attempts each unhandled loader id swallowed — for the audit report. */
export const UNHANDLED_LOADER_COUNTS = new Map<string, number>();

/**
 * Bake a model whose resolved form declares a custom loader.
 * Returns null when the loader is unknown or its own inputs are missing, in which case
 * the caller should fall back to the vanilla element bake (better a wrong-but-present
 * cube than a hole).
 */
export function bakeWithLoader(loader: string, ctx: LoaderContext): BakedModel | null {
  const impl = LOADERS[loader];
  if (!impl) {
    UNHANDLED_LOADERS.add(loader);
    UNHANDLED_LOADER_COUNTS.set(loader, (UNHANDLED_LOADER_COUNTS.get(loader) ?? 0) + 1);
    return null;
  }
  const json = loaderJson(ctx, loader);
  if (!json) return null;
  try {
    return impl(json, ctx);
  } catch {
    // A single malformed .obj/.mtl must not take down the whole chunk bake.
    return null;
  }
}

/** The nearest model in the parent chain that actually declared this loader. */
function loaderJson(ctx: LoaderContext, loader: string): LoaderJson | null {
  for (const id of ctx.chain) {
    const raw = ctx.models.raw(id) as LoaderJson | null;
    if (raw && raw.loader === loader) return raw;
  }
  return null;
}

function baseModel(ctx: LoaderContext, quads: BakedQuad[], fullCube: boolean): BakedModel {
  return {
    quads,
    ambientOcclusion: ctx.resolved.ambientocclusion ?? true,
    fullCube,
    // model.ts keeps its render_type normalisation private; baking an empty model is the
    // cheapest way to borrow it rather than keeping a second copy of the table in sync.
    renderType: bakeModel({ render_type: ctx.resolved.render_type }, ctx.variant).renderType,
  };
}

// ---------------------------------------------------------------------------
// neoforge:obj
//
// Shape (verified against create-1.21.1-6.0.10.jar):
//   { "parent": "block/block", "loader": "neoforge:obj", "flip_v": true,
//     "model": "create:models/block/crushing_wheel/crushing_wheel.obj" }
// with the textures coming from the parent chain, e.g.
//   create:block/crushing_wheel/textures -> { "insert": "create:block/crushing_wheel_insert", ... }
//
// The .obj names materials (`usemtl crushing_wheel_insert`); the sibling .mtl maps those to
// `map_Kd #insert`, and the `#ref` resolves through the model's merged texture map. So the
// .mtl is load-bearing here — it is the only thing connecting a material name to a texture
// key — but the JSON `textures` map always has the final say on what the ref points at.

interface ObjFace {
  /** vertex indices into `positions`, already 0-based and de-negated */
  v: number[];
  vt: number[];
  vn: number[];
  material: string | null;
  group: string | null;
}

interface ObjMesh {
  positions: number[];
  texCoords: number[];
  normals: number[];
  faces: ObjFace[];
  mtllib: string | null;
}

/** `assets/<ns>/<path>` — obj/mtl references already carry their own `models/...` prefix. */
function assetPath(id: string): string {
  const r = parseId(id);
  return `assets/${r.namespace}/${r.path}`;
}

const decoder = new TextDecoder();

/** The `usemtl` / `o`,`g` state that later `f` lines inherit. */
interface ObjParseState {
  material: string | null;
  group: string | null;
}

export function parseObj(text: string): ObjMesh {
  const mesh: ObjMesh = {
    positions: [], texCoords: [], normals: [], faces: [], mtllib: null,
  };
  const state: ObjParseState = { material: null, group: null };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();

    parseObjLine(mesh, state, key, rest);
  }
  return mesh;
}

function parseObjLine(
  mesh: ObjMesh,
  state: ObjParseState,
  key: string,
  rest: string,
): void {
  switch (key) {
    case 'v': {
      const p = rest.split(/\s+/);
      mesh.positions.push(+p[0], +p[1], +p[2]);
      break;
    }
    case 'vt': {
      const p = rest.split(/\s+/);
      mesh.texCoords.push(+p[0], +(p[1] ?? 0));
      break;
    }
    case 'vn': {
      const p = rest.split(/\s+/);
      mesh.normals.push(+p[0], +p[1], +p[2]);
      break;
    }
    case 'f':
      parseObjFace(mesh, rest, state);
      break;
    case 'usemtl':
      state.material = rest;
      break;
    case 'o':
    case 'g':
      state.group = rest;
      break;
    case 'mtllib':
      mesh.mtllib = rest;
      break;
    default:
      break;
  }
}

/** `f v/vt/vn v/vt/vn ...` — a face referencing vertices declared so far. */
function parseObjFace(mesh: ObjMesh, rest: string, state: ObjParseState): void {
  const verts = rest.split(/\s+/);
  const v: number[] = [];
  const vt: number[] = [];
  const vn: number[] = [];
  for (const token of verts) {
    const parts = token.split('/');
    // OBJ indices are 1-based; negative indices count back from the current end,
    // which Blender emits for large multi-object exports.
    v.push(objIndex(parts[0], mesh.positions.length / 3));
    vt.push(parts[1] ? objIndex(parts[1], mesh.texCoords.length / 2) : -1);
    vn.push(parts[2] ? objIndex(parts[2], mesh.normals.length / 3) : -1);
  }
  if (v.length >= 3) {
    mesh.faces.push({ v, vt, vn, material: state.material, group: state.group });
  }
}

function objIndex(token: string, count: number): number {
  const n = parseInt(token, 10);
  if (Number.isNaN(n)) return -1;
  return n < 0 ? count + n : n - 1;
}

/** `newmtl <name>` / `map_Kd <path-or-#ref>`. Options (`-s`, `-o`, ...) precede the path. */
export function parseMtl(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();
    if (key === 'newmtl') cur = rest;
    else if ((key === 'map_Kd' || key === 'map_Ka') && cur) {
      const tokens = rest.split(/\s+/);
      out.set(cur, tokens[tokens.length - 1]);
    }
  }
  return out;
}

/** The per-model switches an obj bake reads once and then applies to every face. */
interface ObjBakeOptions {
  flipV: boolean;
  shade: boolean;
  detectCull: boolean;
  rotX: number;
  rotY: number;
}

function objBakeOptions(json: LoaderJson, variant: Variant): ObjBakeOptions {
  // All 1848 obj models in the reference pack set `flip_v` explicitly, and every one of
  // them sets it to true — the value below only matters for a model that omits it, where
  // we match NeoForge's ObjLoader default of false.
  const flipV = json.flip_v === true;
  const shade = json.shade_quads !== false;
  // NeoForge's `detectCullableFaces` (default on): a face lying flat on a block boundary
  // and facing outwards gets that boundary as its cullface, which is what stops obj blocks
  // from drawing their backplate against a solid neighbour.
  const detectCull =
    json.detectCullableFaces !== false && json.detect_cullable_faces !== false &&
    json.automatic_culling !== false;

  return { flipV, shade, detectCull, rotX: normDeg(variant.x), rotY: normDeg(variant.y) };
}

function bakeObj(json: LoaderJson, ctx: LoaderContext): BakedModel | null {
  const modelRef = typeof json.model === 'string' ? json.model : null;
  if (!modelRef) return null;
  const objPath = assetPath(modelRef);
  const objRaw = ctx.pack.get(objPath);
  if (!objRaw) return null;
  const mesh = parseObj(decoder.decode(objRaw));

  const opts = objBakeOptions(json, ctx.variant);

  const textures = ctx.resolved.textures ?? {};
  const materials = loadMaterials(ctx, objPath, mesh.mtllib);
  const visibility = asBoolMap(json.groups) ?? asBoolMap(json.visibility);

  const quads: BakedQuad[] = [];

  for (const face of mesh.faces) {
    if (objGroupHidden(face, visibility)) continue;
    const tex = resolveObjTexture(face.material, materials, textures);
    if (!tex) continue;
    emitObjFace(mesh, face, tex, opts, quads);
  }

  // An obj model is never a full cube for occlusion purposes: even when its bounding box
  // fills the block, it is a shell with holes (blaze burner cage, crushing wheel spokes).
  return baseModel(ctx, quads, false);
}

/** `groups` / `visibility` can switch an individual .obj object group off. */
function objGroupHidden(face: ObjFace, visibility: Record<string, boolean> | null): boolean {
  return !!(face.group && visibility && visibility[face.group] === false);
}

/**
 * Triangulate n-gons as a fan around vertex 0, then re-expand each triangle to the
 * 4-vertex quad BakedQuad requires by repeating the last vertex — a degenerate edge
 * that contributes no area, which is how NeoForge's own quad emitter handles tris.
 */
function emitObjFace(
  mesh: ObjMesh,
  face: ObjFace,
  tex: string,
  opts: ObjBakeOptions,
  quads: BakedQuad[],
): void {
  for (let i = 1; i + 1 < face.v.length; i += 2) {
    const idx = i + 2 < face.v.length ? [0, i, i + 1, i + 2] : [0, i, i + 1, i + 1];
    const positions = new Float32Array(12);
    const uvs = new Float32Array(8);
    fillObjQuad(mesh, face, idx, opts.flipV, { positions, uvs });

    const { facing, cullface, normal } = orientObjQuad(positions, mesh, face, idx, opts);

    quads.push({
      positions, uvs, texture: tex, cullface, facing, tintIndex: -1, shade: opts.shade, normal,
    });
  }
}

/** Copy one triangle-as-quad's four vertices and their UVs out of the mesh arrays. */
function fillObjQuad(
  mesh: ObjMesh,
  face: ObjFace,
  idx: number[],
  flipV: boolean,
  out: { positions: Float32Array; uvs: Float32Array },
): void {
  for (let k = 0; k < 4; k++) {
    const vi = face.v[idx[k]];
    out.positions[k * 3] = mesh.positions[vi * 3];
    out.positions[k * 3 + 1] = mesh.positions[vi * 3 + 1];
    out.positions[k * 3 + 2] = mesh.positions[vi * 3 + 2];
    const ti = face.vt[idx[k]];
    if (ti >= 0) {
      out.uvs[k * 2] = mesh.texCoords[ti * 2];
      // OBJ v runs bottom-up; sprite-local v runs top-down. flip_v is what reconciles
      // the two, which is why every Blender-exported Create model sets it.
      out.uvs[k * 2 + 1] = flipV
        ? 1 - mesh.texCoords[ti * 2 + 1]
        : mesh.texCoords[ti * 2 + 1];
    }
  }
}

/**
 * Rotate the quad into the variant's orientation (in place) and work out the normal,
 * facing and cullface that travel with it.
 */
function orientObjQuad(
  positions: Float32Array,
  mesh: ObjMesh,
  face: ObjFace,
  idx: number[],
  opts: ObjBakeOptions,
): { facing: Direction; cullface: Direction | null; normal: [number, number, number] } {
  let normal = objNormal(mesh, face, idx);
  if (opts.rotX || opts.rotY) {
    rotateAroundCentre(positions, opts.rotX, opts.rotY);
    normal = rotateVector(normal, opts.rotX, opts.rotY);
  }
  const facing = dominantDirection(normal);
  let cullface: Direction | null = opts.detectCull ? boundaryFace(positions, normal) : null;
  // The cullface travels with the geometry, so rotate it the same way the mesh moved.
  if (cullface && (opts.rotX || opts.rotY)) {
    cullface = rotateDirection(rotateDirection(cullface, 'x', opts.rotX), 'y', opts.rotY);
  }
  return { facing, cullface, normal };
}

function loadMaterials(
  ctx: LoaderContext,
  objPath: string,
  mtllib: string | null,
): Map<string, string> {
  if (!mtllib) return new Map();
  const dir = objPath.slice(0, objPath.lastIndexOf('/') + 1);
  // `mtllib` is a plain filename beside the .obj; a namespaced id is also legal.
  const path = mtllib.includes(':') ? assetPath(mtllib) : dir + mtllib;
  const raw = ctx.pack.get(path);
  return raw ? parseMtl(decoder.decode(raw)) : new Map();
}

/**
 * material name -> sprite id.
 * Preference order: the .mtl's `map_Kd` (usually a `#ref` into the JSON texture map),
 * then the material name used directly as a texture key, then the model's `"0"` /
 * `particle` fallbacks so a face with an unmapped material still draws something.
 */
function resolveObjTexture(
  material: string | null,
  materials: Map<string, string>,
  textures: Record<string, string>,
): string | null {
  const candidates: string[] = [];
  if (material) {
    const mapped = materials.get(material);
    if (mapped) candidates.push(mapped);
    candidates.push('#' + material);
    // Create names materials `m_<key>`; the texture key is the part after the prefix.
    if (material.startsWith('m_')) candidates.push('#' + material.slice(2));
  }
  candidates.push('#0', '#particle');
  for (const c of candidates) {
    const resolved = c.startsWith('#')
      ? ModelLoader.resolveTexture(textures, c)
      : normalizeSpriteId(c);
    if (resolved) return resolved;
  }
  return null;
}

/** `create:block/foo.png`, `assets/create/textures/block/foo.png` -> `create:block/foo`. */
function normalizeSpriteId(v: string): string {
  let s = v;
  if (s.endsWith('.png')) s = s.slice(0, -4);
  const m = /^assets\/([^/]+)\/textures\/(.+)$/.exec(s);
  if (m) return `${m[1]}:${m[2]}`;
  return s;
}

function objNormal(mesh: ObjMesh, face: ObjFace, idx: number[]): [number, number, number] {
  const ni = face.vn[idx[0]];
  if (ni >= 0 && mesh.normals.length > ni * 3 + 2) {
    const n: [number, number, number] = [
      mesh.normals[ni * 3], mesh.normals[ni * 3 + 1], mesh.normals[ni * 3 + 2],
    ];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 1e-6) return [n[0] / len, n[1] / len, n[2] / len];
  }
  const p = (k: number, c: number) => mesh.positions[face.v[idx[k]] * 3 + c];
  const ax = p(1, 0) - p(0, 0), ay = p(1, 1) - p(0, 1), az = p(1, 2) - p(0, 2);
  const bx = p(2, 0) - p(1, 0), by = p(2, 1) - p(1, 1), bz = p(2, 2) - p(1, 2);
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function dominantDirection(n: [number, number, number]): Direction {
  let best: Direction = 'up';
  let bestDot = -Infinity;
  for (const d of DIRECTIONS) {
    const v = DIR_VEC[d];
    const dot = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = d;
    }
  }
  return best;
}

const EPS = 1e-4;

/** A quad flat on a 0/1 block boundary and facing out of it can be culled against it. */
function boundaryFace(pos: Float32Array, n: [number, number, number]): Direction | null {
  for (let axis = 0; axis < 3; axis++) {
    const v = pos[axis];
    if (Math.abs(v) > EPS && Math.abs(v - 1) > EPS) continue;
    if (!flatOnAxis(pos, axis, v)) continue;
    const outward = v < 0.5 ? -1 : 1;
    if (n[axis] * outward < 0.5) continue;
    return boundaryDirection(axis, outward);
  }
  return null;
}

/** True when the quad's other three vertices share vertex 0's `axis` coordinate. */
function flatOnAxis(pos: Float32Array, axis: number, v: number): boolean {
  let flat = true;
  for (let i = 1; i < 4; i++) {
    if (Math.abs(pos[i * 3 + axis] - v) > EPS) { flat = false; break; }
  }
  return flat;
}

/** The block face an (axis, outward) boundary corresponds to. */
function boundaryDirection(axis: number, outward: number): Direction {
  if (axis === 0) return outward < 0 ? 'west' : 'east';
  if (axis === 1) return outward < 0 ? 'down' : 'up';
  return outward < 0 ? 'north' : 'south';
}

// model.ts keeps its rotation helpers private and this file may not modify it, so the two
// rotations obj geometry needs are reproduced here. They must stay in step with
// `rotateAroundCentre` in model.ts or obj blocks will face differently to vanilla ones.
function normDeg(deg: number | undefined): number {
  return (((deg ?? 0) % 360) + 360) % 360;
}

function rotateAroundCentre(pos: Float32Array, rotX: number, rotY: number): void {
  const sx = (rotX / 90) & 3;
  const sy = (rotY / 90) & 3;
  for (let i = 0; i < 4; i++) {
    let x = pos[i * 3] - 0.5;
    let y = pos[i * 3 + 1] - 0.5;
    let z = pos[i * 3 + 2] - 0.5;
    for (let k = 0; k < sx; k++) { const ny = z; z = -y; y = ny; }
    for (let k = 0; k < sy; k++) { const nx = z; z = -x; x = nx; }
    pos[i * 3] = x + 0.5;
    pos[i * 3 + 1] = y + 0.5;
    pos[i * 3 + 2] = z + 0.5;
  }
}

function rotateVector(
  n: [number, number, number],
  rotX: number,
  rotY: number,
): [number, number, number] {
  let [x, y, z] = n;
  for (let k = 0; k < ((rotX / 90) & 3); k++) { const ny = z; z = -y; y = ny; }
  for (let k = 0; k < ((rotY / 90) & 3); k++) { const nx = z; z = -x; x = nx; }
  return [x, y, z];
}

// ---------------------------------------------------------------------------
// neoforge:composite
//
// Shape (create:block/display_link/block): { "loader": "neoforge:composite",
//   "textures": { "particle": ... }, "children": { "base": { <model> }, ... },
//   "visibility": { "base": true } }
// Children are ordinary models — they may carry their own textures, elements, render_type
// and even a parent — so each one bakes through the normal path and the quads concatenate.

function bakeComposite(json: LoaderJson, ctx: LoaderContext): BakedModel | null {
  const children = json.children;
  if (!children || typeof children !== 'object') return null;
  const visibility = asBoolMap(json.visibility) ?? {};
  const parentTextures = ctx.resolved.textures ?? {};

  const acc = bakeCompositeChildren(
    children as Record<string, unknown>, visibility, ctx, parentTextures,
  );

  const model = bakeModel({ render_type: acc.renderType }, ctx.variant);
  return {
    quads: acc.quads,
    ambientOcclusion: acc.ao,
    fullCube: false,
    renderType: model.renderType,
  };
}

/** What the visible children between them contribute to the composite. */
interface CompositeAccum {
  quads: BakedQuad[];
  ao: boolean;
  renderType: string | undefined;
}

function bakeCompositeChildren(
  children: Record<string, unknown>,
  visibility: Record<string, boolean>,
  ctx: LoaderContext,
  parentTextures: Record<string, string>,
): CompositeAccum {
  const quads: BakedQuad[] = [];
  let ao = ctx.resolved.ambientocclusion ?? true;
  let renderType: string | undefined = ctx.resolved.render_type;

  for (const [name, rawChild] of Object.entries(children)) {
    if (visibility[name] === false) continue;
    const result = bakeCompositeChild(rawChild, ctx, parentTextures);
    if (!result) continue;

    quads.push(...result.baked.quads);
    ao = ao && result.baked.ambientOcclusion;
    // BakedModel carries one render layer but children may each declare their own; the
    // most transparent layer wins so nothing is drawn in a layer that would clip it.
    if (result.renderType && !renderType) renderType = result.renderType;
  }

  return { quads, ao, renderType };
}

interface CompositeChildBake {
  baked: BakedModel;
  /** the child's OWN declared `render_type`, if it had one */
  renderType: string | undefined;
}

function bakeCompositeChild(
  rawChild: unknown,
  ctx: LoaderContext,
  parentTextures: Record<string, string>,
): CompositeChildBake | null {
  if (!rawChild || typeof rawChild !== 'object') return null;
  const child = rawChild as RawModel;

  const geometry = compositeChildGeometry(child, ctx, parentTextures);
  if (!geometry) return null;

  const baked = bakeModel(
    {
      textures: geometry.textures,
      elements: geometry.elements,
      ambientocclusion: child.ambientocclusion ?? ctx.resolved.ambientocclusion,
      render_type: child.render_type ?? ctx.resolved.render_type,
    },
    ctx.variant,
  );
  return { baked, renderType: child.render_type };
}

/**
 * A child's own textures win over the composite's, exactly as child-over-parent; a child
 * with no elements of its own picks them (and its own parent's textures) off its parent.
 */
function compositeChildGeometry(
  child: RawModel,
  ctx: LoaderContext,
  parentTextures: Record<string, string>,
): { textures: Record<string, string>; elements: RawElement[] } | null {
  let textures = { ...parentTextures, ...(child.textures ?? {}) };
  let elements = child.elements;
  if (!elements && child.parent) {
    const inherited = ctx.models.resolve(child.parent);
    if (inherited) {
      elements = inherited.model.elements;
      textures = { ...(inherited.model.textures ?? {}), ...textures };
    }
  }
  if (!elements) return null;
  return { textures, elements };
}

// ---------------------------------------------------------------------------
// computercraft:turtle
//
// Shape (cc-tweaked, models/item/turtle_normal.json):
//   { "loader": "computercraft:turtle", "model": "computercraft:block/turtle_normal" }
// The loader exists to composite tool/peripheral upgrade overlays onto the base model at
// runtime from the turtle's NBT. In the reference world the 18 `computercraft:turtle_normal`
// instances resolve through `blockstates/turtle_normal.json`, which points straight at the
// plain `block/turtle_normal` model with no loader — so the block path never reaches here
// and the static, upgrade-free turtle is exactly right. Only the item models carry the
// loader (2 of them), and for those the base model is the whole answer.

function bakeTurtle(json: LoaderJson, ctx: LoaderContext): BakedModel | null {
  const quads: BakedQuad[] = [];
  let fullCube = false;

  // Ambient occlusion is not accumulated across the pieces here: `baseModel` below takes it
  // straight from the loader model's own `ambientocclusion`, which is what a turtle's base
  // model and its overlays all inherit anyway.
  const base = typeof json.model === 'string' ? ctx.models.bake(json.model, ctx.variant) : null;
  if (base) {
    quads.push(...base.quads);
    fullCube = base.fullCube;
  }
  // The model's own elements (if the loader model also declares geometry) still apply.
  if (ctx.resolved.elements?.length) {
    const own = bakeModel(ctx.resolved, ctx.variant);
    quads.push(...own.quads);
    fullCube = fullCube || own.fullCube;
  }
  // Static overlays a turtle may declare (colour/elf/rainbow skins). Upgrade overlays are
  // NBT-driven and cannot be resolved from assets alone, so they are deliberately absent.
  for (const overlay of asStringList(json.overlays)) {
    const baked = ctx.models.bake(overlay, ctx.variant);
    if (baked) quads.push(...baked.quads);
  }
  if (!quads.length) return null;
  return baseModel(ctx, quads, fullCube);
}

// ---------------------------------------------------------------------------
// fusion:model  (SuperMartijn642's Fusion, driving rechiseled / rechiseledcreate)
//
// Shape (rechiseled:block/acacia_planks_beams_connecting):
//   { "type": "fusion:connecting", "loader": "fusion:model", "parent": "minecraft:block/cube",
//     "connections": { <per-face predicate trees> },
//     "textures": { "up": "rechiseled:block/acacia_planks_beams", ... } }
//
// The geometry is plain vanilla — the parent supplies it. What is NOT plain is the texture:
// a Fusion sprite is a *sheet* of connection variants, declared by a `fusion` block in the
// texture's .mcmeta. Verified in rechiseled-1.2.5:
//     layout "pieced"     80x16   -> 5x1 tiles     (501 textures)
//     layout absent/full 128x128  -> 8x8 tiles     ( 85)
//     layout "simple"     64x64   -> 4x4 tiles     ( 77)
//     layout "horizontal" 64x16   -> 4x1 tiles     ( 36)
//     layout "vertical"   16x64   -> 1x4 tiles     (  8)
// while rechiseled's non-connecting textures are plain 16x16 with no .mcmeta at all.
//
// Choosing the right variant needs the neighbouring block states, which the mesher cannot
// supply (it bakes a state key in isolation, with no world context). FULL CONNECTED-TEXTURE
// SUPPORT THEREFORE NEEDS A NEIGHBOUR-AWARE BAKE and is out of scope here. The static
// fallback picks tile 0 — the fully-disconnected variant. That tile index is not a guess:
// decoding the sheets shows tile 0 is the only one with a distinct border on all four edges
// (e.g. acacia_planks_beams "pieced": tile 0 edge column means 118/87 against a uniform ~101
// interior for tile 1; same signature at tile 0 of the 8x8 "full" sheet and the 4x1
// "horizontal" sheet). Without this remap the whole 5-wide strip is squeezed onto every
// face and the block reads as a smear rather than a texture.

interface FusionMeta {
  fusion?: { type?: string; layout?: string };
}

/** Sheet grid per Fusion layout, in tiles. Tile 0 (top-left) is the disconnected variant. */
const FUSION_LAYOUTS: Record<string, [number, number]> = {
  full: [8, 8],
  pieced: [5, 1],
  simple: [4, 4],
  horizontal: [4, 1],
  vertical: [1, 4],
};

function bakeFusion(_json: LoaderJson, ctx: LoaderContext): BakedModel | null {
  const baked = bakeModel(ctx.resolved, ctx.variant);
  if (!baked.quads.length) return null;
  const grids = new Map<string, [number, number] | null>();

  for (const q of baked.quads) {
    let grid = grids.get(q.texture);
    if (grid === undefined) {
      grid = fusionGrid(ctx.pack, q.texture);
      grids.set(q.texture, grid);
    }
    if (!grid) continue;
    const [cols, rows] = grid;
    for (let i = 0; i < 4; i++) {
      q.uvs[i * 2] /= cols;
      q.uvs[i * 2 + 1] /= rows;
    }
  }
  // The geometry is genuinely a vanilla cube/slab/stairs, so keep bakeModel's fullCube
  // verdict — a rechiseled cube really does occlude its neighbours.
  return baked;
}

function fusionGrid(pack: Pack, sprite: string): [number, number] | null {
  const meta = readJson<FusionMeta>(pack, texturePath(sprite) + '.mcmeta');
  const fusion = meta?.fusion;
  if (!fusion) return null;
  return FUSION_LAYOUTS[fusion.layout ?? 'full'] ?? FUSION_LAYOUTS.full;
}

// ---------------------------------------------------------------------------
// domum_ornamentum:materially_textured
//
// Shape (domum_ornamentum:block/door/door_full_bottom_left):
//   { "parent": "domum_ornamentum:block/door/door_full_bottom_left_spec",
//     "loader": "domum_ornamentum:materially_textured" }
// The `_spec` parent is an ordinary model with full elements and a placeholder texture set
// (`"0": "block/oak_planks"`, `"1": "block/iron_block"`). In game the loader swaps those
// placeholders for the materials stored in the block entity's NBT, so the same door can be
// oak, brick or blackstone.
//
// NBT is not available to the mesher, so this bakes the spec as-is: right geometry, default
// material. A NEIGHBOUR-INDEPENDENT BUT BLOCK-ENTITY-DEPENDENT fix would mean threading the
// per-position BE data through the mesher, which the state-key cache is not shaped for.

function bakeMateriallyTextured(_json: LoaderJson, ctx: LoaderContext): BakedModel | null {
  const baked = bakeModel(ctx.resolved, ctx.variant);
  return baked.quads.length ? baked : null;
}

// ---------------------------------------------------------------------------

function asBoolMap(v: unknown): Record<string, boolean> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
