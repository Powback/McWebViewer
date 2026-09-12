/**
 * Block model resolution and baking: blockstate JSON -> model JSON -> quads.
 *
 * Follows vanilla's pipeline (BlockModelDefinition -> UnbakedModel -> FaceBakery).
 * The vertex/UV corner tables below are transcribed from vanilla's `FaceInfo`, and the
 * default-UV rules from `BlockElement.uvsByFace`. Getting these exactly right is what
 * makes stairs, fences and rotated models line up instead of looking subtly wrong.
 */

import { readJson, modelPath, type Pack } from './pack.js';

export const DIRECTIONS = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIR_VEC: Record<Direction, [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

export const OPPOSITE: Record<Direction, Direction> = {
  down: 'up',
  up: 'down',
  north: 'south',
  south: 'north',
  west: 'east',
  east: 'west',
};

// ---------------------------------------------------------------------------
// Raw JSON shapes

export interface RawFace {
  uv?: [number, number, number, number];
  texture: string;
  cullface?: Direction | '';
  rotation?: number;
  tintindex?: number;
}
export interface RawElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: {
    origin: [number, number, number];
    axis: 'x' | 'y' | 'z';
    angle: number;
    rescale?: boolean;
  };
  shade?: boolean;
  faces: Partial<Record<Direction, RawFace>>;
}
export interface RawModel {
  parent?: string;
  ambientocclusion?: boolean;
  textures?: Record<string, string>;
  elements?: RawElement[];
  loader?: string;
  render_type?: string;
  gui_light?: string;
}

export interface Variant {
  model: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
  weight?: number;
}
export type MultipartCondition =
  | { OR: MultipartCondition[] }
  | { AND: MultipartCondition[] }
  | Record<string, string | boolean | number>;
export interface RawBlockstate {
  variants?: Record<string, Variant | Variant[]>;
  multipart?: Array<{ when?: MultipartCondition; apply: Variant | Variant[] }>;
}

// ---------------------------------------------------------------------------
// Baked output

export interface BakedQuad {
  /** 4 vertices * 3 floats, in block space 0..1 (may exceed for oversized elements) */
  positions: Float32Array;
  /** 4 vertices * 2 floats, in sprite-local 0..1 (atlas mapping applied later) */
  uvs: Float32Array;
  /** sprite id, e.g. "minecraft:block/stone" */
  texture: string;
  /** face this quad can be culled against, if any */
  cullface: Direction | null;
  /** the geometric facing, used for lighting/AO and for greedy-merge grouping */
  facing: Direction;
  tintIndex: number;
  /**
   * A literal multiply colour baked into the quad, for geometry whose colour comes from
   * entity data rather than from a biome: a sheep's wool takes its RGB from the `Color`
   * byte, which no `tintIndex` can express. Absent on every block quad.
   */
  tint?: readonly [number, number, number];
  shade: boolean;
  normal: [number, number, number];
}

export interface BakedModel {
  quads: BakedQuad[];
  ambientOcclusion: boolean;
  /** true when the model contains an unrotated 0..16 cube element with all six faces */
  fullCube: boolean;
  /**
   * The six resolved sprite ids of that cube element. Occlusion depends on whether
   * THOSE textures are opaque — not on the model's render layer — so the caller needs
   * them rather than just the boolean.
   */
  fullCubeTextures?: string[];
  renderType: RenderType;
}

export type RenderType = 'solid' | 'cutout' | 'cutout_mipped' | 'translucent';

// ---------------------------------------------------------------------------
// FaceInfo: per-face corner selection into shape = [minX,minY,minZ,maxX,maxY,maxZ]
// Corner order matches UV order (u1,v1),(u1,v2),(u2,v2),(u2,v1).

const MIN_X = 0, MIN_Y = 1, MIN_Z = 2, MAX_X = 3, MAX_Y = 4, MAX_Z = 5;

const FACE_CORNERS: Record<Direction, number[][]> = {
  down: [
    [MAX_X, MIN_Y, MAX_Z], [MAX_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MAX_Z],
  ],
  up: [
    [MIN_X, MAX_Y, MAX_Z], [MIN_X, MAX_Y, MIN_Z], [MAX_X, MAX_Y, MIN_Z], [MAX_X, MAX_Y, MAX_Z],
  ],
  north: [
    [MAX_X, MAX_Y, MIN_Z], [MAX_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MIN_Z], [MIN_X, MAX_Y, MIN_Z],
  ],
  south: [
    [MIN_X, MAX_Y, MAX_Z], [MIN_X, MIN_Y, MAX_Z], [MAX_X, MIN_Y, MAX_Z], [MAX_X, MAX_Y, MAX_Z],
  ],
  west: [
    [MIN_X, MAX_Y, MIN_Z], [MIN_X, MIN_Y, MIN_Z], [MIN_X, MIN_Y, MAX_Z], [MIN_X, MAX_Y, MAX_Z],
  ],
  east: [
    [MAX_X, MAX_Y, MAX_Z], [MAX_X, MIN_Y, MAX_Z], [MAX_X, MIN_Y, MIN_Z], [MAX_X, MAX_Y, MIN_Z],
  ],
};

