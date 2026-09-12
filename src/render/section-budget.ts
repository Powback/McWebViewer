/**
 * WHICH SECTIONS ARE WORTH KEEPING IN MEMORY.
 *
 * THE BUG THIS EXISTS FOR. The viewer meshed every section within MESH_RADIUS (256 blocks)
 * and then never let go of one until it was 640 blocks away — a radius the camera reaches
 * only by flying there, so in practice nothing was ever freed. Sitting still at the world
 * spawn for 45 seconds, measured against the deployed page on 2026-09-11:
 *
 *     6032 section meshes resident
 *      883 MB of geometry attribute arrays
 *     1040 MB JS heap
 *
 * and still climbing, because the meshing queue had not drained. That is the "it keeps
 * growing tris and then the tab crashes and reloads" the user reported: a renderer-process
 * OOM, reached in under a minute without the camera moving at all.
 *
 * Three quarters of that was BEHIND THE CAMERA. The same measurement, bucketed by angle to
 * the view axis (sections within 112 blocks counted as in view whatever their angle):
 *
 *     60 deg half-angle   2613 sections   466 MB
 *     90 deg half-angle   3607 sections   576 MB
 *    120 deg half-angle   4823 sections   719 MB
 *    everything           6032 sections   883 MB
 *
 * three.js was already frustum-culling all of it correctly (2724 of 9384 meshes passed the
 * frustum test, and the bounding spheres are right) — it was drawn cheaply and PAID FOR IN
 * FULL. Culling decides what is drawn; this decides what exists.
 *
 * So the policy is: a section is kept if it is near enough that turning round must not
 * cost a re-mesh, or if it is inside a cone generously wider than the view frustum. On top
 * of that sits a hard byte ceiling, because a policy expressed in angles and distances
 * still has no idea how much geometry a particular view contains — a cave system or a
 * settlement is many times the quads of the same volume of hillside — and the ceiling is
 * the only part of this that can promise the tab will not die.
 *
 * Pure functions over plain records, so the whole policy is exercised in tests without a
 * WebGL context; `Viewer.retain()` is the thin part that applies the answer.
 */

/** Half the diagonal of a 16-block section: how far its corners reach past its centre. */
export const SECTION_HALF_DIAGONAL = 13.9;

/**
 * Sections this close to the camera are kept whatever direction it faces.
 *
 * Without it, spinning on the spot would dispose and re-mesh the room you are standing in,
 * which is the one place a re-mesh is guaranteed to be visible. 112 blocks is seven
 * sections out — comfortably past anything a turn brings into view before the mesher has
 * caught up, and only ~1000 of the 6032 sections above.
 */
export const KEEP_NEAR = 112;

/**
 * Half-angle of the cone a far section must be inside to be MESHED, and to be KEPT.
 *
 * The camera is 70 degrees vertical at ~16:10, so its diagonal half-angle is about 55. The
 * mesh cone is wider than that so geometry exists slightly before it is needed, and the
 * keep cone is wider again so that the two never disagree about a section on the boundary —
 * without the gap, a section meshed this frame could be evicted the next and re-meshed the
 * one after, for ever.
 */
export const MESH_CONE_DEG = 70;
export const KEEP_CONE_DEG = 80;

/**
 * Hard ceiling on resident section geometry, in bytes.
 *
 * 448 MB, against the 883 MB that crashed the tab and the ~466 MB the cone alone leaves at
 * the spawn view. It is meant to be slack in ordinary play and to bite only where the cone
 * is not enough — standing in the middle of the settlement looking down a mined-out shaft,
 * where one cone's worth of world is several times the quads of the same cone of hillside.
 *
 * Counted from the attribute and index arrays as built, NOT from what is still held in JS:
 * `Viewer` releases each array once the GPU has it, so a figure read back off the live
 * arrays would say a section costs nothing the moment it is drawn — which is the opposite
 * of true. The GPU copy is the one that has to fit.
 */
export const MAX_SECTION_BYTES = 448 * 1024 * 1024;

/** One resident section, as the policy sees it. */
export interface SectionRecord {
  key: string;
  /** world-space centre of the 16^3 section */
  centre: readonly [number, number, number];
  /** attribute + index bytes of every layer of this section */
  bytes: number;
}

export interface ViewPoint {
  eye: readonly [number, number, number];
  /** unit vector the camera looks along */
  forward: readonly [number, number, number];
}

export interface KeepOptions {
  near: number;
  coneDeg: number;
  /** nothing beyond this is kept, whatever direction it is in */
  far: number;
  /**
   * Whether the cone applies at all.
   *
   * TRUE FOR MESHING, FALSE FOR RETENTION, and that asymmetry is the whole point. Not building
   * geometry you cannot see is free; THROWING AWAY geometry you cannot see costs you the rebuild
   * the moment you turn back, which in an isometric view is constantly.
   */
  cone: boolean;
}

