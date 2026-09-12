/**
 * Ambient block particles — torch smoke, campfire plumes, rising bubbles, drifting spores.
 *
 * READ THIS BEFORE TRYING TO MAKE IT GENERIC. You cannot. This is the one place in the
 * project that hardcodes vanilla behaviour, and it does so because there is no alternative:
 * `Block.animateTick` is imperative Java, not declarative data. A `VoxelShape` can be read
 * out of the running game and a model is JSON, but "which particle, where, how often" exists
 * only as a method body. 107 of the game's blocks override `animateTick`; every one of them
 * would need its bytecode understood individually, and a modded block's could do anything at
 * all. The emitter table below is therefore vanilla-only BY CONSTRUCTION, and it is keyed on
 * exact block names so **a modded block emits nothing rather than borrowing a vanilla
 * emitter that happens to share a name** — wrong particles are worse than none.
 *
 * The user was told this and asked for it anyway, which is a legitimate trade: six emitters
 * that cover what is actually visible, against a feature that cannot follow the mods.
 *
 * WHAT IS MEASURED HERE, AND WHAT IS NOT. The sampling and the gates are read out of the
 * client, not invented:
 *
 *   ClientLevel.animateTick   667 iterations a tick, each sampling twice — once within 16
 *                             blocks and once within 32 — so 1,334 block samples a tick, and
 *                             a block's emission rate falls out of how often it is sampled
 *                             rather than being a rate anyone chose.
 *   doAnimateTick             per axis, `origin + nextInt(range) - nextInt(range)`: a
 *                             triangular distribution centred on the camera.
 *   CampfireBlock             `nextInt(10) == 0` for the cosy smoke plume.
 *   SmokeParticle             velocity spread 0.1, quad size 0.3, base lifetime 8 ticks.
 *   BubbleParticle            velocity spread 0.02, quad size 0.6 * rand + 0.2, no gravity.
 *
 * Per-particle drift and fade beyond those constants is approximated rather than
 * disassembled class by class, and is marked where it appears.
 *
 * MEASURED IN THIS WORLD, before building: **about 560 blocks emit** — 456 bubble columns,
 * 49 torches, 38 spore blossoms, 14 lit campfires, 11 lit candles. Three things I had
 * previously counted as emitters are not: `magma_block` and `spawner` do not override
 * `animateTick` at all, and neither does `lava` — lava's particles come from the FLUID, which
 * a Block-only extraction never walks. That correction removed 38,174 cells from the estimate
 * and with them the only frame-time concern the feature had.
 */

/** A particle's kind, which decides its texture set and how it moves. */
export type ParticleKind =
  | 'smoke' | 'big_smoke' | 'flame' | 'small_flame' | 'bubble' | 'current_down' | 'spore';

export interface ParticleSpec {
  /** sprite ids, one per animation frame; the particle picks by age */
  frames: readonly string[];
  /** ticks at full rate; the real lifetime is scaled per particle */
  lifetime: number;
  /** blocks per tick added to vertical velocity — negative falls */
  gravity: number;
  /** starting size in blocks */
  size: number;
  /** velocity damping per tick */
  drag: number;
  /**
   * Multiply colour. `BaseAshSmokeParticle` sets `rCol = gCol = bCol = nextFloat() * scale`,
   * so smoke is a random DARK grey — drawing it white is the difference between a wisp and a
   * bright blob, and was exactly the bug the first screenshot showed.
   */
  colour: readonly [number, number, number];
  /** how far the colour varies per particle, as a fraction of `colour` */
  colourJitter: number;
}

const generic = (n: number) => `minecraft:particle/generic_${n}`;
const bigSmoke = (n: number) => `minecraft:particle/big_smoke_${n}`;

/*
 * THE FRAME LISTS ARE THE DEFINITIONS', NOT GUESSES. `assets/minecraft/particles/<name>.json`
 * names each type's texture frames, and reading them corrected two things a sensible guess
 * got wrong:
 *
 *   smoke                    frames run DESCENDING, generic_7 down to generic_0. The sprite
 *                            set is indexed by age, so a puff SHRINKS as it rises; listing
 *                            them ascending makes smoke grow, which reads as steam.
 *   falling_spore_blossom    uses `drip_fall`, not a texture called `spore_blossom` — that
 *                            file does not exist, and asking for it left a missing sprite.
 */