/** vanilla BlockElement.uvsByFace */
function defaultUv(
  face: Direction,
  f: [number, number, number],
  t: [number, number, number],
): [number, number, number, number] {
  switch (face) {
    case 'down':
      return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'up':
      return [f[0], f[2], t[0], t[2]];
    case 'north':
      return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south':
      return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west':
      return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'east':
      return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
  }
}

// ---------------------------------------------------------------------------
// Model loading with parent resolution

/** The fields a parent chain accumulates while it is walked child-first. */
interface ChainFields {
  textures: Record<string, string>;
  elements?: RawElement[];
  ao?: boolean;
  renderType?: string;
  loader?: string;
}

/** Parent values fill in only where the child did not define them. */
function inheritInto(acc: ChainFields, m: RawModel): void {
  if (m.textures) acc.textures = { ...m.textures, ...acc.textures };
  if (acc.elements === undefined && m.elements) acc.elements = m.elements;
  inheritOptionsInto(acc, m);
}

/** The scalar, non-geometry fields of the same child-first merge. */
function inheritOptionsInto(acc: ChainFields, m: RawModel): void {
  if (acc.ao === undefined && m.ambientocclusion !== undefined) acc.ao = m.ambientocclusion;
  if (acc.renderType === undefined && m.render_type) acc.renderType = m.render_type;
  if (acc.loader === undefined && m.loader) acc.loader = m.loader;
}

export class ModelLoader {
  private cache = new Map<string, RawModel | null>();
  /** models we could not load, for the coverage audit */
  readonly missing = new Set<string>();

  constructor(private pack: Pack) {}

  raw(id: string): RawModel | null {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const m = readJson<RawModel>(this.pack, modelPath(id)) ?? null;
    if (!m) this.missing.add(id);
    this.cache.set(id, m);
    return m;
  }

  /**
   * Flatten a model's parent chain.
   * Vanilla semantics: textures merge child-over-parent; `elements` do NOT merge —
   * the nearest definition in the chain wins outright.
   */
  resolve(id: string): { model: RawModel; chain: string[] } | null {
    const chain: string[] = [];
    const acc: ChainFields = { textures: {} };

    let cur: string | undefined = id;
    let guard = 0;
    while (cur) {
      if (guard++ > 32) throw new Error(`Model parent chain too deep / cyclic at ${id}`);
      if (chain.includes(cur)) break; // cycle guard
      const m = this.raw(cur);
      if (!m) {
        if (chain.length === 0) return null;
        break;
      }
      chain.push(cur);
      inheritInto(acc, m);
      cur = m.parent;
    }
    return {
      model: {
        textures: acc.textures,
        elements: acc.elements,
        ambientocclusion: acc.ao,
        render_type: acc.renderType,
        loader: acc.loader,
      },
      chain,
    };
  }

  /** Resolve a `#var` reference through the texture map. */
  static resolveTexture(textures: Record<string, string>, ref: string): string | null {
    let v = ref;
    for (let i = 0; i < 16; i++) {
      if (!v.startsWith('#')) return v;
      const next = textures[v.slice(1)];
      if (next === undefined) return null;
      v = next;
    }
    return null;
  }

  bake(id: string, variant: Variant): BakedModel | null {
    const resolved = this.resolve(id);
    if (!resolved) return null;
    return bakeModel(resolved.model, variant);
  }
}

// ---------------------------------------------------------------------------
// Baking

const DEG = Math.PI / 180;

/** The variant-level rotation that applies to every face of the model. */
interface VariantRotation {
  rotX: number;
  rotY: number;
  uvlock: boolean;
}

/** Everything one face needs to become a quad. */
interface FaceBake {
  el: RawElement;
  dir: Direction;
  face: RawFace;
  tex: string;
  /** [minX,minY,minZ,maxX,maxY,maxZ] in block space */
  shape: number[];
  rot: VariantRotation;
}