/**
 * Retention. THE CONE STAYS, and removing it was a measured mistake worth recording.
 *
 * Retention was switched to distance-only to stop rotation evicting everything behind the camera
 * ("you are killing my fps man reloading these things all the fucking time"). That diagnosis was
 * right and the cure was far worse than the disease: keeping every section within `far` in EVERY
 * direction is a 640-block SPHERE, which is on the order of a hundred times the sections a cone
 * holds. The byte ceiling then bites on every frame instead of never, so the viewer swapped a
 * re-mesh on rotation for a permanent eviction-and-recycle churn -- "the map keeps growing until
 * it crashes and reinitializes every few seconds... the fps drops like crazy" (the user, the same
 * evening, twenty minutes later).
 *
 * The anti-thrash fix belongs in WHEN a section may be dropped, not in WHICH ones qualify: a
 * grace period, so a section that leaves the cone survives a quick look around and is only
 * disposed if the camera stays away from it.
 */
export const DEFAULT_KEEP: KeepOptions = {
  near: KEEP_NEAR,
  coneDeg: KEEP_CONE_DEG,
  far: 640,
  cone: true,
};

/** Meshing: build what is in front of you first. */
export const DEFAULT_MESH: KeepOptions = {
  near: KEEP_NEAR,
  coneDeg: MESH_CONE_DEG,
  far: 640,
  cone: true,
};

/**
 * Is any part of the section at `centre` inside the cone?
 *
 * The section is treated as a SPHERE of SECTION_HALF_DIAGONAL, not as its centre point:
 * a section whose centre is just outside the cone can still have a corner well inside it,
 * and a centre-only test pops that corner in and out as the camera turns. The widening is
 * `asin(r / d)` — the half-angle the sphere subtends from the eye — which is exact for the
 * sphere and conservative for the box inside it.
 *
 * Everything within `near` is in view by definition; see KEEP_NEAR.
 */
export function inViewCone(
  centre: readonly [number, number, number],
  view: ViewPoint,
  coneDeg: number,
  near = KEEP_NEAR,
): boolean {
  const dx = centre[0] - view.eye[0];
  const dy = centre[1] - view.eye[1];
  const dz = centre[2] - view.eye[2];
  const d = Math.hypot(dx, dy, dz);
  if (d <= near) return true;
  const cos = (dx * view.forward[0] + dy * view.forward[1] + dz * view.forward[2]) / d;
  const widen = Math.asin(Math.min(1, SECTION_HALF_DIAGONAL / d));
  const limit = (coneDeg * Math.PI) / 180 + widen;
  return limit >= Math.PI || cos >= Math.cos(limit);
}

/** Distance from the eye to the nearest point of the section's bounding sphere, floored at 0. */
export function sectionDistance(
  centre: readonly [number, number, number],
  eye: readonly [number, number, number],
): number {
  const dx = centre[0] - eye[0];
  const dy = centre[1] - eye[1];
  const dz = centre[2] - eye[2];
  return Math.max(0, Math.hypot(dx, dy, dz) - SECTION_HALF_DIAGONAL);
}

/** Should this section be meshed / kept at all, ignoring the byte ceiling? */
export function shouldKeep(
  centre: readonly [number, number, number],
  view: ViewPoint,
  opts: KeepOptions,
): boolean {
  // DISTANCE ONLY. THE CONE DECIDES WHAT TO BUILD, NEVER WHAT TO THROW AWAY.
  //
  // Retention used to require a far section to be inside the keep cone, which makes turning the
  // camera an eviction: everything behind you is disposed, and turning back re-meshes all of it.
  // In the isometric view, where rotating is how you look at anything, that is continuous —
  // "the culling shouldnt completely unload the chunks you are killing my fps man reloading these
  // things all the fucking time" (the user, 2026-09-11).
  //
  // The memory ceiling is not lost by this: `planRetention` still enforces `maxBytes`, and
  // `evictionScore` still pushes out-of-cone sections past every in-cone one, so when the budget
  // does bite it eats the periphery first. The difference is that it bites on MEMORY PRESSURE
  // rather than on every turn of the head, which is what makes it a budget instead of a treadmill.
  const d = sectionDistance(centre, view.eye);
  if (d > opts.far) return false;
  if (!opts.cone) return true;
  if (d <= opts.near) return true;
  return inViewCone(centre, view, opts.coneDeg, opts.near);
}

/**
 * How bad a section is to keep: bigger is dropped first.
 *
 * Distance alone is not enough. Two sections the same distance away, one down the middle of
 * the screen and one at the edge of the cone, are worth very different amounts to the
 * picture, and a pure distance ordering evicts them in whatever order the Map happened to
 * hold them. `2 - cos` scales distance by how far off the view axis the section sits: on
 * axis it is the distance itself, at a right angle it is twice it, straight behind three
 * times. An out-of-cone section is pushed past every in-cone one outright, because it is of
 * no use to the picture at any distance.
 */
