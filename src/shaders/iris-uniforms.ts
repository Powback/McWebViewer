/**
 * The Iris/OptiFine uniform contract, and the std140 block it is packed into.
 *
 * A shaderpack is only half a program: every `uniform` it declares is the host's job to
 * fill. WebGPU has no default uniform block, so all of them go into one explicit std140
 * block that every program shares. Sharing one block across all programs is what lets the
 * runtime write the buffer once per frame and bind it to every pass.
 *
 * Layout is deliberately simple rather than tight: three arrays, each element 16-byte
 * aligned, so an offset is a multiplication and never a packing rule.
 *
 *   mat4  iu_mat[]    64 B each
 *   vec4  iu_vec[]    16 B each   (float/vec2/vec3/vec4 all take a whole slot)
 *   ivec4 iu_ivec[]   16 B each   (int/bool/ivec2 all take a whole slot)
 *
 * Uniforms NOT in this table are not an error. Iris leaves an unknown uniform unbound and
 * it reads as zero; a host that refuses instead would reject packs over a uniform they may
 * not even branch on. `unknownUniforms` in the build report names every one that happened.
 */

export type UniformKind =
  | 'mat4' | 'mat3'
  | 'vec4' | 'vec3' | 'vec2' | 'float'
  | 'ivec4' | 'ivec2' | 'int' | 'bool';

export interface UniformDef {
  readonly name: string;
  readonly kind: UniformKind;
}

const def = (name: string, kind: UniformKind): UniformDef => ({ name, kind });

/** Matrices. `mat3` is stored as a mat4 and read back with a `mat3(...)` cast. */
const MATRICES: readonly UniformDef[] = [
  def('gbufferModelView', 'mat4'),
  def('gbufferModelViewInverse', 'mat4'),
  def('gbufferPreviousModelView', 'mat4'),
  def('gbufferProjection', 'mat4'),
  def('gbufferProjectionInverse', 'mat4'),
  def('gbufferPreviousProjection', 'mat4'),
  def('shadowModelView', 'mat4'),
  def('shadowModelViewInverse', 'mat4'),
  def('shadowProjection', 'mat4'),
  def('shadowProjectionInverse', 'mat4'),
  def('modelViewMatrix', 'mat4'),
  def('modelViewMatrixInverse', 'mat4'),
  def('projectionMatrix', 'mat4'),
  def('projectionMatrixInverse', 'mat4'),
  def('normalMatrix', 'mat3'),
  def('textureMatrix', 'mat4'),
  // gl_TextureMatrix[0..2]: 0 is the atlas matrix (identity), 1 and 2 map the packed
  // lightmap coordinate into the 0..1 lightmap texture.
  def('iris_TextureMatrix0', 'mat4'),
  def('iris_TextureMatrix1', 'mat4'),
  def('iris_TextureMatrix2', 'mat4'),
];

/** Float / vector uniforms. */
const VECTORS: readonly UniformDef[] = [
  def('cameraPosition', 'vec3'),
  def('previousCameraPosition', 'vec3'),
  def('sunPosition', 'vec3'),
  def('moonPosition', 'vec3'),
  def('shadowLightPosition', 'vec3'),
  def('upPosition', 'vec3'),
  def('fogColor', 'vec3'),
  def('skyColor', 'vec3'),
  def('entityColor', 'vec4'),
  def('chunkOffset', 'vec3'),
  def('eyePosition', 'vec3'),
  def('near', 'float'),
  def('far', 'float'),
  def('viewWidth', 'float'),
  def('viewHeight', 'float'),
  def('aspectRatio', 'float'),
  def('frameTime', 'float'),
  def('frameTimeCounter', 'float'),
  def('sunAngle', 'float'),
  def('shadowAngle', 'float'),
  def('rainStrength', 'float'),
  def('wetness', 'float'),
  def('thunderStrength', 'float'),
  def('blindness', 'float'),
  def('darknessFactor', 'float'),
  def('darknessLightFactor', 'float'),
  def('nightVision', 'float'),
  def('playerMood', 'float'),
  def('screenBrightness', 'float'),
  def('eyeAltitude', 'float'),
  def('centerDepthSmooth', 'float'),
  def('fogDensity', 'float'),
  def('fogStart', 'float'),
  def('fogEnd', 'float'),
  def('cloudHeight', 'float'),
  def('alphaTestRef', 'float'),
  def('ambientLight', 'float'),
  def('rainfall', 'float'),
  def('temperature', 'float'),
  def('dhNearPlane', 'float'),
  def('dhFarPlane', 'float'),
  def('currentPlayerHealth', 'float'),
  def('maxPlayerHealth', 'float'),
  def('currentPlayerAir', 'float'),
  def('maxPlayerAir', 'float'),
  def('currentPlayerHunger', 'float'),
  def('maxPlayerHunger', 'float'),
];

