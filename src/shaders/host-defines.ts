/**
 * The `#define`s Iris injects before a pack's own source.
 *
 * Packs branch heavily on these — `MC_VERSION` gates whole feature blocks, and the
 * `MC_RENDER_STAGE_*` constants are compared against the `renderStage` uniform. Getting
 * the set wrong does not fail loudly; it silently selects a different `#ifdef` branch and
 * you translate a program the pack would never have run.
 *
 * Values match a 1.21.1 client on a core-profile GL 4.6 driver, which is what the rest of
 * this project reads its assets from.
 */

/** Iris' render stage enumeration, exposed to packs as compile-time constants. */
const RENDER_STAGES = [
  'MC_RENDER_STAGE_NONE',
  'MC_RENDER_STAGE_SKY',
  'MC_RENDER_STAGE_SUNSET',
  'MC_RENDER_STAGE_CUSTOM_SKY',
  'MC_RENDER_STAGE_SUN',
  'MC_RENDER_STAGE_MOON',
  'MC_RENDER_STAGE_STARS',
  'MC_RENDER_STAGE_VOID',
  'MC_RENDER_STAGE_TERRAIN_SOLID',
  'MC_RENDER_STAGE_TERRAIN_CUTOUT_MIPPED',
  'MC_RENDER_STAGE_TERRAIN_CUTOUT',
  'MC_RENDER_STAGE_ENTITIES',
  'MC_RENDER_STAGE_BLOCK_ENTITIES',
  'MC_RENDER_STAGE_DESTROY',
  'MC_RENDER_STAGE_OUTLINE',
  'MC_RENDER_STAGE_DEBUG',
  'MC_RENDER_STAGE_HAND_SOLID',
  'MC_RENDER_STAGE_TERRAIN_TRANSLUCENT',
  'MC_RENDER_STAGE_TRIPWIRE',
  'MC_RENDER_STAGE_PARTICLES',
  'MC_RENDER_STAGE_CLOUDS',
  'MC_RENDER_STAGE_RAIN_SNOW',
  'MC_RENDER_STAGE_WORLD_BORDER',
  'MC_RENDER_STAGE_HAND_TRANSLUCENT',
] as const;

/** Distant Horizons material ids, compared against the `dhMaterialId` attribute. */
const DH_BLOCKS = [
  'DH_BLOCK_UNKNOWN', 'DH_BLOCK_LEAVES', 'DH_BLOCK_STONE', 'DH_BLOCK_WOOD',
  'DH_BLOCK_METAL', 'DH_BLOCK_DIRT', 'DH_BLOCK_LAVA', 'DH_BLOCK_DEEPSLATE',
  'DH_BLOCK_SNOW', 'DH_BLOCK_SAND', 'DH_BLOCK_TERRACOTTA', 'DH_BLOCK_NETHER_STONE',
  'DH_BLOCK_WATER', 'DH_BLOCK_AIR', 'DH_BLOCK_ILLUMINATED',
] as const;

const BASE: ReadonlyArray<readonly [string, string]> = [
  ['MC_VERSION', '12101'],
  ['MC_GL_VERSION', '460'],
  ['MC_GLSL_VERSION', '460'],
  ['MC_OS_MAC', '1'],
  ['MC_GL_VENDOR_OTHER', '1'],
  ['MC_GL_RENDERER_OTHER', '1'],
  ['MC_NORMAL_MAP', '1'],
  ['MC_SPECULAR_MAP', '1'],
  ['MC_RENDER_QUALITY', '1.0'],
  ['MC_SHADOW_QUALITY', '1.0'],
  ['MC_HAND_DEPTH', '0.125'],
  ['MC_ANISOTROPIC_FILTERING', '0'],
  ['MC_MAX_TEXTURE_SIZE', '16384'],
  ['MC_GL_EXT_GL_ARB_shader_texture_lod', '1'],
  ['MC_GL_EXT_GL_EXT_gpu_shader4', '1'],
  // Packs test IS_IRIS to pick the Iris-only code path, which is the one whose uniform and
  // buffer contract this project actually implements.
  ['IS_IRIS', '1'],
  ['MC_TEXTURE_FORMAT_LAB_PBR', '1'],
];

/**
 * The pack's own settings are `#define`s in `shaders.settings` / the program files, whose
 * allowed values live in a trailing `// [1 2 3]` comment. Overriding them here is what a
 * settings UI would do; passing them through unchanged keeps the pack's defaults.
 */
export function hostDefines(settings: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>(BASE);
  RENDER_STAGES.forEach((name, i) => out.set(name, String(i)));
  DH_BLOCKS.forEach((name, i) => out.set(name, String(i)));
  for (const [k, v] of settings) {
    // Only inject overrides the pack does not already define for itself; its own
    // `#define` will win anyway, and redefining triggers glslang's macro-redefinition
    // diagnostic on some packs.
    if (!out.has(k)) continue;
    out.set(k, v);
  }
  return out;
}
