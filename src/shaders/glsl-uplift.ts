/**
 * GLSL 120/130 compatibility profile -> Vulkan GLSL 450, the form glslang can lower to
 * SPIR-V and naga can then turn into WGSL.
 *
 * Measured in SHADERPACKS.md §3: **zero** of 756 real shaderpack programs compile without
 * this rewrite, and 80.3% compile with it. So this file is not an optimisation, it is the
 * entire reason the path exists.
 *
 * The rewrites that are not obvious from a capability table, and why they are here:
 *
 *  - OptiFine's albedo sampler is literally named `texture`, which collides with the
 *    GLSL 1.30+ `texture()` builtin. That collision is *why* the corpus is stuck on
 *    `texture2D`. It must be renamed BEFORE `texture2D(` is rewritten to `texture(`, or
 *    the rename eats the calls it just created.
 *  - `shadow2D()` returns vec4; core `texture(sampler2DShadow, …)` returns float. A naive
 *    rename produces silent `.z`-swizzle errors rather than a compile failure.
 *  - Combined image-samplers have no WGSL equivalent — naga rejects `OpTypeSampledImage`
 *    outright. Every `sampler2D` becomes `texture2D` + `sampler`, recombined at each use.
 *  - WGSL forbids matrices as entry-point I/O, and `varying mat3 tbnMatrix` is
 *    near-universal (a TBN basis). It is split into three `vec3`s.
 *  - WebGPU has no default uniform block, so every uniform moves into one shared std140
 *    block and the pack's own declarations are replaced by `#define`s onto it.
 *
 * Everything is hoisted into a prologue rather than rewritten in place. That is
 * deliberate: pack declarations sit inside `#ifdef` branches, and if the vertex and
 * fragment stages resolve those branches differently they end up with mismatched shader
 * interfaces that link "successfully" and read the wrong varying. Hoisting unconditionally
 * makes the two stages agree by construction.
 */

import {
  uniformAccessor, uniformBlockSource, type UniformLayout,
} from './iris-uniforms.js';
import {
  ATTRIBUTE_RE, UNIFORM_RE, VARYING_RE, type ProgramPlan, type Stage,
} from './glsl-plan.js';

export const UNIFORM_SET = 0;
export const UNIFORM_BINDING = 0;
export const SAMPLER_SET = 1;

/**
 * Fixed vertex attribute locations. Fixed rather than assigned, because the renderer's
 * vertex buffer layout has to match without consulting the bundle at buffer-build time.
 */
export const ATTRIBUTE_LOCATIONS: Readonly<Record<string, number>> = {
  vaPosition: 0, vaColor: 1, vaUV0: 2, vaUV2: 3, vaNormal: 4,
  mc_Entity: 5, mc_midTexCoord: 6, at_tangent: 7, at_midBlock: 8, at_velocity: 9,
};

const ATTRIBUTE_TYPES: Readonly<Record<string, string>> = {
  vaPosition: 'vec3', vaColor: 'vec4', vaUV0: 'vec2', vaUV2: 'vec2', vaNormal: 'vec3',
  mc_Entity: 'vec4', mc_midTexCoord: 'vec4', at_tangent: 'vec4', at_midBlock: 'vec4',
  at_velocity: 'vec3',
};

/** `sampler2D` -> the separate texture type and the constructor that recombines them. */
const SAMPLER_SPLIT: Readonly<Record<string, [string, string]>> = {
  sampler1D: ['texture1D', 'sampler'],
  sampler2D: ['texture2D', 'sampler'],
  sampler3D: ['texture3D', 'sampler'],
  samplerCube: ['textureCube', 'sampler'],
  sampler2DShadow: ['texture2D', 'samplerShadow'],
  sampler1DShadow: ['texture1D', 'samplerShadow'],
  samplerCubeShadow: ['textureCube', 'samplerShadow'],
  isampler2D: ['itexture2D', 'sampler'],
  isampler3D: ['itexture3D', 'sampler'],
  usampler2D: ['utexture2D', 'sampler'],
  usampler3D: ['utexture3D', 'sampler'],
};