/** Integer / boolean uniforms. */
const INTEGERS: readonly UniformDef[] = [
  def('atlasSize', 'ivec2'),
  def('eyeBrightness', 'ivec2'),
  def('eyeBrightnessSmooth', 'ivec2'),
  def('frameCounter', 'int'),
  def('worldTime', 'int'),
  def('worldDay', 'int'),
  def('moonPhase', 'int'),
  def('isEyeInWater', 'int'),
  def('hideGUI', 'int'),
  def('heldItemId', 'int'),
  def('heldItemId2', 'int'),
  def('heldBlockLightValue', 'int'),
  def('heldBlockLightValue2', 'int'),
  def('blockEntityId', 'int'),
  def('entityId', 'int'),
  def('currentRenderedItemId', 'int'),
  def('currentSelectedBlockId', 'int'),
  def('fogMode', 'int'),
  def('fogShape', 'int'),
  def('renderStage', 'int'),
  def('dhRenderDistance', 'int'),
  def('bedrockLevel', 'int'),
  def('heightLimit', 'int'),
  def('logicalHeightLimit', 'int'),
  def('biome', 'int'),
  def('biome_category', 'int'),
  def('biome_precipitation', 'int'),
  def('hasCeiling', 'bool'),
  def('hasSkylight', 'bool'),
  def('isSpectator', 'bool'),
  def('isRightHanded', 'bool'),
  def('is_sneaking', 'bool'),
  def('is_sprinting', 'bool'),
  def('is_hurt', 'bool'),
  def('is_invisible', 'bool'),
  def('is_burning', 'bool'),
  def('is_on_ground', 'bool'),
];

const FLOAT_KINDS: ReadonlySet<UniformKind> = new Set<UniformKind>([
  'vec4', 'vec3', 'vec2', 'float',
]);

export function isMatrixKind(kind: UniformKind): boolean {
  return kind === 'mat4' || kind === 'mat3';
}

export function isFloatKind(kind: UniformKind): boolean {
  return FLOAT_KINDS.has(kind);
}

export interface UniformSlot extends UniformDef {
  /** which of the three arrays */
  readonly array: 'mat' | 'vec' | 'ivec';
  /** index within that array */
  readonly index: number;
  /** byte offset from the start of the block */
  readonly offset: number;
}

export interface UniformLayout {
  readonly slots: ReadonlyMap<string, UniformSlot>;
  readonly matCount: number;
  readonly vecCount: number;
  readonly ivecCount: number;
  readonly sizeBytes: number;
}

function pushSlots(
  out: Map<string, UniformSlot>,
  defs: readonly UniformDef[],
  array: UniformSlot['array'],
  stride: number,
  base: number,
): void {
  defs.forEach((d, index) => {
    out.set(d.name, { ...d, array, index, offset: base + index * stride });
  });
}

/** The one layout every program in every pack shares. */
export function irisUniformLayout(): UniformLayout {
  const slots = new Map<string, UniformSlot>();
  const matBytes = MATRICES.length * 64;
  const vecBytes = VECTORS.length * 16;
  pushSlots(slots, MATRICES, 'mat', 64, 0);
  pushSlots(slots, VECTORS, 'vec', 16, matBytes);
  pushSlots(slots, INTEGERS, 'ivec', 16, matBytes + vecBytes);
  return {
    slots,
    matCount: MATRICES.length,
    vecCount: VECTORS.length,
    ivecCount: INTEGERS.length,
    sizeBytes: matBytes + vecBytes + INTEGERS.length * 16,
  };
}

/** GLSL declaration of the shared block, injected into every program. */
export function uniformBlockSource(layout: UniformLayout, set: number, binding: number): string {
  return [
    `layout(std140, set = ${set}, binding = ${binding}) uniform IrisUniforms {`,
    `  mat4 iu_mat[${layout.matCount}];`,
    `  vec4 iu_vec[${layout.vecCount}];`,
    `  ivec4 iu_ivec[${layout.ivecCount}];`,
    '} iu;',
  ].join('\n');
}

const SWIZZLE: Partial<Record<UniformKind, string>> = {
  vec4: '', vec3: '.xyz', vec2: '.xy', float: '.x',
  ivec4: '', ivec2: '.xy', int: '.x',
};

/**
 * How a program refers to one uniform once its own `uniform` declaration has been removed.
 * `bool` becomes a comparison, and `mat3` a cast, because std140 has neither shape.
 */
export function uniformAccessor(slot: UniformSlot): string {
  if (slot.kind === 'mat4') return `iu.iu_mat[${slot.index}]`;
  if (slot.kind === 'mat3') return `mat3(iu.iu_mat[${slot.index}])`;
  if (slot.kind === 'bool') return `(iu.iu_ivec[${slot.index}].x != 0)`;
  const array = isFloatKind(slot.kind) ? 'iu_vec' : 'iu_ivec';
  return `iu.${array}[${slot.index}]${SWIZZLE[slot.kind] ?? ''}`;
}

export { MATRICES, VECTORS, INTEGERS };