export function bakeModel(model: RawModel, variant: Variant): BakedModel {
  const quads: BakedQuad[] = [];
  const textures = model.textures ?? {};
  const rot: VariantRotation = {
    rotX: ((variant.x ?? 0) % 360 + 360) % 360,
    rotY: ((variant.y ?? 0) % 360 + 360) % 360,
    uvlock: variant.uvlock ?? false,
  };

  for (const el of model.elements ?? []) {
    bakeElement(el, textures, rot, quads);
  }

  const cubeTextures = fullCubeTexturesOf(model);
  return {
    quads,
    ambientOcclusion: model.ambientocclusion ?? true,
    fullCube: cubeTextures !== null,
    fullCubeTextures: cubeTextures ?? undefined,
    renderType: normalizeRenderType(model.render_type),
  };
}

/** Append one element's six possible faces to `quads`, skipping absent/unresolvable ones. */
function bakeElement(
  el: RawElement,
  textures: Record<string, string>,
  rot: VariantRotation,
  quads: BakedQuad[],
): void {
  const from = el.from;
  const to = el.to;
  const shape = [
    from[0] / 16, from[1] / 16, from[2] / 16,
    to[0] / 16, to[1] / 16, to[2] / 16,
  ];

  for (const dir of DIRECTIONS) {
    const face = el.faces[dir];
    if (!face) continue;
    const tex = ModelLoader.resolveTexture(textures, face.texture);
    if (!tex) continue;
    quads.push(bakeFace({ el, dir, face, tex, shape, rot }));
  }
}

function bakeFace({ el, dir, face, tex, shape, rot }: FaceBake): BakedQuad {
  const uv = face.uv ?? defaultUv(dir, el.from, el.to);
  const faceRot = ((face.rotation ?? 0) % 360 + 360) % 360;
  const shift = faceRot / 90;

  const positions = new Float32Array(12);
  const uvs = new Float32Array(8);
  fillCorners(positions, dir, shape);
  fillUvs(uvs, uv, shift);

  // Element-local rotation (the {origin,axis,angle,rescale} block).
  if (el.rotation) applyElementRotation(positions, el.rotation);

  let facing: Direction = dir;
  let cullface: Direction | null = faceCullface(face);

  // Variant-level whole-model rotation, x then y, about the block centre.
  if (rot.rotX || rot.rotY) {
    ({ facing, cullface } = applyVariantRotation(positions, uvs, dir, cullface, rot));
  }

  const normal = faceNormal(positions);
  return {
    positions,
    uvs,
    texture: tex,
    cullface,
    facing,
    tintIndex: face.tintindex ?? -1,
    shade: el.shade ?? true,
    normal,
  };
}

/** An absent or empty `cullface` both mean "never culled". */
function faceCullface(face: RawFace): Direction | null {
  return face.cullface === '' || face.cullface === undefined ? null : face.cullface;
}

/** The four FaceInfo corners of `dir`, read out of the element's shape box. */
function fillCorners(positions: Float32Array, dir: Direction, shape: number[]): void {
  const corners = FACE_CORNERS[dir];
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    positions[i * 3] = shape[c[0]];
    positions[i * 3 + 1] = shape[c[1]];
    positions[i * 3 + 2] = shape[c[2]];
  }
}

/** vanilla BlockFaceUV.getU/getV with rotation shift */
function fillUvs(
  uvs: Float32Array,
  uv: [number, number, number, number],
  shift: number,
): void {
  for (let i = 0; i < 4; i++) {
    const j = (i + shift) & 3;
    uvs[i * 2] = (j === 0 || j === 1 ? uv[0] : uv[2]) / 16;
    uvs[i * 2 + 1] = (j === 0 || j === 3 ? uv[1] : uv[3]) / 16;
  }
}

/** Rotate a face's geometry, facing, cullface and (under uvlock) its UVs by the variant. */
function applyVariantRotation(
  positions: Float32Array,
  uvs: Float32Array,
  dir: Direction,
  cullface: Direction | null,
  rot: VariantRotation,
): { facing: Direction; cullface: Direction | null } {
  rotateAroundCentre(positions, rot.rotX, rot.rotY);
  const facing = rotateDirection(rotateDirection(dir, 'x', rot.rotX), 'y', rot.rotY);
  let culled = cullface;
  if (culled) culled = rotateDirection(rotateDirection(culled, 'x', rot.rotX), 'y', rot.rotY);
  if (rot.uvlock) applyUvLock(uvs, facing, rot.rotX, rot.rotY);
  return { facing, cullface: culled };
}

function normalizeRenderType(rt: string | undefined): RenderType {
  if (!rt) return 'solid';
  const p = rt.includes(':') ? rt.slice(rt.indexOf(':') + 1) : rt;
  if (p === 'cutout' || p === 'cutout_mipped' || p === 'translucent') return p;
  if (p === 'cutout_mipped_all') return 'cutout_mipped';
  if (p === 'tripwire') return 'cutout';
  return 'solid';
}

