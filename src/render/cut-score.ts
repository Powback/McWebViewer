/**
 * HOW BAD A CANDIDATE CUT PLANE IS, counted rather than judged.
 *
 * The cast picks a plane from where the walls are. That answers "is the wall cut" and not "does the
 * result look right", and the two come apart constantly: "auto says cut 9, but that leaves a bunch of
 * floating shit in my view... If I move it to cut 6.3 then the annoying floaters are minimized... But
 * it really depends on the viewing angle" (the user, 2026-09-11).
 *
 * A FLOATER IS NOT AN AESTHETIC, IT IS THE VOID CASE, and along a ray it has an exact test. The cut
 * removes everything between the camera and the plane, so what you see at the plane is whatever the
 * plane lands on:
 *
 *   air                              you see into the room. Good.
 *   solid, with AIR just outside it  you see a real wall face, one the mesher built. Good.
 *   solid, with SOLID just outside   that face is between two solid blocks, so the mesher never
 *                                    built it. You see the void. THIS is the floater.
 *
 * So the score is "how many of my rays end up buried inside rock", and minimising it means "put the
 * plane in the air gap" -- which is exactly the 6.3-not-9 the user found by hand.
 *
 * WHY THIS IS A SEARCH AND NOT A CONTROLLER. A PID regulates towards a setpoint on a smooth plant.
 * There is no setpoint here -- the target is an argmin -- and the objective is piecewise constant,
 * changing only when the plane crosses a block boundary. On that landscape a controller hunts, or
 * settles into whichever local basin it started in, which is the viewing-angle instability being
 * complained about. Scoring candidates and taking the best is gradient-free and cannot hunt. The
 * part of the intuition that IS right is the temporal half, and that is `easeBias` plus the
 * hysteresis below, not a derivative term.
 */

/** Whether a cell is open -- the same predicate the ceiling map and the cast take. */
export type OpenTest = (x: number, y: number, z: number) => boolean;

/** One direction to sample, as a horizontal unit vector. */
export interface Ray {
  dx: number;
  dz: number;
}

/**
 * Rays whose cut lands buried inside solid matter, for one candidate plane.
 *
 * `planeAt` is the distance along each ray, in blocks, at which the plane sits -- the horizontal
 * distance, matching the rays, not the view depth. The caller converts.
 */
export function cutScore(
  isOpen: OpenTest,
  from: readonly [number, number, number],
  rays: readonly Ray[],
  planeAt: number,
): number {
  let bad = 0;
  for (const r of rays) {
    // The block the plane lands on, and the one just OUTSIDE it -- the last block the cut removed.
    const inX = Math.floor(from[0] + r.dx * planeAt);
    const inZ = Math.floor(from[2] + r.dz * planeAt);
    const outX = Math.floor(from[0] + r.dx * (planeAt + 1));
    const outZ = Math.floor(from[2] + r.dz * (planeAt + 1));
    const y = Math.floor(from[1]);
    // Air at the plane is the good case and needs no further thought: you are looking into a room.
    if (isOpen(inX, y, inZ)) continue;
    // Solid at the plane is fine too, PROVIDED the block the cut took was air -- then the face you
    // are looking at is one that faced air, so the mesher built it.
    if (isOpen(outX, y, outZ)) continue;
    bad++;
  }
  return bad;
}

/** A scored candidate. `bias` is in the same units the caller asked about. */
export interface Candidate {
  bias: number;
  score: number;
}

/**
 * The best plane among candidates: fewest floaters, and among equals the one that reveals most.
 *
 * REVEALING MORE MEANS A SMALLER BIAS. The plane sits at `subjectViewZ - bias`, so raising the bias
 * pulls it towards the camera and spares more; a tie between two artifact-free planes should go to
 * the one that takes more away, or the search would happily pick a plane so near the camera that it
 * cuts nothing and scores a perfect zero.
 */
export function bestCandidate(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best || c.score < best.score || (c.score === best.score && c.bias < best.bias)) best = c;
  }
  return best;
}

/**
 * Should the search's new answer replace the one in use?
 *
 * HYSTERESIS, because the objective is a step function and two neighbouring candidates are often
 * one ray apart. Without a margin the plane would flip between them as the camera turns, which is
 * the twitch this whole mechanism exists to remove. A new answer has to be better by more than a
 * ray, or differ enough in distance to be worth the move.
 */
export function shouldAdopt(
  current: Candidate | null,
  next: Candidate,
  margin = 1,
): boolean {
  if (!current) return true;
  // STRICTLY better by more than the margin: at margin 1 a one-ray gain is noise and a
  // two-ray gain is signal. `<=` here would adopt on the one-ray gain and reintroduce the flip.
  if (next.score + margin < current.score) return true;
  // Equally good and materially closer to the character: take it, so the plane keeps creeping in
  // to reveal more rather than sticking wherever it first landed.
  return next.score <= current.score && next.bias < current.bias - 0.5;
}
