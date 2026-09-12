/**
 * The vertex format an Iris shaderpack expects, built from the mesher's output.
 *
 * SHADERPACKS.md §7 calls this out as the expensive half of shaderpack support for this
 * project, and it is: none of `mc_Entity`, `mc_midTexCoord`, `at_tangent` or `at_midBlock`
 * falls out of a face-culling mesher for free, and `mc_Entity.x` is a *pack-defined* id, so
 * the vertex data is coupled to whichever pack is loaded.
 *
 * Two of the four are derived here rather than in the mesher, because they are functions of
 * data it already emits:
 *
 *  - `mc_midTexCoord` is documented as the UV of the quad's texture centre, which is the
 *    mean of its four UVs.
 *  - `at_tangent` is the standard TBN tangent from the quad's positions and UVs, with the
 *    handedness of the bitangent in `.w`.
 *
 * One interleaved buffer rather than one per attribute: WebGPU's default
 * `maxVertexBuffers` is 8 and this format has 9 attributes.
 */

import { ATTRIBUTE_LOCATIONS } from './glsl-uplift.js';
import type { LayerBuffers } from '../render/mesher.js';

/** floats per vertex */
export const VERTEX_FLOATS = 30;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;

const OFFSETS = {
  vaPosition: 0,
  vaColor: 3,
  vaUV0: 7,
  vaUV2: 9,
  vaNormal: 11,
  mc_Entity: 14,
  mc_midTexCoord: 18,
  at_tangent: 22,
  at_midBlock: 26,
} as const;

const SIZES: Record<keyof typeof OFFSETS, number> = {
  vaPosition: 3, vaColor: 4, vaUV0: 2, vaUV2: 2, vaNormal: 3,
  mc_Entity: 4, mc_midTexCoord: 4, at_tangent: 4, at_midBlock: 4,
};

const FORMATS: Record<number, GPUVertexFormat> = {
  2: 'float32x2', 3: 'float32x3', 4: 'float32x4',
};

/** The layout is fixed and shared by every gbuffers/shadow pipeline. */
export function vertexBufferLayout(): GPUVertexBufferLayout {
  const attributes: GPUVertexAttribute[] = [];
  for (const [name, offset] of Object.entries(OFFSETS)) {
    const key = name as keyof typeof OFFSETS;
    attributes.push({
      shaderLocation: ATTRIBUTE_LOCATIONS[name],
      offset: offset * 4,
      format: FORMATS[SIZES[key]],
    });
  }
  return { arrayStride: VERTEX_STRIDE, stepMode: 'vertex', attributes };
}

/**
 * Tangent for one quad, from the first triangle's edge vectors in position and UV space.
 * A degenerate UV (a quad whose four corners share a coordinate, which happens on
 * generated block-entity geometry) has no defined tangent; falling back to a fixed axis
 * keeps normal mapping stable instead of producing NaNs that propagate into the gbuffer.
 */
function quadTangent(
  p: Float32Array,
  uv: Float32Array,
  base: number,
  /** where this quad's uvs start in `uv` -- 0 when the caller passed a decoded 8-float quad. */
  uvBase = base * 2,
): [number, number, number, number] {
  const i = base * 3;
  const j = uvBase;
  const e1 = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
  const e2 = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
  const du1 = uv[j + 2] - uv[j];
  const dv1 = uv[j + 3] - uv[j + 1];
  const du2 = uv[j + 4] - uv[j];
  const dv2 = uv[j + 5] - uv[j + 1];
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1];
  const r = 1 / det;
  const t: [number, number, number] = [
    (e1[0] * dv2 - e2[0] * dv1) * r,
    (e1[1] * dv2 - e2[1] * dv1) * r,
    (e1[2] * dv2 - e2[2] * dv1) * r,
  ];
  const len = Math.hypot(t[0], t[1], t[2]) || 1;
  return [t[0] / len, t[1] / len, t[2] / len, det < 0 ? -1 : 1];
}

