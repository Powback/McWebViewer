/**
 * Generic entity animation, driven by part NAMES.
 *
 * WHY THIS IS AN APPROXIMATION, SAID UP FRONT. Vanilla animates a mob in
 * `EntityModel.setupAnim` — compiled Java, one implementation per model, with per-mob
 * constants and special cases. Unlike the model GEOMETRY (which is declarative data the
 * harness extracts exactly), `setupAnim` cannot be read out of the jar as data. So this is
 * not vanilla's curve; it is a generic limb swing applied by part name.
 *
 * That is a deliberate trade and worth being clear about: the alternative to an
 * approximation here is what the viewer had before, which is nothing — every mob frozen in
 * bind pose, a spider with horizontal legs, a cow sliding across the ground with rigid
 * limbs. "Legs swing roughly right when walking" reads as alive; "legs never move" reads as
 * broken. What it must never do is claim to be exact, so the naming and this comment say so.
 *
 * The part names come from vanilla's own `PartDefinition` keys, which every mod copies
 * because `LayerDefinition` is built the same way everywhere — `head`, `body`, `leg0`..`leg3`,
 * `right_arm`, `left_leg`, `wing`, `tail`. That is why matching on names is generic across
 * mods rather than a per-mob table: the harness already proved the same assumption when it
 * extracted 426 models, modded mobs included, by walking those same trees.
 */

/** What a part does when the body moves. */
export type PartRole =
  /** tracks where the entity is looking */
  | 'head'
  /** swings fore-and-aft with the gait */
  | 'limb'
  /** swings in opposition to `limb`, so arms and legs are not in phase */
  | 'limbOpposed'
  /** flaps continuously while airborne */
  | 'wing'
  /** does not move */
  | 'static';

/**
 * The limbs that swing in ANTI-PHASE with the rest.
 *
 * A quadruped's diagonal pairs and a biped's opposite arm/leg move together, so only one
 * side of each pair needs naming — anything else that is a limb takes the base phase. Only
 * this set is listed because a name not in it still animates, just on the other beat.
 */
const FRONT_RIGHT = /(^|_)(leg1|right_leg|right_front_leg|front_right_leg|left_arm|leg3)($|_)/;

const HEAD = /(^|_)(head|head2|real_head|neck)($|_)/;
const LIMB = /(^|_)(leg|leg0|leg1|leg2|leg3|arm|left_leg|right_leg|left_arm|right_arm|front_leg|back_leg|hind_leg|thigh)($|_)/;
const WING = /(^|_)(wing|left_wing|right_wing|wing_base|wing_tip)($|_)/;

/**
 * Classify a part by its name.
 *
 * Unknown names are `static`, which is the safe direction: a part this does not recognise
 * stays exactly where the extracted geometry put it, so the worst case is the bind pose it
 * already had rather than a limb rotating through the body.
 */
export function classifyPart(name: string): PartRole {
  const n = name.toLowerCase();
  if (HEAD.test(n)) return 'head';
  if (WING.test(n)) return 'wing';
  if (LIMB.test(n)) return FRONT_RIGHT.test(n) ? 'limbOpposed' : 'limb';
  return 'static';
}

/** How fast a mob has to move before its legs swing at full amplitude, in blocks/second. */
const FULL_SWING_SPEED = 4;
/** Radians. A walking mob's legs sweep about this far either side of vertical. */
const MAX_SWING = 0.9;
/** How fast the gait cycles, in radians per block travelled. */
const GAIT_PER_BLOCK = 2.6;
/** Wings beat on their own clock, not on distance travelled. */
const WING_HZ = 6;
const WING_AMPLITUDE = 0.7;

export interface MotionState {
  /** horizontal speed, blocks/second */
  speed: number;
  /** total horizontal distance travelled, blocks — drives gait PHASE */
  distance: number;
  /** seconds, for things that beat on a clock rather than on distance */
  time: number;
  /** head yaw relative to the body, degrees */
  headYawDeg: number;
  /** head pitch, degrees, positive looking down (Minecraft's convention) */
  pitchDeg: number;
  /** true when the entity is not on the ground */
  airborne: boolean;
}

/** An extra rotation to apply to a part, in radians, about its own pivot. */
export interface PartRotation {
  x: number;
  y: number;
  z: number;
}

export const NO_ROTATION: PartRotation = { x: 0, y: 0, z: 0 };

/**
 * The rotation to add to one part this frame.
 *
 * Gait phase is driven by DISTANCE TRAVELLED rather than by elapsed time, which is what
 * stops the legs from cycling while the mob stands still and makes a slow walk take slow
 * steps instead of fast small ones. Amplitude scales with speed, so a mob that stops
 * settles back to bind pose rather than freezing mid-stride.
 */
export function partRotation(role: PartRole, m: MotionState): PartRotation {
  switch (role) {
    case 'head':
      return {
        // Minecraft's pitch is positive downward and the model's X rotation matches.
        x: (m.pitchDeg * Math.PI) / 180,
        y: (wrapDegrees(m.headYawDeg) * Math.PI) / 180,
        z: 0,
      };
    case 'limb':
      return { x: swing(m, 0), y: 0, z: 0 };
    case 'limbOpposed':
      return { x: swing(m, Math.PI), y: 0, z: 0 };
    case 'wing':
      return m.airborne
        ? { x: 0, y: 0, z: Math.sin(m.time * WING_HZ * Math.PI * 2) * WING_AMPLITUDE }
        : NO_ROTATION;
    default:
      return NO_ROTATION;
  }
}

function swing(m: MotionState, phase: number): number {
  const amount = Math.min(1, m.speed / FULL_SWING_SPEED);
  if (amount <= 0.001) return 0;
  return Math.cos(m.distance * GAIT_PER_BLOCK + phase) * MAX_SWING * amount;
}

/**
 * Fold an angle into -180..180.
 *
 * A head yaw that arrives as 350 must read as -10, or the head spins the long way round
 * every time the body crosses north — which is very visible and very silly.
 */
export function wrapDegrees(deg: number): number {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Track one entity's motion across frames so the gait has a phase.
 *
 * Distance accumulates from actual movement, so it is continuous even when the position
 * stream is bursty — which matters here because positions arrive at packet rate from
 * SpacetimeDB and at flush rate from the save files, and the animation must look the same
 * either way.
 */
export class MotionTracker {
  private last: { pos: readonly [number, number, number]; at: number } | null = null;
  private distance = 0;
  private speed = 0;

  /** Fold in a new position. `at` is a local clock in milliseconds. */
  update(pos: readonly [number, number, number], at: number): void {
    const prev = this.last;
    this.last = { pos: [pos[0], pos[1], pos[2]], at };
    if (!prev) return;
    const dt = (at - prev.at) / 1000;
    if (dt <= 0 || dt > 1) return; // a long gap is a teleport or a stall, not a stride
    const moved = Math.hypot(pos[0] - prev.pos[0], pos[2] - prev.pos[2]);
    // A single frame's jump beyond this is a resync, not locomotion: counting it would
    // spin the legs wildly for one frame.
    if (moved > 4) return;
    this.distance += moved;
    // Smoothed, so one still frame between two moving ones does not drop the legs.
    this.speed += (moved / dt - this.speed) * Math.min(1, dt * 6);
  }

  state(time: number, headYawDeg: number, pitchDeg: number, airborne = false): MotionState {
    return {
      speed: this.speed,
      distance: this.distance,
      time,
      headYawDeg,
      pitchDeg,
      airborne,
    };
  }
}
