/**
 * Depth -> r32float blit.
 *
 * The one shader in this project written directly in WGSL rather than translated. It
 * exists because WebGPU will not bind a depth-format texture to the `texture_2d<f32>` that
 * a pack's `uniform sampler2D depthtex0;` becomes, and rewriting every depth read in every
 * pack is far more invasive than copying the buffer once per stage.
 *
 * `textureLoad` rather than a sampler: the copy is 1:1 at the same resolution, so there is
 * nothing to filter, and it avoids needing a sampler binding at all.
 */

export const DEPTH_BLIT_WGSL = `
@group(0) @binding(0) var src: texture_depth_2d;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One oversized triangle covering the viewport: fewer vertices than a quad and no seam
  // down the diagonal.
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) f32 {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`;
