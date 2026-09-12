/**
 * The item in a mob's hand.
 *
 * Measured before building: 30 of the live world's 801 entities carry one — 23 skeletons
 * with bows, 4 zombified piglins with golden swords, 3 pillagers with crossbows. All are in
 * the MAIN hand (0 off-hand) and all three are flat items, so they come from the item icon
 * atlas the hotbar already uses rather than from the block registry.
 *
 * THE HAND IS DERIVED FROM THE MODEL, NOT HARDCODED. Vanilla's `ItemInHandLayer` does
 * `model.translateToHand(arm)` — the arm part's own transform — and then a fixed chain:
 *
 *     mulPose(XP.rotationDegrees(-90)); mulPose(YP.rotationDegrees(180));
 *     translate(±1/16, 0.125, -0.625)
 *
 * `handOffset` replays that against whatever the extraction says the arm part is, so a
 * modded humanoid with its arm somewhere else gets its item in the right place. For the
 * vanilla humanoid (`right_arm` at [-5, 2, 0]) it works out to (0.375, 0.75, -0.125) in
 * entity-local space: 0.625 below the shoulder at 1.375, which is an arm's length.
 *
 * WHAT THIS IS NOT, stated as `held-item.ts` states it for the player. Vanilla orients the
 * item by the `thirdperson_righthand` display transform baked into each item model, and the
 * bake does not currently carry those. So the item hangs in the hand plane at a fixed
 * orientation that reads correctly rather than one derived from the model. Getting the real
 * transforms is an extension to `item-bake.ts`, and it would improve the player's held item
 * and this one together.
 */

import type { BakedQuad, Direction } from '../assets/model.js';

/** One hand's contents. `slot` is vanilla's `HandItems` order: 0 main, 1 off. */
export interface HeldItem {
  id: string;
  slot: 0 | 1;
}

/** An entity part, as much of it as this module needs. */
interface ArmPart {
  pos: readonly [number, number, number];
}

/** Everything in `HandItems` that is actually an item. */
export function heldItemsOf(nbt: Record<string, unknown>): HeldItem[] {
  const hands = nbt.HandItems;
  if (!Array.isArray(hands)) return [];
  const out: HeldItem[] = [];
  for (let i = 0; i < Math.min(2, hands.length); i++) {
    const stack = hands[i] as Record<string, unknown> | undefined;
    const id = stack && typeof stack.id === 'string' ? stack.id : null;
    if (id) out.push({ id, slot: i as 0 | 1 });
  }
  return out;
}

/** Vanilla's fixed chain after the arm, as a translation in the arm's own space. */
const IN_HAND: readonly [number, number, number] = [1 / 16, 0.125, -0.625];

/**
 * Where the item sits, in the same entity-local space `buildEntityQuads` emits into.
 *
 * Returns null when the model has no arm to hang it from, which is the right answer for a
 * spider or a bee: vanilla draws no held item for a model with no `translateToHand`.
 */
export function handOffset(
  arm: ArmPart | undefined, hand: 'right' | 'left',
  display?: readonly [number, number, number],
): [number, number, number] | null {
  if (!arm) return null;
  // Rx(-90) maps (x,y,z) -> (x, z, -y); Ry(180) maps (x,y,z) -> (-x, y, -z). The item's
  // origin is Rx * Ry * t, and the chain is applied inside the arm's space.
  //
  // The item model's own `display.translation` lives in that same hand frame and comes
  // immediately after, so — both being translations with no rotation between them — it
  // simply adds. A bow's -0.125 lifts it into the fist rather than leaving it at the wrist.
  const d = display ?? [0, 0, 0];
  const t: [number, number, number] = [
    (hand === 'left' ? -IN_HAND[0] : IN_HAND[0]) + d[0], IN_HAND[1] + d[1], IN_HAND[2] + d[2],
  ];
  const ry: [number, number, number] = [-t[0], t[1], -t[2]];
  const rx: [number, number, number] = [ry[0], ry[2], -ry[1]];
  // Into the part's space, then through the model root: translate(0,-1.5,0) + scale(-1,-1,1),
  // which entity-geometry.ts applies to every part. See its ROOT.
  const px = rx[0] + arm.pos[0] / 16;
  const py = rx[1] + arm.pos[1] / 16;
  const pz = rx[2] + arm.pos[2] / 16;
  return [-px, 1.5 - py, pz];
}

/** The arm part a hand hangs from, by the names vanilla's humanoid models use. */
export function armPartOf(
  parts: Record<string, ArmPart> | undefined, hand: 'right' | 'left',
): ArmPart | undefined {
  if (!parts) return undefined;
  return parts[hand === 'left' ? 'left_arm' : 'right_arm'];
}

/**
 * Where a held item ends up in the world, given where the mob is and which way it faces.
 *
 * The offset is in entity-local space, so it has to turn with the mob: a skeleton facing
 * north holds its bow on a different side of the world than one facing south. `yawDeg` is
 * the same angle the mob's own mesh is placed with, so the item stays in the hand exactly.
 */
export function heldItemPosition(
  mobPos: readonly [number, number, number],
  yawDeg: number,
  offset: readonly [number, number, number],
): [number, number, number] {
  const a = (yawDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    mobPos[0] + offset[0] * c + offset[2] * s,
    mobPos[1] + offset[1],
    mobPos[2] - offset[0] * s + offset[2] * c,
  ];
}