export function evictionScore(
  centre: readonly [number, number, number],
  view: ViewPoint,
  opts: KeepOptions,
  d = sectionDistance(centre, view.eye),
): number {
  const dx = centre[0] - view.eye[0];
  const dy = centre[1] - view.eye[1];
  const dz = centre[2] - view.eye[2];
  const len = Math.hypot(dx, dy, dz);
  const cos = len > 0
    ? (dx * view.forward[0] + dy * view.forward[1] + dz * view.forward[2]) / len
    : 1;
  const outside = d > opts.near && !inViewCone(centre, view, opts.coneDeg, opts.near);
  // `far * 4` rather than `far`: the in-cone scores reach 3x distance, so a plain `far`
  // would let a far in-cone section outscore a near out-of-cone one and be evicted first.
  return d * (2 - cos) + (outside ? opts.far * 4 : 0);
}

export interface RetentionPlan {
  /** keys to dispose, worst first */
  drop: string[];
  /** bytes still resident once they are gone */
  keptBytes: number;
  /** how many of the drops were forced by the byte ceiling rather than by the cone */
  overBudget: number;
}

/**
 * Which resident sections to let go of this frame.
 *
 * Two passes, in this order and not the other way round:
 *
 *  1. anything the keep policy rejects — behind the camera and far, or past `far`;
 *  2. then, only if the survivors still exceed `maxBytes`, the worst-scoring of THOSE.
 *
 * The score is distance from the eye, with everything outside the cone pushed past
 * everything inside it, so the ceiling eats the periphery before it eats the view. Sorting
 * only happens when the ceiling is actually breached — in ordinary play pass 1 is the whole
 * of it and this is a single linear walk.
 */
export function planRetention(
  records: Iterable<SectionRecord>,
  view: ViewPoint,
  opts: KeepOptions = DEFAULT_KEEP,
  maxBytes = MAX_SECTION_BYTES,
): RetentionPlan {
  const drop: string[] = [];
  const survivors: Array<{ key: string; bytes: number; score: number }> = [];
  let keptBytes = 0;
  for (const r of records) {
    const d = sectionDistance(r.centre, view.eye);
    if (!shouldKeep(r.centre, view, opts)) {
      drop.push(r.key);
      continue;
    }
    keptBytes += r.bytes;
    survivors.push({ key: r.key, bytes: r.bytes, score: evictionScore(r.centre, view, opts, d) });
  }
  let overBudget = 0;
  if (keptBytes > maxBytes) {
    survivors.sort((a, b) => b.score - a.score);
    for (const s of survivors) {
      if (keptBytes <= maxBytes) break;
      drop.push(s.key);
      keptBytes -= s.bytes;
      overBudget++;
    }
  }
  return { drop, keptBytes, overBudget };
}

/** The score of the worst section in `records`; 0 for none. See `evictionScore`. */
export function worstScoreOf(
  records: Iterable<SectionRecord>,
  view: ViewPoint,
  opts: KeepOptions,
): number {
  let worst = 0;
  for (const r of records) {
    const s = evictionScore(r.centre, view, opts);
    if (s > worst) worst = s;
  }
  return worst;
}

/**
 * How much a section must beat the worst resident one by before it is worth the trade.
 *
 * Without a margin two sections of nearly equal score take turns evicting each other every
 * frame: A is built, which makes B the worst, so B goes; next frame B is queued again and A
 * is now the worst. 96 blocks is wide enough that no such pair exists.
 */
export const RECYCLE_MARGIN = 96;

/**
 * Whether to hand a slice of the ceiling back so a waiting section can be built.
 *
 * THE DEADLOCK THIS BREAKS. The mesher stops at the ceiling and the retention pass trims
 * only what is OVER it, so once the budget is full of the geometry the camera first looked
 * at, nothing can ever be built again: turn ninety degrees and the new direction stays
 * empty for ever, with thousands of sections queued and no way to pay for them. Measured
 * while spinning on the spot: 2328 sections resident, zero dropped, `queued` climbing to
 * 3322, and the picture emptying to 236k triangles at the angles that were never built.
 *
 * The trade is allowed only when the best thing WAITING is clearly worth more to the
 * picture than the worst thing RESIDENT. That is what keeps it from becoming the treadmill
 * the user complained about: at rest, the queue's leftovers are worth less than what is on
 * screen, no trade is worth making, and nothing is disposed at all.
 */
export function shouldRecycle(
  candidate: readonly [number, number, number],
  view: ViewPoint,
  opts: KeepOptions,
  worstResident: number,
  margin = RECYCLE_MARGIN,
): boolean {
  return evictionScore(candidate, view, opts) + margin < worstResident;
}