/**
 * The particle kinds these emitters need.
 *
 * `lifetime`, `size` and the velocity spreads come from the particle classes; the drag and
 * the exact gravity of the smoke variants are approximations, which is why they are grouped
 * here where they can be corrected in one place rather than spread through the emitters.
 */
export const PARTICLES: Record<ParticleKind, ParticleSpec> = {
  // SmokeParticle: quadSize 0.3, lifetime 8 scaled by 1/(rand*0.8+0.2), rises then slows.
  // SmokeParticle -> BaseAshSmokeParticle(colour scale 0.3, friction 0.96, quadSize *= 0.75
  // off a 0.2 base, lifetime 8/(rand*0.8 + 0.2)). The quad spans +/- quadSize, so 0.3 blocks.
  smoke: {
    frames: [7, 6, 5, 4, 3, 2, 1, 0].map(generic),
    lifetime: 40, gravity: 0.002, size: 0.3, drag: 0.96,
    colour: [0.3, 0.3, 0.3], colourJitter: 1,
  },
  // Campfire smoke lives far longer and climbs — the plume is the point.
  big_smoke: {
    frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(bigSmoke),
    lifetime: 200, gravity: 0.004, size: 0.8, drag: 0.985,
    // A campfire plume reads much lighter than torch smoke; the texture carries most of it.
    colour: [0.75, 0.72, 0.7], colourJitter: 0.25,
  },
  // FlameParticle sets no colour: the flame texture is already orange and is drawn white.
  flame: {
    frames: ['minecraft:particle/flame'], lifetime: 25, gravity: -0.0008, size: 0.22,
    drag: 0.94, colour: [1, 1, 1], colourJitter: 0,
  },
  small_flame: {
    frames: ['minecraft:particle/flame'], lifetime: 20, gravity: -0.0006, size: 0.12,
    drag: 0.94, colour: [1, 1, 1], colourJitter: 0,
  },
  // BubbleParticle: no gravity, rises with the column, size 0.6*rand + 0.2 of a block eighth.
  bubble: {
    frames: ['minecraft:particle/bubble'], lifetime: 40, gravity: 0.008, size: 0.18,
    drag: 0.99, colour: [1, 1, 1], colourJitter: 0,
  },
  // CURRENT_DOWN is its own particle type; its definition names the same `bubble` texture,
  // so the difference is the motion rather than the sprite.
  current_down: {
    frames: ['minecraft:particle/bubble'], lifetime: 40, gravity: -0.004, size: 0.18,
    drag: 0.99, colour: [1, 1, 1], colourJitter: 0,
  },
  // The spore blossom's falling particle is tinted pale pink; the drip_fall texture is
  // white, so the tint is what makes it read as spores rather than as water.
  spore: {
    frames: ['minecraft:particle/drip_fall'], lifetime: 200, gravity: -0.0005, size: 0.18,
    drag: 0.995, colour: [0.82, 0.58, 0.75], colourJitter: 0.15,
  },
};

/** Every sprite any particle can use — the bake needs these or they sample nothing. */
export function particleSprites(): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(PARTICLES)) for (const f of spec.frames) out.add(f);
  return [...out];
}

/** One particle a block emits when it is sampled. */
export interface Emission {
  kind: ParticleKind;
  /** offset from the block's corner, in blocks */
  at: readonly [number, number, number];
  /** how far to jitter each axis, uniformly */
  jitter: number;
  /** initial velocity, blocks per tick */
  vel: readonly [number, number, number];
  /** chance this emission happens at all when the block is sampled */
  chance: number;
}

export type Emitter = (props: Record<string, string>) => readonly Emission[];

const NONE: readonly Emission[] = [];

/** A torch's flame and its wisp of smoke, at the tip where vanilla puts them. */
function torchLike(x: number, y: number, z: number): readonly Emission[] {
  return [
    { kind: 'smoke', at: [x, y, z], jitter: 0, vel: [0, 0.015, 0], chance: 1 },
    { kind: 'flame', at: [x, y, z], jitter: 0, vel: [0, 0.01, 0], chance: 1 },
  ];
}

/**
 * A wall torch leans out from the block it is on, so its flame is not at the centre.
 * `facing` is the direction the torch points AWAY from its wall.
 */
