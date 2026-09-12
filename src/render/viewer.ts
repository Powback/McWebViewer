/**
 * three.js renderer.
 *
 * One BufferGeometry per (section, layer). Sections are 16^3 rather than full columns
 * so frustum culling has something useful to reject — a 24-section column is almost
 * always partly on screen, whereas individual sections cull well.
 *
 * Materials: three shared materials, differing only in transparency/alphaTest, so all
 * solid geometry batches against one material and three.js can sort by it.
 */

import * as THREE from 'three';
import { stillAnim } from './mesher.js';
import type { Layer, SectionMesh } from './mesher.js';
import type { TextureAtlas } from './atlas.js';
import {
  CEILING_GLSL, CEIL_SIZE, buildCeilingMap, ceilingAt,
  type CeilingMap, type OpenTest,
} from './ceiling-map.js';
import { buildRoomMap } from './room-map.js';
import {
  bestCandidate, cutScore, shouldAdopt, type Candidate, type Ray,
} from './cut-score.js';
import {
  DEFAULT_KEEP, MAX_SECTION_BYTES, SECTION_HALF_DIAGONAL, planRetention, worstScoreOf,
  type KeepOptions, type SectionRecord, type ViewPoint,
} from './section-budget.js';

import { SectionStore } from './section-store.js';

export {
  DEFAULT_KEEP, DEFAULT_MESH, KEEP_CONE_DEG, KEEP_NEAR, MAX_SECTION_BYTES, MESH_CONE_DEG,
  planRetention, shouldKeep, shouldRecycle, worstScoreOf,
} from './section-budget.js';

/**
 * A vertex attribute, with `normalized` derived from the array's own type.
 *
 * Section geometry ships narrowed attributes -- int8 normals, uint16 uvs, uint8 colours -- and the
 * GPU has to be told to map those integer ranges back onto -1..1 and 0..1. Entity geometry is still
 * built as float32 and must NOT be normalized, or every entity turns black: 1.0 read as a raw float
 * through a normalized path is nonsense. Deriving the flag from the array removes the chance of
 * pairing them wrongly, which is a mistake that shows up as a rendering artifact rather than an
 * error.
 */
function vertexAttr(
  array: Float32Array | Int8Array | Uint8Array | Uint16Array,
  itemSize: number,
): THREE.BufferAttribute {
  return new THREE.BufferAttribute(array, itemSize, !(array instanceof Float32Array));
}

/** Which reveal the isometric view uses. See `setRevealMode`. */
export type RevealMode = 'cutaway' | 'room' | 'box';

/**
 * BOX MODE's half-extent in blocks: 4 gives the 8x8 the user asked for.
 *
 * The box is centred on the character horizontally and runs from their FEET up by twice this, so
 * 4 is an 8x8 footprint and 8 blocks of headroom -- enough for a two-storey interior without
 * reaching the floor of the storey above in a normal building.
 *
 * Its virtue over the depth plane is that it has a far side. A plane does not: it keeps cutting
 * away from the camera until it leaves the world, which is what let the cutaway tunnel into the
 * void. Whatever a box exposes is bounded by its own size rather than by how well the plane was
 * tuned, and the size is one number that can be felt rather than reasoned about.
 */
const BOX_HALF = 4;

/**
 * How often the plane search runs, in ms.
 *
 * The cast is nine rays and can run per frame; the search scores every candidate plane against
 * those nine, so it is ~45 times the work. Ten times a second is far quicker than a camera can be
 * turned meaningfully, and the result is eased towards rather than snapped to, so the throttle is
 * invisible.
 */
const SEARCH_EVERY_MS = 100;

/**
 * The box rule, in TypeScript, so it is testable without a GL context.
 *
 * Same contract `revealCoverage` and `ceilingAt` have: the rule lives here once and the shader
 * restates it, so the two cannot drift into disagreeing about what is cut.
 *
 * `feet` is the character's feet, and the box runs from there UPWARD by twice the half-extent —
 * never downward, because the ground a character stands on is never between them and a camera
 * looking down at them, and cutting it was a bug this project has already paid for once.
 */
export function insideRevealBox(
  world: readonly [number, number, number],
  feet: readonly [number, number, number],
  half: number,
): boolean {
  const dy = world[1] - feet[1];
  return Math.abs(world[0] - feet[0]) <= half
    && Math.abs(world[2] - feet[2]) <= half
    && dy >= 0 && dy <= half * 2;
}

/**
 * How far, in blocks, a meshed section is still drawn. Beyond it sections are hidden and the
 * fog has closed anyway. Sections are only MESHED within main.ts's MESH_RADIUS (256); this
 * is a little wider so terrain meshed on the way somewhere does not pop out at the edge.
 */
export const RENDER_DISTANCE = 384;
/** Beyond this the section is disposed outright; re-meshing on return is ~1 ms. */
export const UNLOAD_DISTANCE = 640;

/** The world-space centre of a section mesh keyed `cx,cy,cz`; null for entity meshes. */
export function sectionCentre(key: string): [number, number, number] | null {
  const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  return [Number(m[1]) * 16 + 8, Number(m[2]) * 16 + 8, Number(m[3]) * 16 + 8];
}

