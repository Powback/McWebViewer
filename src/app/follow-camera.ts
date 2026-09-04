/**
 * Pointing the fly camera at a player, and keeping it there.
 *
 * Two separate things, and conflating them is what makes "follow" features unusable:
 *
 *  - the SNAP places the camera behind and above the player once, when you pick them;
 *  - the LOCK adds the player's per-frame movement to wherever the camera has since got to.
 *
 * Keeping them separate is what leaves the ordinary controls working. The lock only ever
 * TRANSLATES by a delta, so mouse-look still turns, WASD still moves you relative to the
 * player, and the wheel still changes speed — you are flying alongside them, not riding a
 * rail. A follow that rebuilt the camera transform every frame would silently eat every one
 * of those inputs, which presents as "the mouse stopped working".
 *
 * Kept out of live-view.ts because it is arithmetic and live-view.ts cannot be imported
 * without a DOM.
 */

/** How far behind the player the snap puts the camera, in blocks. */
export const FOLLOW_DIST = 9;
/** And how far above their feet, so the view looks down at them rather than at their knees. */
export const FOLLOW_HEIGHT = 4;

/**
 * Where to put the camera to see a player from behind.
 *
 * `yawDeg` is the RENDERED heading — `entityYawDeg(mcYaw)`, i.e. `180 - mcYaw` — because
 * that is what the tracker carries and what the model is rotated by. Minecraft's own facing
 * for a raw yaw `Y` is `(-sin Y, cos Y)`, so this inverts the 180 first. Getting that
 * inversion wrong puts the camera in front of the player looking at their back, which is
 * the same 180 degrees this codebase has now got wrong twice (see ARCHITECTURE.md §7) — so
 * it is asserted as a direction vector in the tests, never as a number.
 */
export function followPlacement(
  pos: readonly [number, number, number],
  yawDeg: number,
  dist = FOLLOW_DIST,
  height = FOLLOW_HEIGHT,
): [number, number, number] {
  const mcYaw = ((180 - yawDeg) * Math.PI) / 180;
  const facing: [number, number] = [-Math.sin(mcYaw), Math.cos(mcYaw)];
  return [
    pos[0] - facing[0] * dist,
    pos[1] + height,
    pos[2] - facing[1] * dist,
  ];
}

/**
 * The next player to follow, given who is on screen and who is followed now.
 *
 * Cycles in the order given and then falls off the end to null, so the same key that starts
 * following also stops it. A follow you cannot leave by the key that started it is a trap,
 * and on a locked pointer there may be no button to click instead.
 */
export function nextFollowed(names: readonly string[], current: string | null): string | null {
  if (!names.length) return null;
  if (current === null) return names[0];
  const i = names.indexOf(current);
  // Following somebody who has since logged out: start again rather than stop, because the
  // user asked to follow SOMEBODY and the roster has simply moved on underneath them.
  if (i < 0) return names[0];
  return i + 1 < names.length ? names[i + 1] : null;
}