export interface UpliftOptions {
  readonly stage: Stage;
  readonly plan: ProgramPlan;
  readonly layout: UniformLayout;
  /** colortex index per fragment output location; empty for non-fragment stages */
  readonly drawBuffers: readonly number[];
  /** host `#define`s injected ahead of the pack's own source */
  readonly hostDefines: ReadonlyMap<string, string>;
}

export interface UpliftResult {
  readonly code: string;
  readonly uniformsUsed: readonly string[];
  /** declared by the pack but absent from the Iris table — bound to zero, as Iris does */
  readonly unknownUniforms: readonly string[];
  readonly attributesUsed: readonly string[];
  readonly unknownAttributes: readonly string[];
  readonly fragOutputs: number;
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------------ text transforms */

/**
 * The albedo sampler is named `texture`. `\btexture\b` cannot match inside `texture2D`
 * (no word boundary before the digit), so this is exact — and it must run before the
 * builtin rewrite below.
 */
function renameAtlasSampler(src: string): string {
  return src.replace(/\btexture\b/g, 'gtexture');
}

const TEXTURE_BUILTINS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btexture2DGradARB\s*\(/g, 'textureGrad('],
  [/\btexture2DLodARB\s*\(/g, 'textureLod('],
  [/\btexture2DGrad\s*\(/g, 'textureGrad('],
  [/\btexture2DLod\s*\(/g, 'textureLod('],
  [/\btexture2DProj\s*\(/g, 'textureProj('],
  [/\btexture3DLod\s*\(/g, 'textureLod('],
  [/\btextureCubeLod\s*\(/g, 'textureLod('],
  [/\btexture2D\s*\(/g, 'texture('],
  [/\btexture3D\s*\(/g, 'texture('],
  [/\btextureCube\s*\(/g, 'texture('],
  [/\bshadow2DLod\s*\(/g, 'iris_shadow2DLod('],
  [/\bshadow2D\s*\(/g, 'iris_shadow2D('],
];

function rewriteTextureBuiltins(src: string): string {
  let out = src;
  for (const [re, to] of TEXTURE_BUILTINS) out = out.replace(re, to);
  return out;
}

/** Strip declarations we hoist into the prologue instead. */
function stripHoistedDeclarations(src: string): string {
  return src
    .replace(VARYING_RE, '')
    .replace(ATTRIBUTE_RE, '')
    .replace(UNIFORM_RE, (whole, indent: string, type: string) =>
      SAMPLER_SPLIT[type] ? indent : whole);
}

/** Replace the pack's non-sampler uniform declarations with nothing; they move to the UBO. */
function stripUniformDeclarations(src: string): string {
  return src.replace(UNIFORM_RE, (_whole, indent: string) => indent);
}

function rewriteFragData(src: string): { code: string; maxIndex: number } {
  let maxIndex = -1;
  const code = src
    .replace(/\bgl_FragData\s*\[\s*(\d+)\s*\]/g, (_m, i: string) => {
      maxIndex = Math.max(maxIndex, Number(i));
      return `iris_FragData${i}`;
    })
    .replace(/\bgl_FragColor\b/g, () => {
      maxIndex = Math.max(maxIndex, 0);
      return 'iris_FragData0';
    });
  return { code, maxIndex };
}

/** `gl_TextureMatrix[k]` for a literal k; the matrices live in three separate UBO slots. */
function rewriteTextureMatrix(src: string, layout: UniformLayout, notes: string[]): string {
  const out = src.replace(/\bgl_TextureMatrix\s*\[\s*(\d)\s*\]/g, (_m, i: string) => {
    const slot = layout.slots.get(`iris_TextureMatrix${Math.min(Number(i), 2)}`);
    return slot ? uniformAccessor(slot) : 'mat4(1.0)';
  });
  if (/\bgl_TextureMatrix\b/.test(out)) {
    notes.push('gl_TextureMatrix indexed by a non-literal; substituted identity');
    return out.replace(/\bgl_TextureMatrix\s*\[[^\]]*\]/g, 'mat4(1.0)');
  }
  return out;
}

/* ------------------------------------------------------------------ prologue building */

function accessorFor(layout: UniformLayout, name: string): string | null {
  const slot = layout.slots.get(name);
  return slot ? uniformAccessor(slot) : null;
}

function samplerDeclarations(plan: ProgramPlan): string[] {
  const lines: string[] = [];
  for (const s of plan.samplers.values()) {
    const split = SAMPLER_SPLIT[s.type];
    if (!split) continue;
    const [texType, sampType] = split;
    lines.push(
      `layout(set = ${SAMPLER_SET}, binding = ${s.binding}) uniform ${texType} ${s.name}_T;`,
      `layout(set = ${SAMPLER_SET}, binding = ${s.binding + 1}) uniform ${sampType} ${s.name}_S;`,
      `#define ${s.name} ${s.type}(${s.name}_T, ${s.name}_S)`,
    );
  }
  return lines;
}

/**
 * `shadow2D` returned a vec4 whose components were all the comparison result. Core
 * `texture(sampler2DShadow, …)` returns a bare float, so packs that swizzle the old
 * return value need the vec4 shape back or they fail on `.z` — quietly, if the compiler
 * happens to accept it.
 */
/**
 * Macros, not functions, and that is load-bearing. A sampler name expands to a
 * `sampler2DShadow(tex, samp)` constructor, and Vulkan GLSL forbids passing a sampler
 * constructor as a function argument — so a helper *function* would fail on exactly the
 * shaders it exists to serve. A macro expands at the call site and never forms an
 * argument.
 */
const SHADOW_HELPERS = [
  '#define iris_shadow2D(s, c) vec4(texture(s, c))',
  '#define iris_shadow2DLod(s, c, l) vec4(textureLod(s, c, l))',
];

function fogHelper(layout: UniformLayout): string[] {
  const color = accessorFor(layout, 'fogColor') ?? 'vec3(0.0)';
  const density = accessorFor(layout, 'fogDensity') ?? '0.0';
  const start = accessorFor(layout, 'fogStart') ?? '0.0';
  const end = accessorFor(layout, 'fogEnd') ?? '1.0';
  return [
    'struct IrisFogParameters { vec4 color; float density; float start; float end;',
    '  float scale; };',
    'IrisFogParameters iris_fogParams() {',
    `  float s = ${start}; float e = ${end};`,
    `  return IrisFogParameters(vec4(${color}, 1.0), ${density}, s, e,`,
    '    1.0 / max(e - s, 0.0001));',
    '}',
  ];
}

interface BuiltinRule {
  readonly token: string;
  readonly expansion: string;
  /** vertex attribute this builtin is served from, if any */
  readonly attribute?: string;
}

/**
 * Substituted textually, NOT with `#define`.
 *
 * GLSL reserves every name beginning with `gl_`, and that includes macro names — a
 * `#define gl_Vertex …` is rejected outright, after which `gl_Vertex` survives to the
 * parser and reports as an undeclared identifier. The reserved-name rule is the reason
 * this whole group cannot use the same mechanism as the uniforms.
 */
function builtinRules(layout: UniformLayout): BuiltinRule[] {
  const mv = accessorFor(layout, 'modelViewMatrix') ?? 'mat4(1.0)';
  const proj = accessorFor(layout, 'projectionMatrix') ?? 'mat4(1.0)';
  const vertex = 'vec4(vaPosition, 1.0)';
  return [
    { token: 'gl_Vertex', expansion: vertex, attribute: 'vaPosition' },
    { token: 'gl_Color', expansion: 'vaColor', attribute: 'vaColor' },
    { token: 'gl_Normal', expansion: 'vaNormal', attribute: 'vaNormal' },
    { token: 'gl_MultiTexCoord0', expansion: 'vec4(vaUV0, 0.0, 1.0)', attribute: 'vaUV0' },
    { token: 'gl_MultiTexCoord1', expansion: 'vec4(vaUV2, 0.0, 1.0)', attribute: 'vaUV2' },
    { token: 'gl_MultiTexCoord2', expansion: 'vec4(vaUV2, 0.0, 1.0)', attribute: 'vaUV2' },
    { token: 'gl_ModelViewMatrixInverse', expansion: `inverse(${mv})` },
    { token: 'gl_ModelViewProjectionMatrix', expansion: `(${proj} * ${mv})` },
    { token: 'gl_ModelViewMatrix', expansion: mv },
    { token: 'gl_ProjectionMatrixInverse', expansion: `inverse(${proj})` },
    { token: 'gl_ProjectionMatrix', expansion: proj },
    { token: 'gl_NormalMatrix', expansion: accessorFor(layout, 'normalMatrix') ?? 'mat3(1.0)' },
    { token: 'gl_Fog', expansion: 'iris_fogParams()' },
    { token: 'ftransform()', expansion: `(${proj} * ${mv} * ${vertex})`, attribute: 'vaPosition' },
  ];
}

interface BuiltinResult {
  readonly body: string;
  readonly attributes: Set<string>;
}

/**
 * Longest token first: `gl_ModelViewMatrixInverse` must not be eaten by the rule for
 * `gl_ModelViewMatrix`, and the rule list is ordered accordingly.
 */
function rewriteBuiltins(body: string, layout: UniformLayout): BuiltinResult {
  const attributes = new Set<string>();
  let out = body;
  for (const rule of builtinRules(layout)) {
    const re = rule.token.endsWith('()')
      ? new RegExp(`\\b${rule.token.slice(0, -2)}\\s*\\(\\s*\\)`, 'g')
      : new RegExp(`\\b${rule.token}\\b`, 'g');
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, rule.expansion);
    if (rule.attribute) attributes.add(rule.attribute);
  }
  return { body: out, attributes };
}

/* ------------------------------------------------------------------ uniform rebinding */

interface UniformScan {
  readonly defines: string[];
  readonly used: string[];
  readonly unknown: string[];
}

/**
 * Every uniform the pack declares is re-expressed as a **global variable** reading the
 * shared block — not as a `#define`.
 *
 * A macro looks equivalent and is not. Sildur's `composite1` declares `uniform vec3
 * sunVec;` and then, inside a function, `vec3 sunVec = normalize(sunPosition);`. Under a
 * macro that local declaration expands to `vec3 iu.iu_vec[N].xyz = …` and the program
 * fails to parse. A global is shadowed by the local exactly as GLSL's own scoping
 * intends, which is what the pack was written against. SHADERPACKS.md §5.4 flags this as
 * "the single clearest place where correctness needs scoping"; this is that place.
 *
 * Uniforms the Iris table does not know are NOT an error. Iris leaves them unbound and
 * they read zero, and a host that refused instead would reject packs over a uniform they
 * may never branch on. They are named in the report rather than swallowed.
 */
function scanUniforms(body: string, layout: UniformLayout): UniformScan {
  const defines: string[] = [];
  const used: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(UNIFORM_RE)) {
    const [, , type, name] = m;
    if (SAMPLER_SPLIT[type] || seen.has(name)) continue;
    seen.add(name);
    const accessor = accessorFor(layout, name);
    defines.push(`${type} ${name} = ${accessor ?? zeroOf(type)};`);
    (accessor ? used : unknown).push(name);
  }
  return { defines, used, unknown };
}

function zeroOf(type: string): string {
  if (type === 'bool') return 'false';
  if (type === 'int' || type === 'uint') return '0';
  if (type === 'float') return '0.0';
  if (/^(vec|ivec|uvec|bvec|mat)/.test(type)) return `${type}(0)`;
  return '0';
}

/* ------------------------------------------------------------------ varyings */

interface VaryingEmit {
  readonly lines: string[];
  /** mat3 varyings that need copying into their split outputs in the vertex epilogue */
  readonly matrixNames: string[];
}

function emitVaryings(plan: ProgramPlan, stage: Stage): VaryingEmit {
  const lines: string[] = [];
  const matrixNames: string[] = [];
  const dir = stage === 'vertex' ? 'out' : 'in';
  for (const v of plan.varyings.values()) {
    if (v.type === 'mat3') {
      matrixNames.push(v.name);
      emitSplitMatrix(lines, v.name, v.location, dir, stage);
      continue;
    }
    lines.push(`layout(location = ${v.location}) ${dir} ${v.type} ${v.name};`);
  }
  return { lines, matrixNames };
}

function emitSplitMatrix(
  lines: string[],
  name: string,
  location: number,
  dir: string,
  stage: Stage,
): void {
  for (let i = 0; i < 3; i++) {
    lines.push(`layout(location = ${location + i}) ${dir} vec3 ${name}__c${i};`);
  }
  // The vertex stage assigns to the matrix, so it keeps a real mat3 and copies out in the
  // epilogue. The fragment stage only reads it, so a macro is enough.
  if (stage === 'vertex') lines.push(`mat3 ${name};`);
  else lines.push(`#define ${name} mat3(${name}__c0, ${name}__c1, ${name}__c2)`);
}

/**
 * Wrap the pack's `main` so every vertex output is written.
 *
 * Varyings are hoisted unconditionally so the two stages agree, which means a stage may
 * now declare an output it never assigns. glslang would eliminate it, the fragment stage
 * would still read it, and WebGPU would then refuse the pipeline for a missing vertex
 * output. Zeroing them first costs nothing and removes the whole failure mode.
 */
function vertexEpilogue(plan: ProgramPlan, matrixNames: readonly string[]): string[] {
  const zero: string[] = [];
  for (const v of plan.varyings.values()) {
    if (v.type === 'mat3') {
      for (let i = 0; i < 3; i++) zero.push(`  ${v.name}__c${i} = vec3(0.0);`);
    } else {
      zero.push(`  ${v.name} = ${v.type}(0);`);
    }
  }
  const copy = matrixNames.flatMap((n) =>
    [0, 1, 2].map((i) => `  ${n}__c${i} = ${n}[${i}];`));
  return ['void main() {', ...zero, '  iris_main();', ...copy, ...CLIP_SPACE_FIXUP, '}'];
}

/**
 * OpenGL clip space is z in [-w, w]; WebGPU's is [0, w].
 *
 * Every shaderpack was written against OpenGL and computes `gl_Position` accordingly, so
 * handing that straight to WebGPU throws away the near half of the depth range: geometry
 * in front of the midpoint is clipped, and what survives depth-tests against the wrong
 * values. The symptom is not a blank screen but a *partly* drawn world, which is far
 * harder to attribute.
 *
 * Remapping here — after the pack's own main has run — rather than by pre-multiplying the
 * projection matrix is deliberate: `gbufferProjection` and its inverse stay in the OpenGL
 * convention the pack's own reprojection maths expects.
 */
const CLIP_SPACE_FIXUP = [
  '  gl_Position.z = (gl_Position.z + gl_Position.w) * 0.5;',
];

/* ------------------------------------------------------------------ entry point */

function hostDefineLines(defines: ReadonlyMap<string, string>): string[] {
  return [...defines].map(([k, v]) => (v === '' ? `#define ${k}` : `#define ${k} ${v}`));
}

function attributeDeclarations(names: Iterable<string>): string[] {
  return [...names]
    .filter((n) => ATTRIBUTE_LOCATIONS[n] !== undefined)
    .sort((a, b) => ATTRIBUTE_LOCATIONS[a] - ATTRIBUTE_LOCATIONS[b])
    .map((n) => `layout(location = ${ATTRIBUTE_LOCATIONS[n]}) in ${ATTRIBUTE_TYPES[n]} ${n};`);
}

/**
 * Attributes the host is expected to supply without the pack ever declaring them.
 * Distant Horizons' `dhMaterialId` is the whole of it for this corpus: SHADERPACKS.md
 * §5.3 attributes 21 of the 73 `OTHER` failures to exactly this one identifier. Zero is
 * the correct value here rather than a fudge — nothing this renderer draws is DH terrain,
 * so no vertex is ever DH water.
 */
const HOST_INJECTED_ATTRIBUTES: Readonly<Record<string, string>> = {
  dhMaterialId: 'int',
};

function hostInjectedGlobals(body: string, declared: ReadonlyMap<string, string>): string[] {
  return Object.entries(HOST_INJECTED_ATTRIBUTES)
    .filter(([n]) => !declared.has(n) && new RegExp(`\\b${n}\\b`).test(body))
    .map(([n, t]) => `${t} ${n} = ${zeroOf(t)};`);
}

/**
 * Attributes outside the fixed table become zero-initialised globals. Iris would supply
 * them; we cannot, and a pack losing one attribute renders wrong, whereas refusing to
 * compile renders nothing.
 */
function unknownAttributeGlobals(decls: ReadonlyMap<string, string>): string[] {
  return [...decls]
    .filter(([n]) => ATTRIBUTE_LOCATIONS[n] === undefined)
    .map(([n, t]) => `${t} ${n} = ${zeroOf(t)};`);
}

function collectDeclaredAttributes(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(ATTRIBUTE_RE)) out.set(m[3], m[2]);
  return out;
}

function fragOutputDeclarations(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`layout(location = ${i}) out vec4 iris_FragData${i};`);
  }
  return lines;
}

/**
 * The rewrites that must happen BEFORE the program is planned.
 *
 * This ordering is not cosmetic. The sampler plan is keyed by declared name, and
 * OptiFine's albedo sampler is named `texture`. Plan first and the prologue emits
 * `#define texture sampler2D(texture_T, texture_S)`, which then rewrites every
 * `texture(...)` builtin call in the body into a constructor applied to arguments —
 * "function call expected", on every fragment shader in the pack. Rename first and the
 * plan sees `gtexture`, which collides with nothing.
 */
export function normaliseStageSource(src: string): string {
  let out = rewriteTextureBuiltins(renameAtlasSampler(src));
  out = out.replace(/^\s*#version[^\n]*$/gm, '');
  // #extension names extensions that are core in 450; glslang rejects some of them.
  out = out.replace(/^\s*#extension[^\n]*$/gm, '');
  out = out.replace(/\bgl_FogFragCoord\b/g, 'iris_fogFragCoord');
  // A compatibility varying with no `varying` declaration to find, so it is given one and
  // the ordinary varying machinery carries it from there.
  if (/\biris_fogFragCoord\b/.test(out)) out = `varying float iris_fogFragCoord;\n${out}`;
  return out;
}

interface Prepared {
  readonly body: string;
  readonly fragOutputs: number;
  readonly notes: string[];
}

/** Assumes `normaliseStageSource` has already run. */
function prepareBody(src: string, opts: UpliftOptions): Prepared {
  const notes: string[] = [];
  let body = rewriteTextureMatrix(src, opts.layout, notes);

  let fragOutputs = 0;
  if (opts.stage === 'fragment') {
    const r = rewriteFragData(body);
    body = r.code;
    fragOutputs = Math.max(opts.drawBuffers.length, r.maxIndex + 1);
  }
  return { body, fragOutputs, notes };
}

export function uplift(src: string, opts: UpliftOptions): UpliftResult {
  const prepared = prepareBody(src, opts);
  const { fragOutputs, notes } = prepared;

  const declaredAttrs = collectDeclaredAttributes(prepared.body);
  const builtins = rewriteBuiltins(prepared.body, opts.layout);
  const body = builtins.body;
  const uniforms = scanUniforms(body, opts.layout);
  const varyings = emitVaryings(opts.plan, opts.stage);

  const attrNames = new Set<string>(builtins.attributes);
  for (const name of declaredAttrs.keys()) {
    if (ATTRIBUTE_LOCATIONS[name] !== undefined) attrNames.add(name);
  }

  const isVertex = opts.stage === 'vertex';
  const stripped = stripUniformDeclarations(stripHoistedDeclarations(body));
  const needsWrapper = isVertex;

  const prologue = [
    '#version 450 core',
    ...hostDefineLines(opts.hostDefines),
    uniformBlockSource(opts.layout, UNIFORM_SET, UNIFORM_BINDING),
    ...samplerDeclarations(opts.plan),
    ...SHADOW_HELPERS,
    ...fogHelper(opts.layout),
    ...(isVertex ? attributeDeclarations(attrNames) : []),
    ...(isVertex ? unknownAttributeGlobals(declaredAttrs) : []),
    ...hostInjectedGlobals(body, declaredAttrs),
    ...varyings.lines,
    ...(opts.stage === 'fragment' ? fragOutputDeclarations(fragOutputs) : []),
    ...uniforms.defines,
  ];

  const main = needsWrapper
    ? stripped.replace(/\bvoid\s+main\s*\(/, 'void iris_main(')
    : stripped;
  const epilogue = needsWrapper ? vertexEpilogue(opts.plan, varyings.matrixNames) : [];

  return {
    code: [...prologue, main, ...epilogue].join('\n'),
    uniformsUsed: uniforms.used,
    unknownUniforms: uniforms.unknown,
    attributesUsed: [...attrNames],
    unknownAttributes: [...declaredAttrs.keys()].filter(
      (n) => ATTRIBUTE_LOCATIONS[n] === undefined,
    ),
    fragOutputs,
    notes,
  };
}
