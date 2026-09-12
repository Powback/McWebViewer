/**
 * The real movement constants and the real block collision shapes, out of the game.
 *
 * Produced by `harness/src/mcextract/ExtractPhysics.java`, which boots the actual
 * deobfuscated client far enough for the block registry to be live and then ASKS it —
 * `state.getCollisionShape(...)`, `state.getDestroySpeed(...)`, and the player's attribute
 * defaults. Nothing in this file is a number anybody typed from memory. See
 * PARITY-AUDIT.md §8 and the harness's own class comment for why that mattered.
 *
 * WHAT THE EXTRACTION ACTUALLY SAID (1.21.1), because the surprises are worth recording:
 *
 *   gravity        0.08  blocks/tick²
 *   jumpStrength   0.42  blocks/tick
 *   stepHeight     0.6   blocks      — so slabs and stair treads are stepped, not jumped
 *   sneakingSpeed  0.3               — a multiplier
 *   sprintModifier 0.3 ADD_MULTIPLIED_TOTAL   — i.e. ×1.3, not +0.3. The operation is
 *                                     carried in the data precisely so the client does not
 *                                     have to guess which of those two it is.
 *   width 0.6, height 1.8, eyeHeight 1.62
 *   blockInteractionRange 4.5        — NOT 5. The existing raycast uses 5 (live-controls.ts
 *                                     `raycast(maxDist = 5)`), so the crosshair currently
 *                                     targets blocks half a block further than the server
 *                                     will accept.
 *
 * AND THE ONE THAT IS NOT USABLE AS-IS: `movementSpeed` is 0.1, which is an ATTRIBUTE, not
 * a ground speed. Vanilla runs it through `LivingEntity.getFrictionInfluencedSpeed`, where
 * block friction, sprinting and being airborne all fold in before anything moves. 0.1 × 20
 * is 2 blocks/s and a player plainly walks faster than that. So horizontal speed is still
 * MEASURED from the server's own reports (see predict.ts `observe`) rather than computed
 * from this — the extraction is what tells us the multipliers around it are ×1.3 and ×0.3.
 */

/** Vanilla ticks per second. The one place per-tick constants become per-second. */
export const TPS = 20;

/**
 * A starting guess for walking speed, in blocks/second, replaced by measurement within
 * about a second of walking. Not treated as truth anywhere.
 *
 * IT LIVES HERE RATHER THAN IN predict.ts because two things now need it and they must not
 * disagree: the predictor seeds its measured speed from it, and the path planner works out
 * how far a jump carries the body from it. A planner that thinks the body is faster than it
 * is plans a jump into a hole.
 */
export const SEED_SPEED = 4.3;

export interface PlayerPhysics {
  movementSpeed: number;
  gravity: number;
  jumpStrength: number;
  stepHeight: number;
  sneakingSpeed: number;
  blockBreakSpeed: number;
  blockInteractionRange: number;
  width: number;
  height: number;
  eyeHeight: number;
  crouchHeight: number;
  sprintModifier?: number;
  sprintOperation?: string;
  /**
   * Which `Inventory` slot number is the off hand.
   *
   * `data get entity <name> Inventory` returns every compartment in ONE list keyed by slot,
   * so this is the only way to tell the off hand from a hotbar slot — and it is a Java
   * constant (`Inventory.SLOT_OFFHAND`), not something the NBT labels. Extracted; 40 here.
   */
  offhandSlot?: number;
}

/** `[x0, y0, z0, x1, y1, z1]` in block-local coordinates. */
export type Box = readonly [number, number, number, number, number, number];

export interface StateInfo {
  /** index into `shapes` */
  s: number;
  /** destroy time; -1 is vanilla's "unbreakable" */
  h: number;
}

export interface PhysicsData {
  version: string;
  player: PlayerPhysics;
  shapes: Box[][];
  blocks: Record<string, StateInfo>;
  stats: Record<string, number>;
  notes: string[];
}

/**
 * The constants the predictor actually runs on, already converted out of tick units.
 *
 * Kept separate from the raw file so that the conversion happens exactly once and every
 * consumer sees seconds. Mixing tick units and second units in a physics integrator is a
 * bug that looks like "the jump feels wrong" rather than like a bug.
 */
export interface MotionConstants {
  /** blocks/s² */
  gravity: number;
  /** blocks/s, initial upward speed of a jump */
  jumpSpeed: number;
  stepHeight: number;
  halfWidth: number;
  height: number;
  eyeHeight: number;
  sneakMultiplier: number;
  sprintMultiplier: number;
  reach: number;
  /** false when this came from the fallbacks below rather than from the extraction */
  measured: boolean;
}

/**
 * Used only when `physics.json` has not been baked yet.
 *
 * These are the pre-extraction guesses, kept so the viewer still moves on a checkout that
 * has not run the harness — but `measured: false` travels with them so the HUD can say the
 * numbers are guesses rather than quietly presenting them as the game's.
 */
export const FALLBACK_MOTION: MotionConstants = {
  gravity: 32,
  jumpSpeed: 8.4,
  stepHeight: 0.6,
  halfWidth: 0.3,
  height: 1.8,
  eyeHeight: 1.62,
  sneakMultiplier: 0.3,
  sprintMultiplier: 1.3,
  reach: 4.5,
  measured: false,
};

/**
 * Fold the extracted player attributes into the integrator's units.
 *
 * `sprintOperation` is honoured rather than assumed. `ADD_MULTIPLIED_TOTAL` — what 1.21.1
 * actually uses — means ×(1 + amount), so 0.3 is ×1.3. Any OTHER operation is not silently
 * reinterpreted as that one: an `ADD_VALUE` sprint modifier would be an absolute addition
 * to an attribute whose relationship to ground speed this client does not model, so the
 * honest answer is to fall back rather than to compute something plausible and wrong.
 */
export function motionFrom(player: PlayerPhysics): MotionConstants {
  const sprint = player.sprintModifier;
  const multiplied = player.sprintOperation === 'ADD_MULTIPLIED_TOTAL';
  const sprintMultiplier = sprint !== undefined && multiplied
    ? 1 + sprint
    : FALLBACK_MOTION.sprintMultiplier;
  return {
    gravity: player.gravity * TPS * TPS,
    jumpSpeed: player.jumpStrength * TPS,
    stepHeight: player.stepHeight,
    halfWidth: player.width / 2,
    height: player.height,
    eyeHeight: player.eyeHeight,
    sneakMultiplier: player.sneakingSpeed,
    sprintMultiplier,
    reach: player.blockInteractionRange,
    measured: true,
  };
}

/**
 * Fetch the baked table. Returns null rather than throwing: a viewer with no physics table
 * still works, it just falls back, and that is a degradation to report and not a crash.
 */
export async function loadPhysics(url = 'physics.json'): Promise<PhysicsData | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as PhysicsData;
    if (!data || typeof data !== 'object' || !data.player || !Array.isArray(data.shapes)) return null;
    return data;
  } catch {
    return null;
  }
}