function writeRange(out: Float32Array, at: number, values: readonly number[]): void {
  for (let k = 0; k < values.length; k++) out[at + k] = values[k];
}

/** Per-vertex fields copied straight across from the mesher. */
function writeBase(
  out: Float32Array,
  buf: LayerBuffers,
  v: number,
  origin: readonly [number, number, number],
): void {
  const o = v * VERTEX_FLOATS;
  const s = buf.shader;
  // The mesher emits section-local positions; shaderpacks expect `gl_Vertex` in world
  // space, because `gbufferModelViewInverse * gl_ModelViewMatrix * gl_Vertex +
  // cameraPosition` is how every pack recovers a world position.
  writeRange(out, o + OFFSETS.vaPosition, [
    buf.positions[v * 3] + origin[0],
    buf.positions[v * 3 + 1] + origin[1],
    buf.positions[v * 3 + 2] + origin[2],
  ]);
  writeRange(out, o + OFFSETS.vaColor, [
    buf.colors[v * 4], buf.colors[v * 4 + 1], buf.colors[v * 4 + 2], buf.colors[v * 4 + 3],
  ]);
  writeRange(out, o + OFFSETS.vaUV0, [buf.uvs[v * 2], buf.uvs[v * 2 + 1]]);
  writeRange(out, o + OFFSETS.vaNormal, [
    buf.normals[v * 3], buf.normals[v * 3 + 1], buf.normals[v * 3 + 2],
  ]);
  if (!s) return;
  writeRange(out, o + OFFSETS.vaUV2, [s.lightmap[v * 2], s.lightmap[v * 2 + 1]]);
  writeRange(out, o + OFFSETS.mc_Entity, [s.entity[v], 0, 0, 0]);
  writeRange(out, o + OFFSETS.at_midBlock, [
    s.midBlock[v * 3], s.midBlock[v * 3 + 1], s.midBlock[v * 3 + 2],
    s.lightmap[v * 2] / 16,
  ]);
}

/** Per-quad fields: the same value on all four vertices. */
/**
 * This quad's four uvs as floats in 0..1.
 *
 * Section uvs ship as normalized uint16 to halve what a vertex costs, and the GPU decodes them --
 * but this path is CPU-side and reads the array directly, where 0..65535 is just a big number.
 * `mc_midTexCoord` would land far outside the atlas and the tangent would be scaled with it.
 */
function quadUvs(buf: LayerBuffers, base: number): Float32Array {
  const scale = buf.uvs instanceof Float32Array ? 1 : 1 / 65535;
  const out = new Float32Array(8);
  for (let k = 0; k < 8; k++) out[k] = buf.uvs[base * 2 + k]! * scale;
  return out;
}

function writeQuad(out: Float32Array, buf: LayerBuffers, quad: number): void {
  const base = quad * 4;
  const uvs = quadUvs(buf, base);
  let midU = 0;
  let midV = 0;
  for (let k = 0; k < 4; k++) {
    midU += uvs[k * 2]!;
    midV += uvs[k * 2 + 1]!;
  }
  midU /= 4;
  midV /= 4;
  const tangent = quadTangent(buf.positions, uvs, base, 0);
  for (let k = 0; k < 4; k++) {
    const o = (base + k) * VERTEX_FLOATS;
    writeRange(out, o + OFFSETS.mc_midTexCoord, [midU, midV, 0, 1]);
    writeRange(out, o + OFFSETS.at_tangent, tangent);
  }
}

/**
 * Interleave one layer into the shaderpack vertex format. Vertices are emitted in quads of
 * four by the mesher, which is what makes the per-quad derivations above indexable.
 */
export function buildShaderVertices(
  buf: LayerBuffers,
  origin: readonly [number, number, number] = [0, 0, 0],
): Float32Array {
  const vertexCount = buf.positions.length / 3;
  const out = new Float32Array(vertexCount * VERTEX_FLOATS);
  for (let v = 0; v < vertexCount; v++) writeBase(out, buf, v, origin);
  for (let q = 0; q < vertexCount / 4; q++) writeQuad(out, buf, q);
  return out;
}