/** True when an element is an unrotated 0..16 cube carrying all six faces. */
function isCubeElement(e: RawElement): boolean {
  if (e.rotation) return false;
  for (let i = 0; i < 3; i++) {
    if (e.from[i] !== 0 || e.to[i] !== 16) return false;
  }
  for (const d of DIRECTIONS) if (!e.faces[d]) return false;
  return true;
}

/**
 * Find the element that makes this model a full cube, and resolve its six sprite ids.
 *
 * Requiring the model to have exactly ONE element was wrong: grass_block, and every
 * modded block with a decorative overlay element, is a full cube PLUS extra geometry,
 * and treating those as non-occluding leaves the world's hidden faces in the mesh
 * (measured: 1.85M -> 1.17M triangles once fixed).
 */
function fullCubeTexturesOf(model: RawModel): string[] | null {
  const els = model.elements;
  if (!els || els.length === 0) return null;
  const textures = model.textures ?? {};
  for (const e of els) {
    if (!isCubeElement(e)) continue;
    const ids: string[] = [];
    for (const d of DIRECTIONS) {
      const tex = ModelLoader.resolveTexture(textures, e.faces[d]!.texture);
      if (!tex) return null;
      ids.push(tex);
    }
    return ids;
  }
  return null;
}

function applyElementRotation(
  pos: Float32Array,
  r: NonNullable<RawElement['rotation']>,
): void {
  const ox = r.origin[0] / 16;
  const oy = r.origin[1] / 16;
  const oz = r.origin[2] / 16;
  const a = r.angle * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // `rescale` scales the rotated plane so the element still fills its slot; vanilla
  // uses 1/cos(45deg) for +-45 and 1/cos(22.5deg) for +-22.5.
  let scale = 1;
  if (r.rescale) scale = 1 / Math.cos(a);
  for (let i = 0; i < 4; i++) {
    const x = pos[i * 3] - ox;
    const y = pos[i * 3 + 1] - oy;
    const z = pos[i * 3 + 2] - oz;
    let nx = x, ny = y, nz = z;
    if (r.axis === 'x') {
      ny = y * c - z * s;
      nz = y * s + z * c;
      ny *= scale;
      nz *= scale;
    } else if (r.axis === 'y') {
      nx = x * c + z * s;
      nz = -x * s + z * c;
      nx *= scale;
      nz *= scale;
    } else {
      nx = x * c - y * s;
      ny = x * s + y * c;
      nx *= scale;
      ny *= scale;
    }
    pos[i * 3] = nx + ox;
    pos[i * 3 + 1] = ny + oy;
    pos[i * 3 + 2] = nz + oz;
  }
}

/** Rotate positions about the block centre (0.5,0.5,0.5): x first, then y. */
function rotateAroundCentre(pos: Float32Array, rotX: number, rotY: number): void {
  const steps = (deg: number) => (deg / 90) & 3;
  const sx = steps(rotX);
  const sy = steps(rotY);
  for (let i = 0; i < 4; i++) {
    let x = pos[i * 3] - 0.5;
    let y = pos[i * 3 + 1] - 0.5;
    let z = pos[i * 3 + 2] - 0.5;
    for (let k = 0; k < sx; k++) {
      // rotate -90deg about X, matching vanilla's clockwise-when-viewed-from-+X sense
      const ny = z;
      const nz = -y;
      y = ny;
      z = nz;
    }
    for (let k = 0; k < sy; k++) {
      // Vanilla BlockModelRotation rotates by MINUS y degrees about +Y, so y=90 carries
      // +Z to -X. Getting this backwards mirrors every asymmetric block that uses a
      // variant `y` (furnaces, ladders, stairs, chests) AND points its cullfaces at the
      // wrong neighbour, while leaving symmetric terrain looking perfect. See
      // model.test.ts, which pins positions and face directions to agree.
      const nx = -z;
      const nz = x;
      x = nx;
      z = nz;
    }
    pos[i * 3] = x + 0.5;
    pos[i * 3 + 1] = y + 0.5;
    pos[i * 3 + 2] = z + 0.5;
  }
}

const X_ROT: Record<Direction, Direction> = {
  north: 'down', down: 'south', south: 'up', up: 'north', east: 'east', west: 'west',
};
const Y_ROT: Record<Direction, Direction> = {
  north: 'east', east: 'south', south: 'west', west: 'north', up: 'up', down: 'down',
};