const WALL_TORCH_OFFSET: Record<string, readonly [number, number, number]> = {
  north: [0.5, 0.7, 0.73], south: [0.5, 0.7, 0.27],
  west: [0.73, 0.7, 0.5], east: [0.27, 0.7, 0.5],
};

/**
 * The emitters, keyed by EXACT block name.
 *
 * Exact rather than suffix- or namespace-matched on purpose: `somemod:torch` is not
 * `minecraft:torch` and must emit nothing rather than inheriting flame it may not have.
 */
export const EMITTERS: Record<string, Emitter> = {
  'minecraft:torch': () => torchLike(0.5, 0.7, 0.5),
  'minecraft:soul_torch': () => torchLike(0.5, 0.7, 0.5),
  'minecraft:wall_torch': (props) => {
    const at = WALL_TORCH_OFFSET[props.facing ?? 'north'];
    return at ? torchLike(at[0], at[1], at[2]) : NONE;
  },
  'minecraft:soul_wall_torch': (props) => {
    const at = WALL_TORCH_OFFSET[props.facing ?? 'north'];
    return at ? torchLike(at[0], at[1], at[2]) : NONE;
  },
  // CampfireBlock gates its plume on nextInt(10) == 0; the embers are more frequent.
  'minecraft:campfire': (props) => (props.lit === 'true' ? CAMPFIRE : NONE),
  'minecraft:soul_campfire': (props) => (props.lit === 'true' ? CAMPFIRE : NONE),
  // BubbleColumnBlock.animateTick: `if (DRAG_DOWN) CURRENT_DOWN else BUBBLE_COLUMN_UP`.
  // Read from the bytecode after a test caught this inverted — drag=true is the whirlpool
  // that pulls DOWN (a magma block below), drag=false the soul-sand column that lifts.
  'minecraft:bubble_column': (props) => (props.drag === 'true' ? BUBBLE_DOWN : BUBBLE_UP),
  'minecraft:spore_blossom': () => SPORE,
};

const CAMPFIRE: readonly Emission[] = [
  { kind: 'big_smoke', at: [0.5, 0.9, 0.5], jitter: 0.35, vel: [0, 0.07, 0], chance: 0.1 },
  { kind: 'smoke', at: [0.5, 0.7, 0.5], jitter: 0.3, vel: [0, 0.03, 0], chance: 0.4 },
];
const BUBBLE_UP: readonly Emission[] = [
  { kind: 'bubble', at: [0.5, 0.5, 0.5], jitter: 0.5, vel: [0, 0.12, 0], chance: 0.6 },
];
const BUBBLE_DOWN: readonly Emission[] = [
  { kind: 'current_down', at: [0.5, 0.5, 0.5], jitter: 0.5, vel: [0, -0.06, 0], chance: 0.6 },
];
const SPORE: readonly Emission[] = [
  { kind: 'spore', at: [0.5, 0.3, 0.5], jitter: 0.45, vel: [0, -0.008, 0], chance: 0.12 },
];

/** Every candle block emits from its flames; they are named `<colour>_candle` or `candle`. */
for (const colour of [
  '', 'white_', 'orange_', 'magenta_', 'light_blue_', 'yellow_', 'lime_', 'pink_', 'gray_',
  'light_gray_', 'cyan_', 'purple_', 'blue_', 'brown_', 'green_', 'red_', 'black_',
]) {
  EMITTERS[`minecraft:${colour}candle`] = (props) =>
    (props.lit === 'true' ? CANDLE : NONE);
}

const CANDLE: readonly Emission[] = [
  { kind: 'smoke', at: [0.5, 0.85, 0.5], jitter: 0.15, vel: [0, 0.015, 0], chance: 0.5 },
  { kind: 'small_flame', at: [0.5, 0.85, 0.5], jitter: 0.12, vel: [0, 0.008, 0], chance: 1 },
];

/** What a block emits when sampled, or nothing. Unknown and modded blocks emit nothing. */
export function emissionsFor(name: string, props: Record<string, string>): readonly Emission[] {
  return EMITTERS[name]?.(props) ?? NONE;
}

/** Whether any emitter exists for this block at all — the cheap gate for the sampler. */
export function isEmitter(name: string): boolean {
  return EMITTERS[name] !== undefined;
}