/** Whether any part of a section centred at `c` can lie within `radius` of `eye`. */
export function sectionWithin(
  c: readonly [number, number, number],
  eye: readonly [number, number, number],
  radius: number,
): boolean {
  const dx = c[0] - eye[0], dy = c[1] - eye[1], dz = c[2] - eye[2];
  const r = radius + SECTION_HALF_DIAGONAL;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export interface ViewerStats {
  sections: number;
  quads: number;
  drawCalls: number;
  triangles: number;
  fps: number;
}

/**
 * How wide the hole around the subject is, in BLOCKS at the subject's own distance.
 *
 * In blocks rather than pixels so the hole is the same size in WORLD terms at every zoom
 * level — a fixed pixel radius would swallow half the map zoomed out and miss the
 * character's shoulders zoomed in.
 *
 * THESE USED TO BE 1.1 / 2.2, which is the size of the character and nothing else: a
 * player is 0.6 wide and 1.8 tall, so 1.1 clears the model. That is enough to answer "can
 * I see the thing I am driving" and it is not enough to play with. Standing at the world
 * spawn, which is inside the settlement's excavated base, the whole screen is stone and
 * the cutaway is a porthole with a hat in it — verified with a screenshot before this
 * changed. You cannot see the room you are in, the monitors on the wall, or where you are
 * about to walk.
 *
 * 6 / 9 was chosen by looking at the spawn view at 1.1, 2.5, 3.5, 5, 6, 7, 8, 10 and 12
 * blocks. Roughly three times the old radius and seven times the area: the base reads as a
 * room — the monitor bank, the workbench, the chests, where the floor goes — instead of a
 * porthole with a hat in it.
 *
 * WHAT STOPS IT GOING WIDER is the shape of the cut rather than any cost. A cut is
 * "nearer to the camera than the character", which is a plane tilted 55 degrees from
 * horizontal; a ceiling is flat; so the two meet in a straight line and a wide enough disc
 * puts that line across the middle of the picture with the far half of the roof, seen from
 * above, beyond it. Reported at 8 blocks as "I can see half the roof above me and all the
 * floor above that". At 6 the line sits near the rim where the dither has already faded it
 * out. Wider than this needs a different cut, not a bigger number — and the obvious
 * different cut, dropping the depth test above head height, was tried and is worse: it
 * takes the tops off anything taller than the threshold, which showed up immediately as
 * "its cutting off the top of blocks which should be visible".
 *
 * The outer ring is +3 rather than the old x2. At this scale doubling would make the
 * dithered band 6 blocks — hundreds of device pixels of noise — and the cut would read as
 * a smudge. A fixed narrow rim keeps the soft edge the dither exists for.
 */
const REVEAL_INNER_BLOCKS = 6;
const REVEAL_OUTER_BLOCKS = 9;
/**
 * How far IN FRONT of the subject a fragment has to be before it counts as an occluder.
 *
 * This is where the cut plane sits, measured back from the character towards the camera:
 * `cutViewZ = subjectViewZ - REVEAL_DEPTH_BIAS`. Raise it and the plane slides towards the
 * camera, so less is taken out in front of the character; lower it and the cut hugs the body.
 *
 * It cannot go to zero: the character's own mesh is drawn with these same materials, and its
 * front faces sit nearer the camera than its centre -- at zero the cut eats the character it
 * exists to reveal. Half a block of body is the floor under this value.
 *
 * 4 rather than the original 0.9, in two steps at the user's direction (2026-09-11: "move the
 * clipping plane starting from the player a bit towards the camera", then "a bit more"). The
 * ceiling map handles the roof now, so this only has to clear what is immediately in front of
 * the body, and a plane sitting further towards the camera leaves more of the room standing.
 */
let REVEAL_DEPTH_BIAS = 4;

/** Live tuning knob for the cut plane, driven by the HUD slider. Blocks, measured back from the
 *  character towards the camera. Clamped at 0.25 because zero eats the character's own front faces. */
export function setRevealDepthBias(blocks: number): void {
  REVEAL_DEPTH_BIAS = Math.max(0.25, blocks);
}
export function revealDepthBias(): number { return REVEAL_DEPTH_BIAS; }
/**
 * How far above the subject's FEET a fragment has to be before it counts as an occluder.
 *
 * THE GROUND IS NOT IN THE WAY. "Nearer to the camera than the character" is true of the
 * floor the character is standing on — from a camera 35 degrees above, the floor in front
 * is nearer than the body behind it — so on its own that test eats the ground and you see
 * through it to the caves below. At a 2-block disc the hole was the size of the character
 * and hidden behind it; widening the disc made it the complaint ("I can see through the
 * floor and under it").
 *
 * Geometry says the guard is safe: every point on the sightline from an isometric camera
 * down to the body is ABOVE the body, so nothing below the feet was ever a real occluder.
 * 0.2 keeps the surface the character stands on, and everything under it, at any radius.
 */
const REVEAL_FLOOR_MARGIN = 0.2;

/**
 * Screen-space reveal, injected into every material.
 *
 * A fragment is dropped only when it is BOTH inside a small disc around the subject's
 * screen position AND nearer to the camera than the subject is. Both halves are load
 * bearing and neither works alone: the disc alone would cut a hole through the floor the
 * character stands on, and the depth test alone would strip every wall in the foreground.
 *
 * `ign` is interleaved gradient noise — the dither used for this in real engines. It is a
 * function of `gl_FragCoord` alone, so the pattern is anchored to the SCREEN and stays put
 * while the world moves under it. A hash of world position sparkles instead, which is
 * exactly the "popping as the camera moves" this is meant to avoid.
 */
/**
 * Animated-texture scrolling, in the vertex shader.
 *
 * A vanilla animated texture is a vertical strip of frames, and the mesher maps every quad
 * into frame 0's rect — so advancing a frame is one add on `uv.y`. The per-vertex `anim`
 * attribute carries `(frames, frametimeTicks, vStep)`; a still texture has `frames == 1`,
 * which makes `floor(mod(tick/frametime, 1.0))` exactly zero, so this costs still geometry
 * nothing and needs no second material.
 *
 * Vertex rather than fragment because a quad's four corners always sit in the same frame:
 * the offset is uniform across the quad, so computing it per vertex is both correct and
 * four times cheaper than per pixel.
 */
const ANIM_VERTEX = /* glsl */`
attribute vec3 anim;
uniform float mcwvTick;
`;

const ANIM_VERTEX_BODY = /* glsl */`
  if (anim.x > 1.5) {
    float ft = max(anim.y, 1.0);
    float frame = floor(mod(mcwvTick / ft, anim.x));
    vMapUv.y += frame * anim.z;
  }
`;

const REVEAL_FRAGMENT = /* glsl */`
  uniform vec4 mcwvReveal;        // xy screen px, z max view depth to cut, w mode: 0 off, 1 cutaway, 2 room, 3 box
  uniform vec4 mcwvBox;           // box mode: xyz the character's feet, w half-extent in blocks
  uniform vec3 mcwvRevealRadius;  // inner (gone), outer (kept), world Y floor
  varying float mcwvViewZ;
  varying vec3 mcwvWorldPos;
  varying vec3 mcwvNormal;
${CEILING_GLSL}

  float mcwvIgn(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
`;

const REVEAL_FRAGMENT_BODY = /* glsl */`
  // BOX MODE IS THE WINDOW, NOT THE HOLE, and it sits outside the floor-margin guard below
  // because it is not a cutaway at all: the margin exists to stop a cut eating the ground, and
  // here the ground outside the box is meant to go along with everything else.
  //
  // It was built the other way round first -- everything INSIDE the box discarded -- which is a
  // cube-shaped hole rather than a cube-shaped view: "the box thing is working oppositely of what
  // I intended. It's supposed to enable you to select a box which draws through the world, not
  // create a box that becomes invisible" (the user, 2026-09-11).
  //
  // Inverted, it answers the occlusion problem by construction rather than by tuning: nothing
  // outside the box is drawn, so nothing outside the box can occlude anything. There is no plane
  // to see past and no camera term at all.
  if (mcwvReveal.w > 2.5) {
    vec3 mcwvD = mcwvWorldPos - mcwvBox.xyz;
    bool mcwvInBox = abs(mcwvD.x) <= mcwvBox.w && abs(mcwvD.z) <= mcwvBox.w
      && mcwvD.y >= 0.0 && mcwvD.y <= mcwvBox.w * 2.0;
    if (!mcwvInBox) discard;
  } else if (mcwvReveal.w > 0.5 && mcwvWorldPos.y > mcwvRevealRadius.z) {
    if (mcwvReveal.w > 1.5) {
      // ROOM MODE. No depth term, no disc, no dither -- the map alone decides, and it only ever
      // names the room the character is standing in. Nothing here is a function of the screen, so
      // there is no plane to see past and no way to cut into the void.
      if (mcwvWorldPos.y >= mcwvCeilingAt(mcwvWorldPos.xz, mcwvNormal.xz)) discard;
    } else if (mcwvViewZ < mcwvReveal.z
               || mcwvWorldPos.y >= mcwvCeilingAt(mcwvWorldPos.xz, mcwvNormal.xz)) {
      // NO ROOM GATE HERE, and that was tried and reverted the same evening (2026-09-11). Gating
      // the depth cut on "the flood fill reached this column" sounds right -- cutting into solid
      // rock only ever exposes an interior the mesher never built faces for -- but a WALL is solid,
      // so the fill never reaches it, and the only wall columns marked are the one-deep rim that
      // markNearWalls adds. Against this settlement's thick walls that sliced one layer off and
      // left the rest standing, so the cutaway stopped revealing the character at all: "you
      // completely broke the iso view cutout shit". The void it was meant to fix is the lesser
      // problem. Room mode is where that idea belongs, because there it decides everything.
      float keep = smoothstep(mcwvRevealRadius.x, mcwvRevealRadius.y,
                              distance(gl_FragCoord.xy, mcwvReveal.xy));
      if (mcwvIgn(gl_FragCoord.xy) > keep) discard;
    }
  }
`;

/** Everything the reveal needs, in the units the shader reads them in. */
export interface SubjectReveal {
  /** subject's position on the screen, in DEVICE pixels */
  x: number;
  y: number;
  /** a fragment nearer than this view depth is an occluder; farther is not */
  cutViewZ: number;
  /** device-pixel radii: inside `inner` nothing survives, outside `outer` everything does */
  inner: number;
  outer: number;
  /** world Y below which nothing is cut: the ground is never an occluder. See the margin. */
  floorY: number;
}

/**
 * WHERE THE CUT PLANE SHOULD SIT, FOUND BY CASTING RATHER THAN GUESSED.
 *
 * A fixed bias cannot know where the wall is, so it is always wrong somewhere: too small and the room
 * in front of the character is scooped out, too large and the wall that actually blocks the view is
 * left standing. This asks the world instead -- walk from the character towards the camera and stop
 * at the first solid block. The plane then sits just BEYOND that wall, so the wall and everything in
 * front of it is cut and nothing behind it is touched.
 *
 * HORIZONTALLY. The camera sits at ~45 degrees, so the true vector to it points up and a ray along it
 * hits the ROOF -- which ceiling-map.ts already removes. The walk uses the camera's bearing projected
 * onto the XZ plane (the user, 2026-09-11: "remember the camera is at a 45 deg angle and I dont mean
 * towards it upwards").
 *
 * Returns null when nothing is in the way within `maxBlocks` -- open ground, or facing into the room
 * -- and the caller keeps the fixed bias rather than inventing a distance.
 */
/**
 * A STANDING BIAS ON TOP OF WHAT THE RAYS MEASURED.
 *
 * The rays stop at the first solid COLUMN, which is the wall's near face -- but a wall has thickness,
 * and the plane wants to clear the whole block rather than land inside its front face, or a sliver of
 * the wall survives. Part of what the cast MEANS, so it lives in the cast's own answer; the slider
 * stays a separate deviation from that answer, and the HUD shows both so neither is hidden in the
 * other's number.
 */
export const STANDING_BIAS = -1;

export interface CutCast {
  /** where to put the plane, in blocks back from the character: wall - 0.5 + STANDING_BIAS */
  bias: number;
  /** what the rays actually measured, in view depth, before any bias */
  wall: number;
  /** every ray of the fan, in world space, for the debug lines */
  rays: Array<{ from: [number, number, number]; to: [number, number, number]; hit: boolean }>;
  /** the lowest-floater plane the search found, or null if there was nothing to score */
  best: Candidate | null;
}

/** Half-width of the fan, in degrees either side of the camera's bearing. */
const FAN_DEGREES = 60;
/** Rays in the fan. Odd, so one runs exactly along the bearing. */
const FAN_RAYS = 9;

/**
 * One ray of the fan: step block by block until something solid, or give up.
 *
 * `at` is the distance in blocks, or 0 for "nothing within range" -- which the caller must treat as
 * no evidence rather than as zero distance.
 */
function walkRay(
  isOpen: OpenTest,
  from: [number, number, number],
  dx: number,
  dz: number,
  maxBlocks: number,
): { ray: CutCast['rays'][number]; at: number } {
  let x = from[0];
  let z = from[2];
  for (let d = 1; d <= maxBlocks; d++) {
    x += dx;
    z += dz;
    if (!isOpen(Math.floor(x), from[1], Math.floor(z))) {
      return { ray: { from, to: [x, from[1], z], hit: true }, at: d };
    }
  }
  return { ray: { from, to: [x, from[1], z], hit: false }, at: 0 };
}

export function castCutBias(
  isOpen: OpenTest,
  camera: THREE.PerspectiveCamera,
  pos: readonly [number, number, number],
  maxBlocks = 32,
): CutCast | null {
  const bx = camera.position.x - pos[0];
  const bz = camera.position.z - pos[2];
  const len = Math.hypot(bx, bz);
  if (len < 1e-3) return null;
  const sx = bx / len;
  const sz = bz / len;
  // Eye height, or a block higher when there is headroom.
  //
  // At eye level the ray meets whatever furniture the room has -- a chest, a machine, a slab step --
  // and stops at the first of them, putting the cut plane in front of the furniture instead of in
  // front of the WALL. One block up clears most of that and still sits well below a ceiling. Only
  // when that cell is actually air, though: in a low room or under a stair, raising the ray would
  // walk it straight into the ceiling and report a wall that is really the roof.
  const feetY = Math.floor(pos[1]);
  // UP TO TWO BLOCKS ABOVE THE HEAD, AS FAR AS THERE IS ROOM.
  //
  // At eye level the ray stops on the room's furniture -- a chest, a machine, a slab step -- putting
  // the plane in front of that rather than in front of the wall. Lifting it clears that.
  //
  // Each step is taken only if that cell is actually air, and it stops at the first that is not, so a
  // low room or a stairwell keeps the ray down where the walls are. An earlier attempt raised it
  // unconditionally and the ray sailed over the walls, found nothing, and the cast went null -- which
  // silently drops the plane back to the fixed bias. Height is only useful while it stays below the
  // top of the thing it is meant to find.
  const cx0 = Math.floor(pos[0]);
  const cz0 = Math.floor(pos[2]);
  let y = feetY + 1;
  for (const lift of [2, 3]) {
    if (!isOpen(cx0, feetY + lift, cz0)) break;
    y = feetY + lift;
  }
  // A FAN, NOT A SINGLE RAY.
  //
  // One ray is a step function: it is looking at exactly one column, so walking past a doorway or
  // turning a few degrees flips it from the near wall to one across the room and the plane jumps with
  // it. Worse, a single ray that happens to point through a gap reports "nothing in the way" while
  // the wall either side of that gap is still blocking the view.
  //
  // Casting an arc around the bearing samples the room instead of one line of it, and the MEDIAN hit
  // is what sets the plane -- median rather than nearest, because the nearest is as twitchy as the
  // single ray was, and rather than mean, because a single ray escaping through a door would drag an
  // average out to the far side of the building.
  const rays: CutCast['rays'] = [];
  const hits: number[] = [];
  const half = (FAN_DEGREES * Math.PI) / 180;
  for (let i = 0; i < FAN_RAYS; i++) {
    // -half .. +half, evenly, with the middle ray exactly on the bearing.
    const a = ((i / (FAN_RAYS - 1)) * 2 - 1) * half;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const walk = walkRay(isOpen, [pos[0], y, pos[2]], sx * cos - sz * sin, sx * sin + sz * cos, maxBlocks);
    rays.push(walk.ray);
    if (walk.at > 0) hits.push(walk.at);
  }
  if (hits.length === 0) return null;
  hits.sort((p, q) => p - q);
  const median = hits[Math.floor(hits.length / 2)]!;

  // BIGGER BIAS CUTS LESS. `cutViewZ = subjectViewZ - bias`, and a fragment survives when its depth
  // is at least cutViewZ -- so raising the bias pulls the plane towards the camera and spares more.
  // To CUT a wall the bias must be SHORTER than the distance to it.
  //
  // And the distance has to be in view DEPTH, not ground distance: the rays walk horizontally, but
  // the camera looks down at ~45 degrees, so a block of ground is less than a block of depth. The
  // horizontal component of the view direction is the conversion.
  const toCam = camera.position.clone().sub(new THREE.Vector3(pos[0], pos[1] + 1, pos[2]));
  const camLen = toCam.length() || 1;
  const horiz = Math.hypot(toCam.x, toCam.z) || 1;
  const depthToWall = median * (horiz / camLen);
  const fromWall = Math.max(0.25, depthToWall - 0.5 + STANDING_BIAS);

  // THEN SCORE IT, and every other plane within reach, against the floaters each would leave.
  //
  // The wall distance answers "is the wall cut" and not "does the result look right", and the two
  // come apart constantly -- see cut-score.ts. `search` walks the same fan and counts the rays whose
  // cut would land buried inside solid, where the mesher built no face and you see the void.
  const dirs = fanDirections(sx, sz);
  const toHoriz = camLen / horiz;          // view depth -> horizontal distance along the rays
  const candidates: Candidate[] = [];
  for (let b = 0.5; b <= maxBlocks * (horiz / camLen); b += 0.25) {
    candidates.push({ bias: b, score: cutScore(isOpen, [pos[0], y, pos[2]], dirs, b * toHoriz) });
  }
  const best = bestCandidate(candidates);
  return { bias: fromWall, wall: depthToWall, rays, best };
}

/** The fan's directions, as unit vectors -- shared by the cast and the scorer so they agree. */
function fanDirections(sx: number, sz: number): Ray[] {
  const out: Ray[] = [];
  const half = (FAN_DEGREES * Math.PI) / 180;
  for (let i = 0; i < FAN_RAYS; i++) {
    const a = ((i / (FAN_RAYS - 1)) * 2 - 1) * half;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out.push({ dx: sx * cos - sz * sin, dz: sx * sin + sz * cos });
  }
  return out;
}

/**
 * Where the subject is on screen, how deep it is, and how big its hole should be.
 *
 * Pulled out of `Viewer` because it is the whole of the model and it is arithmetic: a
 * WebGL context cannot be created in a test, but this can be checked against a real
 * `PerspectiveCamera` with no renderer at all. Returns null when there is nothing to
 * reveal — behind the camera, or on the camera's own plane.
 */
export function subjectReveal(
  camera: THREE.PerspectiveCamera,
  pos: readonly [number, number, number],
  width: number,
  height: number,
  /** Where to put the cut plane, in blocks back from the character. Defaults to the fixed bias. */
  bias: number = REVEAL_DEPTH_BIAS,
): SubjectReveal | null {
  // The subject's BODY, not its feet: the hole is centred on the model, and a hole centred
  // on the feet cuts the floor and leaves the head behind whatever is in front of it.
  const p = new THREE.Vector3(pos[0], pos[1] + 1, pos[2]);
  const viewZ = -p.clone().applyMatrix4(camera.matrixWorldInverse).z;
  if (!(viewZ > 0)) return null;
  const ndc = p.clone().project(camera);
  // Pixels per world unit AT THE SUBJECT'S DISTANCE, from the camera's own frustum — this
  // is what keeps the hole the size of the character at every zoom level.
  const perUnit = height / (2 * viewZ * Math.tan((camera.fov * Math.PI) / 360));
  return {
    x: (ndc.x * 0.5 + 0.5) * width,
    y: (ndc.y * 0.5 + 0.5) * height,
    cutViewZ: viewZ - bias,
    inner: REVEAL_INNER_BLOCKS * perUnit,
    outer: REVEAL_OUTER_BLOCKS * perUnit,
    floorY: pos[1] + REVEAL_FLOOR_MARGIN,
  };
}

/**
 * How much of a fragment survives the reveal, 0 (gone) to 1 (untouched).
 *
 * The same predicate the shader runs, in TypeScript, so the rule can be asserted against
 * concrete geometry rather than described in a comment. The shader adds one thing this
 * does not: a dither, which turns a fractional coverage into a per-pixel keep-or-discard.
 * Everything that decides WHETHER a fragment is a candidate at all lives here.
 */
export function revealCoverage(
  reveal: SubjectReveal | null,
  x: number,
  y: number,
  viewZ: number,
  /** the fragment's world position; `ceilingY` is what `ceilingAt` said about its column */
  world: { y: number; ceilingY: number },
): number {
  const worldY = world.y;
  if (!reveal) return 1;
  // At or below the character's feet: the ground, which is never in the way of seeing the
  // character however near the camera it is. Without this the disc eats the floor.
  if (worldY <= reveal.floorY) return 1;
  // In front of the subject, OR at/above this column's ceiling. Two rules, because one
  // cannot do it (see ceiling-map.ts):
  //
  //   the depth test alone is a tilted plane, and on a flat roof it draws a straight line
  //   across the middle of the picture — the roof comes away in half
  //
  //   a height alone cuts through whatever is at that height, and at the reference base a
  //   monitor top and a ceiling are at the same height, so it takes the tops off machines
  //
  // The ceiling height is per COLUMN and comes from the block grid: the first solid above
  // head height with air under it. A pillar has no such block, so `ceilingY` is Infinity
  // for its column and only the depth test applies to it.
  if (viewZ >= reveal.cutViewZ && worldY < world.ceilingY) return 1;
  const d = Math.hypot(x - reveal.x, y - reveal.y);
  return smoothstep(reveal.inner, reveal.outer, d);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private materials!: Record<Layer, THREE.Material>;
  /**
   * Animation clock, in Minecraft TICKS, shared by every patched material.
   *
   * Ticks rather than seconds because that is the unit `.mcmeta` states `frametime` in, so
   * the shader compares like with like and a `frametime: 2` texture advances every 2 ticks
   * exactly as it does in game. Advanced from the render loop, so a paused tab does not
   * accumulate a jump.
   */
  private animTick = { value: 0 };
  private meshes = new SectionStore(this.scene);
  private tmpForward = new THREE.Vector3();
  private texture!: THREE.Texture;

  private frameTimes: number[] = [];
  /**
   * The reveal's uniforms. ONE object per uniform, shared by all three materials, so a
   * per-frame update is two number writes rather than a shader recompile or a walk of the
   * scene graph. `w` is the on/off switch: the branch costs nothing when it is 0 and the
   * shader is identical either way, so first person and isometric run the same program.
   */
  private revealAt = { value: new THREE.Vector4(0, 0, 0, 0) };
  private revealRadius = { value: new THREE.Vector3(0, 0, 0) };
  /** Box mode: the character's feet in xyz, the box's half-extent in w. See BOX_HALF. */
  private boxAt = { value: new THREE.Vector4(0, 0, 0, 0) };
  private boxHalf = BOX_HALF;
  /** Last cast + search result, reused between searches so the debug fan does not blink. */
  private cast: CutCast | null = null;
  private lastSearch = -1e9;
  /** The plane the search settled on, kept across searches so hysteresis has something to compare. */
  private chosen: Candidate | null = null;
  /** Whether the search drives the plane at all; off falls back to the wall-distance answer. */
  private autoTune = true;
  /** null = auto (the cast decides); a number overrides it. */
  /**
   * Nudge applied to whatever the cast decided, in blocks. 0 leaves the cast alone.
   *
   * A BIAS, not an override: the cast already follows the room as you walk and turn, and replacing
   * its number with a fixed one throws that away -- the value is right in one spot and wrong
   * everywhere else. An offset keeps the automatic behaviour and shifts it.
   */
  private biasNudge = 0;
  /** what the fan last decided, before the nudge. Shown on the slider. */
  private autoBias = REVEAL_DEPTH_BIAS;
  /** what the rays measured before any bias, so the HUD can show the parts separately */
  private castWall = 0;
  /** what the cast last returned, or the fixed default when it found nothing. For the HUD. */
  private biasInUse = REVEAL_DEPTH_BIAS;
  /** when biasInUse was last eased, so the ease is frame-rate independent */
  private biasAt = 0;
  private castVisible = true;
  private lastCastLen = 0;
  /** The cast, drawn. Hidden until there is a cast to draw. */
  private castLine = (() => {
    const geom = new THREE.BufferGeometry();
    // LineSegments, two vertices per ray: the fan is a set of separate rays, and a single Line would
    // join the end of each to the start of the next and draw a zig-zag through the room.
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FAN_RAYS * 6), 3));
    // depthTest off so the rays are visible THROUGH the wall they found -- a debug line hidden
    // behind the thing it is diagnosing is no use at all.
    const mat = new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false, transparent: true });
    const line = new THREE.LineSegments(geom, mat);
    line.renderOrder = 999;
    line.frustumCulled = false;
    line.visible = false;
    return line;
  })();
  private reveal: SubjectReveal | null = null;
  private tmpSize = new THREE.Vector2();
  /**
   * The per-column ceiling patch (ceiling-map.ts) and the uniforms that address it. Null
   * until `setCeilingSource` supplies a way to ask whether a block is open, which only the
   * app layer knows — the same shape the rest of this class takes its world knowledge in.
   */
  private ceilingOpen: OpenTest | null = null;
  private ceilingMap: CeilingMap | null = null;
  private ceilBytes = new Uint8Array(CEIL_SIZE * CEIL_SIZE * 4);
  private ceilTexture: { value: THREE.DataTexture | null } = { value: null };
  private ceilBase = { value: new THREE.Vector4(0, 0, 0, 0) };
  /** The block the patch was built for, so walking does not rebuild it 60 times a second. */
  private ceilCell = '';
  private revealMode: RevealMode = 'cutaway';

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x87ceeb);
    // NEAR PLANE — 0.1, and it went to 0.02 for a while, which was a mistake worth
    // recording because the request that produced it sounded like the opposite.
    //
    // Depth-buffer precision is set by the near/far RATIO, and near dominates it. The
    // resolution at distance z is about z^2 (f-n) / (f n (2^24 - 1)):
    //
    //   near 0.1,  z 384  ->  0.088 blocks
    //   near 0.02, z 384  ->  0.439 blocks
    //
    // So "bring the near plane closer" made surfaces within half a block of each other
    // fight for the same depth value out at the fog line — which presents as geometry
    // winking, showing through, and vanishing, and is easily read as things being clipped
    // that should not be. The fix pointed the other way from the request.
    //
    // The far plane stays at 2000 even though nothing is drawn past RENDER_DISTANCE (384),
    // because it is not what costs the precision: at near 0.1, dropping far to 512 changes
    // the figure above from 0.0879 to 0.0879. Near is the only lever here.
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
    this.camera.position.set(0, 100, 0);
    // The fog ends where the sections stop being drawn (RENDER_DISTANCE), so the cap is a
    // horizon rather than a cliff of missing terrain.
    this.scene.fog = new THREE.Fog(0x87ceeb, RENDER_DISTANCE * 0.6, RENDER_DISTANCE);
    this.scene.add(this.castLine);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setAtlas(atlas: TextureAtlas) {
    const tex = new THREE.CanvasTexture(atlas.canvas as unknown as HTMLCanvasElement);
    // NEAREST is what makes it look like Minecraft rather than a blurry approximation.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // The atlas is built in canvas coordinates (origin top-left, y down) and the sprite
    // rects are derived from those same coordinates, so the texture must NOT be flipped
    // on upload. three.js defaults flipY to true, which mirrors every sprite's V into
    // the atlas's unused lower half and samples fully transparent texels.
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.texture = tex;

    const common = { map: tex, vertexColors: true, side: THREE.FrontSide } as const;
    this.materials = {
      // A tiny alphaTest on the solid layer discards fully transparent texels. Vanilla's
      // solid layer has no alpha test, but it also never samples a transparent texel
      // there; modded models coincident-overlay freely, and without this those texels
      // write black over the base face.
      solid: new THREE.MeshBasicMaterial({ ...common, alphaTest: 0.02 }),
      cutout: new THREE.MeshBasicMaterial({ ...common, alphaTest: 0.5, transparent: false }),
      translucent: new THREE.MeshBasicMaterial({
        ...common,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    };
    for (const m of Object.values(this.materials)) this.patchReveal(m);
  }

  /**
   * Teach one material to drop the fragments that are between the camera and the subject.
   *
   * Done on the shared materials rather than per mesh, so terrain and entities alike get
   * it with no bookkeeping and no second draw. `onBeforeCompile` runs once per program;
   * the uniform OBJECTS are shared, so writing `.value` afterwards reaches every material
   * that was patched.
   */
  private patchReveal(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.mcwvReveal = this.revealAt;
      shader.uniforms.mcwvRevealRadius = this.revealRadius;
      shader.uniforms.mcwvBox = this.boxAt;
      shader.uniforms.mcwvTick = this.animTick;
      shader.uniforms.mcwvCeilMap = this.ceilTexture;
      shader.uniforms.mcwvCeilBase = this.ceilBase;
      shader.vertexShader =
        `varying float mcwvViewZ;\nvarying vec3 mcwvWorldPos;\nvarying vec3 mcwvNormal;\n${ANIM_VERTEX}\n${shader.vertexShader}`
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n${ANIM_VERTEX_BODY}`)
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n  mcwvViewZ = -mvPosition.z;'
            + '\n  mcwvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
            // World-space face normal, for `mcwvCeilingAt`: which column owns a boundary face.
            // Block faces are axis-aligned and flat, so no interpolation artefact reaches the
            // quarter-block step this feeds -- any point on the quad gives the same answer.
            + '\n  mcwvNormal = mat3(modelMatrix) * normal;',
        );
      shader.fragmentShader = `${REVEAL_FRAGMENT}\n${shader.fragmentShader}`.replace(
        'void main() {',
        `void main() {\n${REVEAL_FRAGMENT_BODY}`,
      );
    };
  }

  /**
   * Reveal a subject: hide only what is genuinely in the way of seeing it.
   *
   * REPLACES a global clipping plane at the player's head height, which was wrong in two
   * visible ways. It removed every block above that height ANYWHERE in the scene, so you
   * saw through walls that were never occluding anything and the world read as roofless
   * rather than cut open; and because the height tracked the player, every step up or down
   * moved the cut for the whole world at once, which on stairs and hillsides made distant
   * walls jump up and down. Both are inherent to cutting by height: a height has no idea
   * where the camera is.
   *
   * This asks the actual question instead — is this fragment between the camera and the
   * subject — so a wall beside the character is untouched no matter how tall it is, and
   * the player's Y changes nothing except where the small hole sits.
   *
   * `pos` is the subject's FEET; the hole is centred on its body. Null draws everything.
   */
  setSubject(pos: readonly [number, number, number] | null) {
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    // The ceiling patch is keyed on the subject too, and this is the one call every camera
    // mode already makes with the subject's position — so it needs no second wiring and
    // cannot fall out of step with the cut that reads it.
    this.updateCeiling(pos);
    // ROOM MODE SHORT-CIRCUITS ALL OF THIS. The cast, the plane, the disc and the dither are the
    // machinery of a screen-space cut, and room mode has none: the map already names exactly what
    // to hide, so the only thing the shader still needs is the floor margin. `w = 2` selects it.
    if (this.revealMode === 'room' || this.revealMode === 'box') {
      this.showCast(null);
      this.reveal = null;
      if (!pos) { this.revealAt.value.w = 0; return; }
      this.revealAt.value.set(0, 0, -1, this.revealMode === 'box' ? 3 : 2);
      this.revealRadius.value.set(0, 0, pos[1] - REVEAL_FLOOR_MARGIN);
      // The box is anchored on the FEET, not the body centre, so its underside sits on the floor
      // the character stands on and the floor itself survives the margin above.
      this.boxAt.value.set(pos[0], pos[1], pos[2], this.boxHalf);
      return;
    }
    // AUTO: the cast decides where the plane goes; an override from the slider wins over it.
    // THE SEARCH IS THROTTLED, THE CAST IS NOT. The cast is nine rays; the search scores ~45
    // candidate planes against those nine, which is fine ten times a second and not sixty. The
    // plane it picks is eased towards either way, so throttling costs nothing visible.
    const now = performance.now();
    const due = now - this.lastSearch >= SEARCH_EVERY_MS;
    const cast = pos && this.ceilingOpen && (due || !this.cast)
      ? castCutBias(this.ceilingOpen, this.camera, pos)
      : this.cast;
    if (cast && due) this.lastSearch = now;
    this.cast = cast;
    this.showCast(cast);
    // HYSTERESIS lives here rather than in the search: the search is pure and says what it found,
    // and this decides whether the answer is worth moving to. See shouldAdopt.
    if (cast?.best && shouldAdopt(this.chosen, cast.best)) this.chosen = cast.best;
    if (!cast) this.chosen = null;
    this.autoBias = (this.autoTune ? this.chosen?.bias : undefined) ?? cast?.bias ?? REVEAL_DEPTH_BIAS;
    this.castWall = cast?.wall ?? 0;
    this.easeBias(Math.max(0.25, this.autoBias + this.biasNudge));
    const r = pos
      ? subjectReveal(this.camera, pos, size.width, size.height, this.biasInUse)
      : null;
    this.reveal = r;
    if (!r) {
      this.revealAt.value.w = 0;
      return;
    }
    this.revealAt.value.set(r.x, r.y, r.cutViewZ, 1);
    this.revealRadius.value.set(r.inner, r.outer, r.floorY);
  }

  /**
   * Teach the cutaway where ceilings are, given a way to ask whether a block is open.
   *
   * A predicate rather than the `World` itself: "open" is a question about block SEMANTICS
   * (a torch is open, a glass pane is not) and the table that answers it lives in the app
   * layer next to the walking rules. Passing null turns the ceiling rule off and leaves the
   * depth test alone, which is what the jar and drag-and-drop paths get.
   */
  /**
   * Which reveal is in use.
   *
   * `cutaway` is the original: a depth plane plus a disc, tuned by the cast and the bias slider.
   * `room` is the Project Zomboid one: the room the character stands in, found by flood fill, with
   * no screen-space component at all — see room-map.ts for why that is the one that cannot show
   * you the void. Switching rebuilds the patch on the next frame, because the key changes shape.
   */
  setRevealMode(mode: RevealMode): void {
    if (mode === this.revealMode) return;
    this.revealMode = mode;
    this.ceilCell = '';
  }

  get revealModeForTest(): RevealMode { return this.revealMode; }

  /**
   * Is this block currently removed from the picture by the reveal?
   *
   * THE PICKER HAS TO AGREE WITH THE SHADER, because the reveal removes geometry from the PICTURE
   * and not from the world. A DDA through the voxels stops on the roof the cutaway just took off,
   * so a click aimed into the room you can plainly see resolves to the invisible ceiling above it.
   * A click has to mean what is on screen.
   *
   * This restates the shader's rule per mode rather than sharing it, because the shader answers per
   * FRAGMENT with a screen position and a dither, and this answers per BLOCK with neither. Where
   * they differ the difference is deliberate: the dithered rim is treated as solid, so the edge of
   * the hole -- where half the pixels survive and half do not -- picks the block you can still see
   * rather than something behind it.
   */
  revealHides(x: number, y: number, z: number): boolean {
    if (this.revealAt.value.w < 0.5) return false;
    const centre: [number, number, number] = [x + 0.5, y + 0.5, z + 0.5];
    if (this.revealMode === 'box') {
      // The box is the WINDOW: what is hidden is everything outside it.
      const b = this.boxAt.value;
      return !insideRevealBox(centre, [b.x, b.y, b.z], b.w);
    }
    // Never below the floor margin, in either of the remaining modes: the ground is never cut.
    if (centre[1] <= this.revealRadius.value.z) return false;
    const lid = ceilingAt(this.ceilingMap, centre[0], centre[2]);
    if (this.revealMode === 'room') return centre[1] >= lid;
    // Cutaway: the depth plane OR the lid, and only inside the disc. `revealCoverage` is the
    // shader's own rule in TypeScript, so the two cannot drift; 0 there means fully removed.
    const r = this.reveal;
    if (!r) return false;
    const p = new THREE.Vector3(centre[0], centre[1], centre[2]).applyMatrix4(this.camera.matrixWorldInverse);
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    const ndc = new THREE.Vector3(centre[0], centre[1], centre[2]).project(this.camera);
    const sx = (ndc.x * 0.5 + 0.5) * size.width;
    const sy = (ndc.y * 0.5 + 0.5) * size.height;
    return revealCoverage(r, sx, sy, -p.z, { y: centre[1], ceilingY: lid }) === 0;
  }

  /**
   * Let the floater search drive the plane, or fall back to the plain wall-distance answer.
   *
   * A switch rather than a fact, because the search is a judgement about what looks right and the
   * wall distance is a measurement -- when they disagree it must be possible to see which is which
   * rather than guess.
   */
  setAutoTune(on: boolean): void {
    this.autoTune = on;
    this.chosen = null;
  }

  /** Box mode's half-extent in blocks; the slider drives this. 8x8 is a half of 4. */
  setBoxHalf(blocks: number): void {
    this.boxHalf = Math.max(1, Math.min(24, blocks));
  }

  boxHalfForTest(): number { return this.boxHalf; }

  /** Horizontal direction from the subject towards the camera; `[0, 1]` if they coincide. */
  private cameraDirection(pos: readonly [number, number, number]): [number, number] {
    const dx = this.camera.position.x - pos[0];
    const dz = this.camera.position.z - pos[2];
    return dx === 0 && dz === 0 ? [0, 1] : [dx, dz];
  }

  setCeilingSource(isOpen: OpenTest | null): void {
    this.ceilingOpen = isOpen;
    this.ceilCell = '';
    if (!isOpen) {
      this.ceilingMap = null;
      this.ceilBase.value.w = 0;
    }
  }

  /** The patch currently in the shader, for the tests and the proof harness. */
  get ceilingMapForTest(): CeilingMap | null {
    return this.ceilBase.value.w > 0.5 ? this.ceilingMap : null;
  }

  /**
   * Rebuild the ceiling patch if the subject has changed block.
   *
   * Keyed on the BLOCK because the patch is a function of the block grid: a character
   * walking across one cell produces the same ceilings every frame. The texture is a single
   * 32x32 upload, so a rebuild is cheap enough not to need a time budget on top.
   */
  private updateCeiling(pos: readonly [number, number, number] | null): void {
    const isOpen = this.ceilingOpen;
    if (!isOpen || !pos) {
      this.ceilBase.value.w = 0;
      this.ceilCell = '';
      return;
    }
    // EACH MODE KEEPS ITS OWN MAP. Making the cutaway share the flood fill was tried and reverted
    // the same evening: the fill only reaches open space, a wall is not open space, and the cutaway
    // then had nothing to cut but the one-deep rim `markNearWalls` adds. See the note in
    // REVEAL_FRAGMENT_BODY. The cutaway's per-column ceiling scan covers every column, which is
    // what a depth cut needs.
    //
    // ROOM MODE IS ALSO KEYED ON WHICH WALLS FACE THE CAMERA, because that is part of what it
    // marks. Only the SIGNS matter -- `markNearWalls` asks four dot products against unit offsets —
    // so turning the view rebuilds the patch four times in a full circle rather than once a frame.
    // BOX MODE READS NO MAP AT ALL -- it is pure arithmetic on the fragment's world position --
    // so neither scan is worth running while it is on.
    if (this.revealMode === 'box') { this.ceilBase.value.w = 0; this.ceilCell = ''; return; }
    const toCam = this.cameraDirection(pos);
    const facing = this.revealMode === 'room' ? `|${Math.sign(toCam[0])},${Math.sign(toCam[1])}` : '';
    const cell = `${Math.floor(pos[0])},${Math.floor(pos[1])},${Math.floor(pos[2])}${facing}`;
    if (cell !== this.ceilCell) {
      this.ceilCell = cell;
      const map = this.revealMode === 'room'
        ? buildRoomMap(isOpen, pos, toCam, this.ceilingMap?.bytes)
        : buildCeilingMap(isOpen, pos, this.ceilingMap?.bytes);
      this.ceilingMap = map;
      // RGBA rather than a single-channel format: one byte per texel would do, but R8 is
      // the kind of thing that is core in one GL profile and an extension in the next, and
      // 4 KB is not worth finding that out in the field. The shader reads `.r`.
      for (let i = 0; i < map.bytes.length; i++) this.ceilBytes[i * 4] = map.bytes[i];
      this.ceilTexture.value?.dispose();
      const tex = new THREE.DataTexture(this.ceilBytes, CEIL_SIZE, CEIL_SIZE);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this.ceilTexture.value = tex;
      this.ceilBase.value.set(map.baseX, map.baseZ, map.baseY, 1);
    }
  }

  /**
   * Move the cut plane towards its target instead of snapping to it.
   *
   * The cast is a step function: walk past a doorway and the first solid on the ray jumps from the
   * near wall to one across the room, and the plane teleports with it -- which reads as the world
   * flickering rather than as the cut moving. A manual override is exact and applies at once:
   * dragging a slider and watching the number crawl after you would be worse than the jump.
   */
  private easeBias(target: number): void {
    if (this.biasInUse === 0) {
      this.biasInUse = target;
      return;
    }
    // Frame-rate independent: an exponential on elapsed time, so it does not ease faster on a fast
    // machine, and dt is clamped so a stalled tab does not jump the whole way on resume.
    const now = performance.now();
    const dt = Math.min(100, now - (this.biasAt || now));
    this.biasAt = now;
    this.biasInUse += (target - this.biasInUse) * (1 - Math.exp(-dt / 120));
  }

  /** Draw the cast: from the character, horizontally, to the wall it stopped at. */
  private showCast(cast: CutCast | null): void {
    if (!cast || !this.castVisible) { this.castLine.visible = false; this.lastCastLen = 0; return; }
    const a = this.castLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    let hitLen = 0;
    let hits = 0;
    for (let i = 0; i < FAN_RAYS; i++) {
      // A ray the fan did not cast, or one that hit nothing, is collapsed to a point rather than
      // left holding a stale position from the previous frame.
      const r = cast.rays[i];
      const from = r ? r.from : [0, 0, 0];
      const to = r && r.hit ? r.to : from;
      a.setXYZ(i * 2, from[0], from[1], from[2]);
      a.setXYZ(i * 2 + 1, to[0], to[1], to[2]);
      if (r?.hit) { hitLen += Math.hypot(r.to[0] - r.from[0], r.to[2] - r.from[2]); hits++; }
    }
    this.lastCastLen = hits > 0 ? hitLen / hits : 0;
    a.needsUpdate = true;
    this.castLine.geometry.computeBoundingSphere();
    this.castLine.visible = true;
  }

  /** Show or hide the cast's debug line. */
  setCastVisible(on: boolean): void {
    this.castVisible = on;
    if (!on) this.castLine.visible = false;
  }

  /** Nudge the cast's answer, in blocks. 0 leaves it exactly as cast. */
  setCutBias(nudgeBlocks: number): void {
    this.biasNudge = nudgeBlocks;
  }

  /**
   * What the cut plane is using, what the cast said before the nudge, and how far the rays got.
   *
   * `hit` matters: when the fan finds nothing the plane falls back to the fixed default, which looks
   * exactly like the feature being switched off. Saying so is the difference between "no wall in the
   * way" and "this is broken".
   */
  cutBiasState(): {
    blocks: number; wall: number; std: number; nudge: number; hit: boolean; ray: number;
    tuned: boolean; score: number | null;
  } {
    return {
      blocks: this.biasInUse,
      wall: this.castWall,
      std: STANDING_BIAS,
      nudge: this.biasNudge,
      hit: this.castLine.visible,
      ray: this.lastCastLen,
      tuned: this.autoTune,
      score: this.chosen?.score ?? null,
    };
  }

  /** Where the ceiling is over a world point, as the shader sees it. For the tests. */
  ceilingOver(worldX: number, worldZ: number): number {
    return ceilingAt(this.ceilingMapForTest, worldX, worldZ);
  }

  /** What the shader is currently doing, for the tests and the proof harness. */
  get subjectReveal(): SubjectReveal | null {
    return this.revealAt.value.w > 0.5 ? this.reveal : null;
  }

  addSection(mesh: SectionMesh) {
    const key = `${mesh.cx},${mesh.cy},${mesh.cz}`;
    this.removeSection(key);
    const created: THREE.Mesh[] = [];
    for (const layer of ['solid', 'cutout', 'translucent'] as Layer[]) {
      const buf = mesh.layers[layer];
      if (!buf) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
      geom.setAttribute('normal', vertexAttr(buf.normals, 3));
      geom.setAttribute('uv', vertexAttr(buf.uvs, 2));
      geom.setAttribute('color', vertexAttr(buf.colors, 4));
      geom.setAttribute('anim', new THREE.BufferAttribute(buf.anim, 3));
      geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
      geom.computeBoundingSphere();
      const m = new THREE.Mesh(geom, this.materials[layer]);
      m.position.set(mesh.cx * 16, mesh.cy * 16, mesh.cz * 16);
      m.frustumCulled = true;
      // Translucent last so three.js depth-sorts it after opaque geometry.
      m.renderOrder = layer === 'translucent' ? 2 : layer === 'cutout' ? 1 : 0;
      created.push(m);
    }
    // The store parents, measures, and arranges for each geometry's CPU arrays to be
    // released once the GPU has them; see section-store.ts.
    this.meshes.add(key, created, {
      centre: [mesh.cx * 16 + 8, mesh.cy * 16 + 8, mesh.cz * 16 + 8],
      quads: mesh.quadCount,
    });
  }

  hasSection(key: string): boolean {
    return this.meshes.has(key);
  }

  /**
   * Add a free-standing mesh with its own transform — used for contraption entities,
   * which are ordinary blocks placed under one entity-level rotation.
   */
  addEntityMesh(
    key: string,
    layers: Partial<Record<Layer, {
      positions: Float32Array;
      normals: Float32Array | Int8Array;
      uvs: Float32Array | Uint16Array;
      colors: Float32Array | Uint8Array;
      indices: Uint32Array;
      anim?: Float32Array;
    }>>,
    transform: { pos: [number, number, number]; angleDeg: number; axis: 'X' | 'Y' | 'Z' | null },
  ) {
    this.removeSection(key);
    const created: THREE.Mesh[] = [];
    for (const layer of ['solid', 'cutout', 'translucent'] as Layer[]) {
      const buf = layers[layer];
      if (!buf) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
      geom.setAttribute('normal', vertexAttr(buf.normals, 3));
      geom.setAttribute('uv', vertexAttr(buf.uvs, 2));
      geom.setAttribute('color', vertexAttr(buf.colors, 4));
      // A caller that predates the animation attribute still renders, as still geometry.
      geom.setAttribute('anim', new THREE.BufferAttribute(
        buf.anim ?? stillAnim(buf.positions.length / 3), 3));
      geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
      geom.computeBoundingSphere();
      const m = new THREE.Mesh(geom, this.materials[layer]);
      m.position.set(transform.pos[0], transform.pos[1], transform.pos[2]);
      if (transform.axis) {
        const r = (transform.angleDeg * Math.PI) / 180;
        if (transform.axis === 'X') m.rotation.x = r;
        else if (transform.axis === 'Y') m.rotation.y = r;
        else m.rotation.z = r;
      }
      m.renderOrder = layer === 'translucent' ? 2 : layer === 'cutout' ? 1 : 0;
      created.push(m);
    }
    // No centre: an entity mesh moves (see `setEntityTransform`), so a cached one would be
    // wrong within a frame — and its owner already reconciles it every poll, so the section
    // budget must never be the thing that removes it.
    this.meshes.add(key, created, { centre: null, quads: 0 });
  }

  /**
   * Move an entity mesh already in the scene, without rebuilding it.
   *
   * `addEntityMesh` disposes and re-uploads every buffer, which is right once per roster
   * poll and ruinous once per frame. The isometric view needs the character it is
   * following to move at frame rate rather than in 1 Hz steps, and a transform is the only
   * thing that changes between those steps.
   */
  setEntityTransform(key: string, pos: readonly [number, number, number], angleDeg?: number) {
    const entry = this.meshes.get(key);
    if (!entry) return;
    for (const m of entry.meshes) {
      m.position.set(pos[0], pos[1], pos[2]);
      if (angleDeg !== undefined) m.rotation.y = (angleDeg * Math.PI) / 180;
    }
  }

  /** Where the camera is and what it looks along, in the form the budget policy wants. */
  viewPoint(): ViewPoint {
    this.camera.updateMatrixWorld();
    const f = this.camera.getWorldDirection(this.tmpForward);
    const p = this.camera.position;
    return { eye: [p.x, p.y, p.z], forward: [f.x, f.y, f.z] };
  }

  /**
   * The per-frame view pass: hide what is too far to draw, DISPOSE what is not worth
   * holding, and keep the resident geometry under the byte ceiling.
   *
   * three.js already frustum-culls every section mesh correctly — measured on the deployed
   * page, 2724 of 9384 meshes passed the frustum test and the hand-built bounding spheres
   * are right — so this is not about what is drawn. It is about what EXISTS: culled
   * geometry is drawn for free and paid for in full, and 6032 resident sections was 883 MB
   * of attribute arrays and a dead tab. See section-budget.ts for the measurements.
   *
   * Runs every frame rather than only when the camera has moved 48 blocks (which is what
   * `rebuildQueue` used to gate the old `dropSectionsBeyond` on) because turning on the
   * spot changes the answer and moves the camera not at all.
   */
  retain(opts: KeepOptions = DEFAULT_KEEP, maxBytes = MAX_SECTION_BYTES): {
    drawn: number; culled: number; dropped: number; bytes: number; sections: number;
    /** the worst-scoring section still resident; what a waiting section must beat to be built */
    worstScore: number;
  } {
    const view = this.viewPoint();
    const eye = view.eye;
    let drawn = 0;
    let culled = 0;
    const records: SectionRecord[] = [];
    for (const [key, entry] of this.meshes) {
      const c = entry.centre;
      if (!c) continue; // an entity/turtle mesh: its owner reconciles it, not this
      const show = sectionWithin(c, eye, RENDER_DISTANCE);
      for (const m of entry.meshes) m.visible = show;
      if (show) drawn++;
      else culled++;
      records.push({ key, centre: c, bytes: entry.bytes });
    }
    const plan = planRetention(records, view, opts, maxBytes);
    const gone = new Set(plan.drop);
    for (const key of plan.drop) this.removeSection(key);
    // `this.meshes.bytes` rather than `plan.keptBytes`: the same number the mesher's stop
    // condition reads, so the HUD cannot show a figure under the ceiling while the mesher
    // believes it is over it.
    return {
      drawn,
      culled,
      dropped: plan.drop.length,
      bytes: this.meshes.bytes,
      sections: this.meshes.sectionCount,
      worstScore: worstScoreOf(records.filter((r) => !gone.has(r.key)), view, opts),
    };
  }

  /** Dispose section meshes further than `radius` from the camera; returns how many went. */
  dropSectionsBeyond(radius: number): number {
    const cam = this.camera.position;
    const eye: [number, number, number] = [cam.x, cam.y, cam.z];
    const gone: string[] = [];
    for (const [key, entry] of this.meshes) {
      if (entry.centre && !sectionWithin(entry.centre, eye, radius)) gone.push(key);
    }
    for (const key of gone) this.removeSection(key);
    return gone.length;
  }

  /** Resident section geometry, in bytes as built. The number the byte ceiling is about. */
  get sectionBytes(): number {
    return this.meshes.bytes;
  }

  /** Resident section meshes (entity meshes excluded). */
  get sectionCount(): number {
    return this.meshes.sectionCount;
  }

  removeSection(key: string) {
    this.meshes.remove(key);
  }

  clear() {
    this.meshes.clear();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): ViewerStats {
    const t0 = performance.now();
    // 20 ticks a second, from the wall clock rather than a frame counter: the animation must
    // run at the game's rate whatever the frame rate is, and a dropped frame must not slow
    // the lava down.
    this.animTick.value = t0 / 50;
    this.renderer.render(this.scene, this.camera);
    const dt = performance.now() - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const info = this.renderer.info.render;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return {
      sections: this.meshes.sectionCount,
      quads: this.meshes.quads,
      drawCalls: info.calls,
      triangles: info.triangles,
      fps: avg > 0 ? 1000 / avg : 0,
    };
  }

  /**
   * The same figures `render()` reports, without drawing. Used when the WebGPU shaderpack
   * path owns the screen: the scene graph is still the source of truth for section and
   * quad counts, but issuing a WebGL draw as well would burn a whole frame's GPU time
   * rendering an image nobody sees.
   */
  statsOnly(): ViewerStats {
    const info = this.renderer.info.render;
    return {
      sections: this.meshes.sectionCount,
      quads: this.meshes.quads,
      drawCalls: info.calls,
      triangles: info.triangles,
      fps: 0,
    };
  }

  dispose() {
    this.clear();
    this.ceilTexture.value?.dispose();
    this.texture?.dispose();
    this.renderer.dispose();
  }
}