export function rotateDirection(d: Direction, axis: 'x' | 'y', deg: number): Direction {
  const steps = ((deg / 90) & 3);
  let r = d;
  const table = axis === 'x' ? X_ROT : Y_ROT;
  for (let i = 0; i < steps; i++) r = table[r];
  return r;
}

/**
 * uvlock keeps the texture aligned to world axes when a variant rotates the model —
 * used by stairs/fences so the top texture does not spin. We counter-rotate the UVs
 * by the amount the face's own plane was rotated.
 */
function applyUvLock(uvs: Float32Array, facing: Direction, rotX: number, rotY: number): void {
  let deg = 0;
  if (facing === 'up') deg = -rotY;
  else if (facing === 'down') deg = rotY;
  else if (rotX !== 0) deg = facing === 'north' || facing === 'south' ? -rotX : rotX;
  const steps = (((deg / 90) % 4) + 4) % 4;
  if (!steps) return;
  const tmp = new Float32Array(uvs);
  for (let i = 0; i < 4; i++) {
    const src = (i + steps) & 3;
    uvs[i * 2] = tmp[src * 2];
    uvs[i * 2 + 1] = tmp[src * 2 + 1];
  }
}

function faceNormal(pos: Float32Array): [number, number, number] {
  const ax = pos[3] - pos[0], ay = pos[4] - pos[1], az = pos[5] - pos[2];
  const bx = pos[6] - pos[3], by = pos[7] - pos[4], bz = pos[8] - pos[5];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  // The FaceInfo corner order winds so that the raw cross product points inward;
  // negate for an outward normal. (MeshBasicMaterial ignores normals, but the mesher
  // exports them and a lit material would need them correct.)
  return [-nx / len, -ny / len, -nz / len];
}

// ---------------------------------------------------------------------------
// Blockstate -> variant selection

export function parsePropsKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!key) return out;
  for (const part of key.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function propsMatch(want: Record<string, string>, have: Record<string, string>): boolean {
  for (const k in want) if (have[k] !== want[k]) return false;
  return true;
}

export function evalCondition(
  cond: MultipartCondition,
  props: Record<string, string>,
): boolean {
  if ('OR' in cond && Array.isArray((cond as { OR: MultipartCondition[] }).OR)) {
    return (cond as { OR: MultipartCondition[] }).OR.some((c) => evalCondition(c, props));
  }
  if ('AND' in cond && Array.isArray((cond as { AND: MultipartCondition[] }).AND)) {
    return (cond as { AND: MultipartCondition[] }).AND.every((c) => evalCondition(c, props));
  }
  for (const k in cond) {
    const expected = String((cond as Record<string, unknown>)[k]);
    const actual = props[k];
    if (actual === undefined) return false;
    // `|` separates alternatives, e.g. "north|east"
    if (!expected.split('|').includes(actual)) return false;
  }
  return true;
}

/**
 * Pick the variants to render for a block state. Returns every variant that applies
 * (multipart can return several); random-weighted lists are resolved deterministically
 * from a position hash so a chunk re-mesh is stable.
 */
export function selectVariants(
  bs: RawBlockstate,
  props: Record<string, string>,
  randomSeed = 0,
): Variant[] {
  const out: Variant[] = [];
  if (bs.variants) {
    const chosen = matchVariantKey(bs.variants, props);
    if (chosen) out.push(pickWeighted(chosen, randomSeed));
  }
  if (bs.multipart) {
    for (const part of bs.multipart) {
      if (!part.when || evalCondition(part.when, props)) {
        out.push(pickWeighted(part.apply, randomSeed));
      }
    }
  }
  return out;
}

/** The `variants` entry whose property key the state satisfies, or the `""` catch-all. */
function matchVariantKey(
  variants: Record<string, Variant | Variant[]>,
  props: Record<string, string>,
): Variant | Variant[] | undefined {
  let chosen: Variant | Variant[] | undefined;
  // Exact key match first (cheapest and what vanilla files normally use).
  for (const key in variants) {
    if (propsMatch(parsePropsKey(key), props)) {
      chosen = variants[key];
      break;
    }
  }
  if (chosen === undefined && variants['']) chosen = variants[''];
  return chosen;
}

function pickWeighted(v: Variant | Variant[], seed: number): Variant {
  if (!Array.isArray(v)) return v;
  if (v.length === 1) return v[0];
  let total = 0;
  for (const c of v) total += c.weight ?? 1;
  // xorshift the seed so neighbouring blocks do not correlate
  let h = seed ^ 0x9e3779b9;
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17;
  h ^= h << 5; h >>>= 0;
  let r = (h % (total * 1000)) / 1000;
  for (const c of v) {
    r -= c.weight ?? 1;
    if (r < 0) return c;
  }
  return v[v.length - 1];
}
