/**
 * Isometric / RTS camera — the alternative to standing behind the player's eyes.
 *
 * The camera sits above and behind the character at a fixed angle and looks down at it;
 * you tap the ground to walk there, drag to pan, and pinch or scroll to zoom. There is no
 * mouselook and no WASD, so it is the one camera mode a phone can drive with one thumb.
 *
 * WHY A NARROW PERSPECTIVE CAMERA AND NOT AN ORTHOGRAPHIC ONE. True isometric wants an
 * orthographic projection, but `Viewer` owns one `PerspectiveCamera` and everything
 * downstream is typed on it — the meshing queue sorts by its position, the shaderpack path
 * takes it, `FlyControls` mutates it. Swapping the projection would touch all of that to
 * change how one mode looks. A 26 degree field of view at 40 blocks has a vanishing point
 * far enough away to read as isometric, and it is a two-line change that is exactly undone
 * on the way out.
 *
 * CLICK TO MOVE IS PLANNED, AND IT IS WALKED BY THE GAME'S OWN PHYSICS.
 *
 * WHY THERE IS NO SERVER-SIDE PATHFINDER TO CALL — asked directly on 2026-09-11, rather
 * than assumed. The live server's whole `/help` dump (vanilla plus 130 mods) contains no
 * path, goto or navigate verb; the one bot mod installed is SiliconeDolls, whose entire
 * vocabulary is `spawn|kill|<action>|sneak|unsneak|sprint|unsprint|mount|dismount|look|
 * turn|dropStack|move|hotbar|shadow|stop`. And it is not merely unexposed: `PathNavigation`
 * belongs to `Mob` in Minecraft, and a `ServerPlayer` is not a `Mob` and has no navigator,
 * so there is no player pathfinder on that server to reach — only one that a new mod could
 * build, and loading a mod means restarting the server, which is not ours to do.
 *
 * WHAT IS NATIVE IS THE MOVEMENT, and that turns out to be the half that matters. The walk
 * is executed by `PredictedBody` (predict.ts): the game's own extracted gravity, jump
 * strength, step height and sprint multiplier, integrated against the game's own per-state
 * `VoxelShape` collision. Falling, stepping up, the arc of a jump and the extra reach of a
 * sprint jump are all the engine's answers, not this file's. The planner refuses any move
 * that simulation could not perform, because it derives its jump reach from the same
 * constants — see `jumpSpan` in pathfind.ts.
 *
 * HOW THE BODY IS ACTUALLY DRIVEN, and the bug this replaced. This view used to send
 * `{t:'input', forward:true}` at the bridge. That stopped moving anything the day movement
 * became `tp`-driven: `FakePlayer.input()` no longer issues a `move` command at all
 * (bridge/src/fake-player.mjs), and `LiveView.pushPosition` teleports the bot onto the
 * LOCAL body every frame — a local body that, in this mode, nothing was stepping, because
 * `LiveControls` is unbound here and its intent is all-false. So the character was pinned
 * in place and the walk silently never arrived. It now produces a `PredictIntent` that
 * LiveView feeds to the same simulation WASD drives, and the teleport carries the server
 * body along with it.
 */

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { LOOK_THROTTLE_MS, type ControlIntent } from './live-controls.js';
import { voxelCast, type VoxelHit, type VoxelSource } from './raycast.js';
import {
  DEFAULT_LIMITS, groundWithin, nearestStandable, PathPlanner, smoothPath,
  type Cell, type NavWorld, type Step,
} from './pathfind.js';
import { NO_INTENT, type PredictIntent } from './predict.js';
import { FALLBACK_MOTION, SEED_SPEED, type MotionConstants } from './physics.js';

/** Which camera owns the screen. Not a launch flag — the UI toggles it. */
export type CameraMode = 'first' | 'iso';

/** ~35.3 degrees below horizontal: the angle that makes a cube's three faces equal. */
const ISO_PITCH = -0.6155;
/**
 * How far the elevation may be dragged. Near-overhead at one end (-1.45 rad, about 83
 * degrees down — short of straight down, where the yaw stops meaning anything on screen)
 * and a low oblique at the other (-0.12 rad, about 7 degrees). It must never reach level:
 * `pan` divides by `sin(-pitch)`, which runs to infinity there, and a positive pitch would
 * put the camera under the floor looking up.
 */
const MIN_PITCH = -1.45;
const MAX_PITCH = -0.12;
/** Azimuth. 45 degrees puts the world's axes on the screen diagonals, as isometric does. */
const ISO_YAW = Math.PI / 4;
/**
 * THE ANGLE IS FREE. A drag leaves the view exactly where it was let go.
 *
 * This used to settle onto the nearest quarter turn, for a reason that is still true: the
 * atlas is sampled with `NearestFilter` and no mipmaps and the canvas is created with
 * `antialias: false`, so every block edge is a hard one-pixel step. At 45 degrees those
 * steps land on the screen diagonal and read as the crisp isometric look the mode is named
 * for; off it they are a shallow staircase that crawls as anything moves.
 *
 * It was still the wrong trade. True isometric hides exactly the thing the mode exists to
 * show: with the world axes on the diagonals, walls line up behind each other and there is
 * no parallax to separate them, so you cannot tell which room something is in. Being able
 * to turn a few degrees off the diagonal is what makes the depth readable — "its super hard
 * to determine where shit is in true isometric but unlocked isometric is fine" (the user,
 * 2026-09-11). The shimmer is the price, and it is the cheaper one.
 *
 * 45 degrees is still where the view STARTS, and a quarter turn is still what a full swipe
 * covers; nothing pulls the angle back to either.
 */
/**
 * Screen pixels of horizontal drag for one full turn.
 *
 * 800 puts a quarter turn at 200 px: a comfortable thumb-swipe on a phone and a short
 * flick with a mouse, and slow enough that a drag meant as a tap does not spin the world.
 */
const ROTATE_PX_PER_TURN = 800;
/** Narrow enough to read as isometric; see the note above on why this is not orthographic. */
const ISO_FOV = 26;

const MIN_DIST = 10;
const MAX_DIST = 160;
const DEFAULT_DIST = 44;
const ZOOM_STEP = 1.12;

/**
 * How far the view may be panned off the character, in blocks.
 *
 * Clamped rather than free: this camera follows a character, and a pan that can leave it
 * off screen produces a mode where the thing you are controlling is nowhere to be found
 * and no gesture obviously brings it back.
 */
const MAX_PAN = 48;

/**
 * How close to a waypoint counts as reaching it.
 *
 * Waypoints are block CENTRES and the character is 0.6 wide, so this cannot be tight
 * without the walk stalling on every corner. 0.7 is comfortably inside the next cell.
 */
const WAYPOINT_BLOCKS = 0.7;
/** Waypoints on other floors are not this one; a drop must not tick the next leg early. */
const WAYPOINT_HEIGHT = 1.6;
/**
 * How close the LAST waypoint has to be before the walk is over.
 *
 * Much tighter than `WAYPOINT_BLOCKS`, because the two answer different questions. 0.7 is
 * "close enough to start walking the next leg", which is the right answer mid-route — the
 * next cell is already known to be walkable from here. At the destination there is no next
 * leg, and stopping 0.7 blocks out is a character standing beside the block you tapped.
 *
 * Reachable only because the body eases in: see `approach`.
 */
const ARRIVE_BLOCKS = 0.22;
/**
 * Inside this distance from the final waypoint the body walks at reduced speed.
 *
 * Without it the last leg oscillates: the simulation SETS horizontal velocity rather than
 * accelerating toward it (predict.ts), so at 4.3 blocks/s a 60 Hz frame moves 0.07 blocks
 * and full speed overshoots a 0.22 target about as often as it hits it. Easing down makes
 * the final approach converge instead of hunting.
 */
const SLOW_RADIUS = 1.1;
/** Slowest the ease-in goes, as a fraction of walking speed. Below this it never arrives. */
const SLOW_FLOOR = 0.22;
/** How many waypoints ahead an overshoot may be recognised at. See `consume`. */
const LOOKAHEAD_LEGS = 4;
/** Progress smaller than this over `STUCK_MS` means the steering is not getting there. */
const PROGRESS_BLOCKS = 0.05;
/**
 * A leg at least this long and entirely flat is worth sprinting.
 *
 * Only on the straightened route, where a leg really is a long open run — the planner has
 * already agreed the whole thing is walkable. Short legs are not sprinted because the
 * acceleration is instantaneous in this simulation and sprinting a two-block leg only
 * makes the arrival harder to land.
 */
const SPRINT_MIN_BLOCKS = 6;
/**
 * How far ahead the ledge guard looks, in blocks.
 *
 * Just past the body's own half-width (0.3), so it sees the cell it is about to enter
 * rather than the one it is standing in.
 */
const LEDGE_LOOKAHEAD = 0.75;
/**
 * How long a leg may make no progress before the route is re-planned.
 *
 * Much shorter than the four seconds the old steering waited, because this is no longer a
 * guess: the plan said this leg was walkable, so failing to walk it means the world is not
 * what the plan thought and the answer is a new plan, not more shoving.
 */
const STUCK_MS = 1200;
/**
 * How many times a stuck leg may be re-planned before the walk is abandoned.
 *
 * Bounded because a re-plan from a position the steering cannot leave produces the same
 * plan, and repeating that is the four-second shove with extra steps.
 */
const MAX_STUCK_REPLANS = 3;
/**
 * The whole walk's deadline, in milliseconds.
 *
 * THE REQUIREMENT IS "IT ARRIVES, OR IT SAYS IT CANNOT" — never "it keeps trying". Every
 * other give-up here is local: this leg is not progressing, this search found nothing. A
 * route that re-plans forever without ever being stuck on any single leg — a partial path
 * that keeps gaining three blocks and giving them back, a destination inside a loading
 * chunk edge that moves as the world streams — satisfies all of them and still never
 * ends. 90 seconds is far longer than any walk this planner will ever legitimately
 * produce (its radius is 64 blocks and the body covers 4.3 a second) and short enough
 * that a walk that is going nowhere says so while anybody is still watching.
 */
const WALK_DEADLINE_MS = 90_000;
/**
 * Node expansions per frame.
 *
 * The search is resumable so that a phone never pays for a whole plan in one frame. 600 is
 * a fraction of a millisecond, and the default 6000-node budget therefore finishes within
 * ten frames — under 200 ms, which is faster than the character can start walking anyway.
 */
const PLAN_BUDGET = 600;
/** Camera-to-ground can be 160 blocks plus the terrain behind it. */
const PICK_RANGE = 400;

/** A press this short that travelled this little was a tap, not a pan. */
const TAP_SLOP_PX = 10;
const TAP_MS = 400;

export interface IsoViewDeps {
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  world: VoxelSource;
  /** The same blocks, asked the questions a walking body asks. See nav-world.ts. */
  nav: NavWorld;
  /**
   * Blocks the reveal has taken out of the picture, so a click means what is on screen.
   *
   * Optional: the drag-and-drop and save-file paths have no reveal, and a picker that agreed
   * with a reveal that is not running would be agreeing with nothing.
   */
  revealHides?: (x: number, y: number, z: number) => boolean;
  send: (msg: ControlIntent) => void;
  /**
   * The constants the LOCAL SIMULATION is running on, right now.
   *
   * A callback rather than a value because both halves move: `physics.json` lands a second
   * or two after the page does, and the walking speed is MEASURED from the server's own
   * reports and keeps converging (predict.ts `observe`). The planner has to work out how
   * far a jump carries the body from whatever the body is actually using this frame — a
   * planner using the seed speed while the body walks 15% faster plans a jump the body
   * overshoots, and one using stale gravity plans a jump it cannot make.
   *
   * Optional: without it the fallbacks are used, which is exactly what the body itself
   * does before the table lands, so the two still agree.
   */
  motion?: () => { motion: MotionConstants; speed: number };
  /**
   * Name the subject that must stay visible, or null to draw everything untouched.
   *
   * THIS IS THE REQUIREMENT THAT MAKES THE MODE USABLE — you must be able to see the thing
   * you are driving. The renderer answers it per fragment: what is inside a small disc
   * around the subject on screen AND nearer to the camera than the subject is, is faded
   * out; everything else is drawn exactly as it always was.
   *
   * It used to be a cutaway HEIGHT, `playerY + 3`, and that was wrong twice over. A height
   * has no idea where the camera is, so it removed every block above it anywhere in the
   * world — you saw through walls that were never in the way and the world looked
   * roofless. And it tracked the player's Y, so one step up moved the cut for the entire
   * scene and distant walls jumped up and down as you walked. Neither symptom is fixable
   * by choosing a better height; the question was wrong.
   */
  setSubject: (pos: readonly [number, number, number] | null) => void;
}

interface Point { x: number; y: number }

/**
 * Click-to-walk in the isometric view: ON.
 *
 * It was off, and this records why, because the reason was not the one the switch said it
 * was. The comment here blamed "the pathing" and the planner was largely fine; what was
 * broken was the DRIVE. This view was sending `{t:'input', forward:true}` to a bridge that
 * had stopped turning input frames into movement, at a body that was being teleported onto
 * a local simulation nothing in this mode was stepping. Every layer reported success and
 * the character never moved a block. See the note at the head of this file.
 *
 * Deliberately still a module constant rather than an option: if this ever has to come out
 * again it should come out in one place, not from configuration.
 */
export const CLICK_TO_WALK_ENABLED = true;

export class IsoView {
  private bound = false;
  private detach: Array<() => void> = [];
  private savedFov = 0;

  /** Camera framing. Public so the tests can read where it ended up. */
  dist = DEFAULT_DIST;
  panX = 0;
  panZ = 0;
  yaw = ISO_YAW;
  /** Elevation, negative meaning "looking down". Starts at the isometric angle. */
  pitch = ISO_PITCH;

  /** Live touch points by identifier, so a pinch can be told from a pan. */
  private points = new Map<number, Point>();
  private gesture:
    { x: number; y: number; travel: number; at: number; mode: 'rotate' | 'pan' } | null = null;
  private pinch = 0;

  /** The cell the player asked for, or null when there is no walk in progress. */
  private goal: Cell | null = null;
  /** The search, while it is running. Null once it has an answer. */
  private planner: PathPlanner | null = null;
  /** The route being walked, and how far along it we are. */
  private path: Step[] = [];
  private leg = 0;
  /** True when `path` stops short of the goal and has to be extended on arrival. */
  private pathPartial = false;
  private stuckReplans = 0;
  /** Where the current plan was made from, which is where smoothing has to start. */
  private planStart: Cell = [0, 0, 0];
  private sentYaw = NaN;
  private lastLookSent = 0;
  private lastLegDist = Infinity;
  private lastProgressAt = 0;
  /** When the tap landed, so a walk that never ends can be ended. See WALK_DEADLINE_MS. */
  private walkStartedAt = 0;

  /**
   * What the body is being told to do this frame, and which way "forward" is.
   *
   * THIS IS THE OUTPUT OF THIS CLASS. `LiveView` hands it to the same `PredictedBody.step`
   * that WASD drives, so the route is walked by the game's own physics — see the note at
   * the head of this file. The yaw is separate from the camera's because the camera is
   * free to be turned while the character walks somewhere else.
   */
  private moveIntent: PredictIntent = { ...NO_INTENT };
  private bodyYaw = 0;

  /**
   * What the walk is doing, in one word, for the HUD.
   *
   * On screen on purpose. "It did not go" has three completely different causes — no route
   * exists, the route exists and the steering cannot follow it, or the search is still
   * running — and without this they are one silent failure.
   */
  walkStatus: 'idle' | 'planning' | 'walking' | 'arrived' | 'no path' | 'stuck' = 'idle';

  constructor(private deps: IsoViewDeps) {}

  get active(): boolean {
    return this.bound;
  }

  /** The destination cell, or null when standing still. */
  get walkTarget(): Cell | null {
    return this.goal;
  }

  /** The route as planned, for the tests and the on-screen count. */
  get plannedPath(): readonly Step[] {
    return this.path;
  }

  /**
   * What the locally-simulated body should be doing this frame.
   *
   * The SAME shape `LiveControls.intent()` returns, and consumed by the same
   * `PredictedBody.step`, because "walk there" and "hold W" must not be two different kinds
   * of movement with two sets of bugs.
   */
  intent(): PredictIntent {
    return this.moveIntent;
  }

  /** Which way the body walks. Not the camera's yaw — the view turns freely while it walks. */
  get walkYaw(): number {
    return this.bodyYaw;
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.savedFov = this.deps.camera.fov;
    this.deps.camera.fov = ISO_FOV;
    this.deps.camera.updateProjectionMatrix();
    this.bindMouse();
    this.bindTouch();
  }

  /** Puts back everything `bind` changed, including the field of view and the reveal. */
  unbind(): void {
    if (!this.bound) return;
    for (const off of this.detach) off();
    this.detach = [];
    this.bound = false;
    this.stop();
    this.points.clear();
    this.gesture = null;
    this.panX = 0;
    this.panZ = 0;
    // The ANGLE is deliberately kept: turn the view, switch to first person and back, and
    // it is still the way you left it.
    if (this.savedFov) {
      this.deps.camera.fov = this.savedFov;
      this.deps.camera.updateProjectionMatrix();
    }
    this.deps.setSubject(null);
  }

  /**
   * One frame: put the camera where it belongs, tell the renderer what must stay visible,
   * and take one step of the walk it was told to make.
   *
   * ORDER MATTERS. The camera is placed first because the reveal projects the subject
   * through it, and projecting through last frame's camera puts the hole where the
   * character was, not where it is — which is exactly the popping this replaced.
   */
  update(pos: readonly [number, number, number], now = performance.now()): void {
    this.steer(pos, now);
    this.frame(pos);
  }

  /**
   * Work out what the body should do this frame. Call BEFORE stepping the simulation.
   *
   * Split from `frame` because of an ordering the combined call could not express: the
   * intent has to be decided from where the body IS, the body is then stepped with it, and
   * the camera has to be placed at where the body ENDED UP. Doing all three in one call put
   * the camera a frame behind the character it exists to follow.
   */
  steer(pos: readonly [number, number, number], now = performance.now()): void {
    this.navigate(pos, now);
  }

  /**
   * Put the camera where it belongs and tell the renderer what must stay visible.
   *
   * ORDER MATTERS. The camera is placed first because the reveal projects the subject
   * through it, and projecting through last frame's camera puts the hole where the
   * character was, not where it is — which is exactly the popping this replaced.
   */
  frame(pos: readonly [number, number, number]): void {
    this.place(pos);
    this.deps.setSubject(pos);
  }

  // -------------------------------------------------------------------------
  // Camera

  /** Focus point: the character, plus however far the view has been panned off it. */
  private focus(pos: readonly [number, number, number]): [number, number, number] {
    return [pos[0] + this.panX, pos[1] + 1, pos[2] + this.panZ];
  }

  private place(pos: readonly [number, number, number]): void {
    const cam = this.deps.camera;
    const f = this.focus(pos);
    const cp = Math.cos(this.pitch);
    // The camera's own facing vector, three.js convention — the same one the first-person
    // path and the bridge's angle conversion use, so "yaw" means one thing in this app.
    const dir = [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
    cam.position.set(f[0] - dir[0] * this.dist, f[1] - dir[1] * this.dist, f[2] - dir[2] * this.dist);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    // Picking unprojects through this matrix, and nothing else updates it until the
    // renderer draws — which is after the tap has already been resolved.
    cam.updateMatrixWorld();
  }

  /**
   * Orbit the view around the character: azimuth from horizontal drag, elevation from
   * vertical, both in screen pixels.
   *
   * The pitch used to be fixed at ISO_PITCH — the angle that makes a cube's three faces
   * equal — because that angle IS the definition of this camera. It is draggable now for
   * the same reason the yaw is: one fixed viewpoint cannot see into a building whose walls
   * happen to line up with it, and tilting is the cheapest way to look under an overhang.
   *
   * THE CLAMP IS LOAD BEARING, at both ends. `pan` divides by `sin(-pitch)` to keep the
   * ground under the finger, which runs away to infinity as the pitch approaches level; and
   * a positive pitch would put the camera underground looking up through the floor. So the
   * range stops short of both: near-overhead down to a low oblique, never level, never below.
   */
  rotate(dxPx: number, dyPx = 0): void {
    this.yaw += dxPx * ((2 * Math.PI) / ROTATE_PX_PER_TURN);
    // SAME SIGN CONVENTION AS THE YAW, which moves the CAMERA with the finger rather than
    // the world: drag right and the camera swings right, so drag down and it drops towards
    // the horizon. The opposite sign reads as "the world tips", and mixing the two in one
    // gesture makes a diagonal drag feel like it is fighting itself.
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH,
      this.pitch + dyPx * ((2 * Math.PI) / ROTATE_PX_PER_TURN)));
  }

  zoomBy(factor: number): void {
    this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.dist * factor));
  }

  /**
   * Pan so the ground stays under the finger.
   *
   * Screen pixels become blocks through the camera's own frustum rather than a tuned
   * constant, so the grab stays honest at every zoom level. The vertical term is stretched
   * by the view angle: looking down at 35 degrees, a pixel of screen height covers 1/sin
   * of that much ground.
   */
  pan(dx: number, dy: number): void {
    const height = this.deps.canvas.clientHeight || 1;
    const perPx = (2 * this.dist * Math.tan((ISO_FOV * Math.PI) / 360)) / height;
    // The LIVE pitch, not the constant: the whole point of this factor is that a pixel of
    // screen height covers 1/sin(pitch) of ground, and the pitch moves now.
    const stretch = perPx / Math.sin(-this.pitch);
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // right = (cos, -sin), ground-forward = (-sin, -cos)
    this.panX += -c * dx * perPx + -s * dy * stretch;
    this.panZ += s * dx * perPx + -c * dy * stretch;
    const far = Math.hypot(this.panX, this.panZ);
    if (far > MAX_PAN) {
      this.panX = (this.panX / far) * MAX_PAN;
      this.panZ = (this.panZ / far) * MAX_PAN;
    }
  }

  // -------------------------------------------------------------------------
  // Walking

  /**
   * Send the character to whatever block is under this screen point.
   *
   * Returns false when the tap hit sky, which must NOT be treated as "walk somewhere
   * arbitrary" — a tap on the horizon that set off a march to the edge of the render
   * distance is worse than a tap that does nothing.
   *
   * Nothing is planned here. Planning needs the character's CURRENT position and this is
   * an input handler, which runs whenever a thumb lifts; the plan is started on the next
   * frame, from the position that frame was given.
   */
  walkTo(clientX: number, clientY: number, now = performance.now()): boolean {
    // Returning false is what makes a click do NOTHING rather than send the character
    // somewhere wrong — the caller treats false as "that press was not a destination".
    // That is also what the OFF state of the flag buys, which is why it is checked here and
    // nowhere else: one switch, one behaviour.
    if (!CLICK_TO_WALK_ENABLED) return false;
    const hit = this.pick(clientX, clientY);
    if (!hit) return false;
    // Stand ON the block that was tapped, not inside it.
    return this.walkToCell([hit.block[0], hit.block[1] + 1, hit.block[2]], now);
  }

  /**
   * Send the character to a named cell.
   *
   * Split out of `walkTo` because "which block did that tap land on" and "go there" are two
   * different jobs and only the first one needs a camera. It is also the only way to ask for
   * a destination in a test without reaching into a private field, which is what the walking
   * tests used to do — and a test that sets private state is a test that keeps passing after
   * the thing it pokes stops being how the walk starts.
   */
  walkToCell(cell: Cell, now = performance.now()): boolean {
    this.goal = [cell[0], cell[1], cell[2]];
    this.planner = null;
    this.path = [];
    this.leg = 0;
    this.pathPartial = false;
    this.stuckReplans = 0;
    this.walkStartedAt = now;
    this.walkStatus = 'planning';
    return true;
  }

  private pick(clientX: number, clientY: number): VoxelHit | null {
    const c = this.deps.canvas;
    const w = c.clientWidth || 1;
    const h = c.clientHeight || 1;
    const at = new Vector3((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1, 0.5);
    at.unproject(this.deps.camera);
    const cam = this.deps.camera.position;
    const dir = at.sub(cam);
    const len = dir.length();
    if (!len) return null;
    dir.divideScalar(len);
    return voxelCast(this.deps.world, cam, [dir.x, dir.y, dir.z], PICK_RANGE, this.deps.revealHides);
  }

  // -------------------------------------------------------------------------
  // Walking: plan, then follow.
  //
  // The follower's whole job is to turn a route into a `PredictIntent` — which way is
  // forward, whether to sprint, whether to jump — and hand it to the game's own physics.
  // It never moves the body itself, which is what keeps "walk there" and "hold W" the same
  // motion with the same collisions and the same failure modes.

  /** One frame of the walk: keep searching, or take one step along what was found. */
  private navigate(pos: readonly [number, number, number], now: number): void {
    if (!this.goal) {
      this.halt();
      return;
    }
    if (now - this.walkStartedAt > WALK_DEADLINE_MS) {
      // THE OUTERMOST GIVE-UP. Every other one is about a single leg or a single search;
      // this is the one that makes "it always arrives or says it cannot" true even when no
      // individual step ever looks wrong. See WALK_DEADLINE_MS.
      this.giveUp('stuck');
      return;
    }
    if (this.planner) {
      // Standing still while the search runs. A character that sets off before it knows
      // where it is going is the steering this replaced.
      this.halt();
      this.advanceSearch();
      return;
    }
    if (!this.path.length) {
      this.halt();
      this.plan(pos, now);
      return;
    }
    this.follow(pos, now);
  }

  /**
   * Start a search from where the character actually is.
   *
   * Both ends are snapped to a cell a body can stand in. The start needs it because the
   * server's position is a float that can sit a hair inside a block or on a slab; the goal
   * needs it because a tap lands on a block FACE, and the cell above the side of a wall is
   * not somewhere anyone can stand. Snapping is deliberately short-range — walking
   * somewhere the player did not point at is its own bug.
   */
  private plan(pos: readonly [number, number, number], now: number): void {
    const nav = this.deps.nav;
    const here = cellOf(pos);
    const start = nearestStandable(nav, here, 2) ?? here;
    const goal = this.goal && nearestStandable(nav, this.goal, 3);
    if (!goal) {
      this.giveUp('no path');
      return;
    }
    if (start[0] === goal[0] && start[1] === goal[1] && start[2] === goal[2]) {
      this.arrive();
      return;
    }
    this.goal = goal;
    this.planStart = start;
    this.planner = new PathPlanner(nav, start, goal, this.jumpLimits());
    this.lastProgressAt = now;
    this.walkStatus = 'planning';
  }

  /**
   * What the planner is allowed to assume about the body, read off the body itself.
   *
   * The point of asking every time rather than once at construction: `physics.json` lands
   * after the page does and the walking speed keeps being re-measured from the server's
   * reports, so a plan made now must be made against what the simulation will actually run
   * when it walks it. A jump planned on a speed the body no longer has is a jump into a
   * hole — which is exactly the class of bug the whole "derive it, never type it in" rule
   * in pathfind.ts exists to prevent.
   */
  private jumpLimits(): { motion: MotionConstants; walkSpeed: number } {
    const m = this.deps.motion?.();
    return {
      motion: m?.motion ?? FALLBACK_MOTION,
      walkSpeed: m && m.speed > 0 ? m.speed : SEED_SPEED,
    };
  }

  /** Spend one frame's budget on the search, and take the answer if there is one. */
  private advanceSearch(): void {
    const planner = this.planner;
    if (!planner) return;
    const state = planner.step(PLAN_BUDGET);
    if (state === 'searching') return;
    this.planner = null;
    if (state === 'unreachable' || !planner.path.length) {
      // THE HONEST GIVE-UP. There is no route, so the character does not move at all —
      // rather than setting off in the general direction and shoving into a wall for four
      // seconds, which is what "click to move" used to do here and what it looked like.
      this.giveUp('no path');
      return;
    }
    // Straightened before it is walked. A* returns a staircase of single cells and the
    // follower re-aims the body at every one of them; measured against the live server,
    // that turned a ten-cell route into four blocks of travel in a minute of turning on
    // the spot. See smoothPath — which cannot merge across a jump, so every jump survives
    // as a leg of its own and the follower always knows where the take-off is.
    this.path = smoothPath(this.deps.nav, this.planStart, planner.path);
    this.pathPartial = planner.partial;
    this.leg = 0;
    this.lastLegDist = Infinity;
    this.walkStatus = 'walking';
  }

  /** Steer towards the current waypoint, and move on when it is reached. */
  private follow(pos: readonly [number, number, number], now: number): void {
    if (this.consume(pos)) {
      this.lastLegDist = Infinity;
      this.lastProgressAt = now;
      this.stuckReplans = 0;
    }
    const step = this.path[this.leg];
    const dx = step.cell[0] + 0.5 - pos[0];
    const dz = step.cell[2] + 0.5 - pos[2];
    const d = Math.hypot(dx, dz);
    // The final approach is eased only on the REAL destination: a partial route's last
    // waypoint is a mid-route one and slowing for it would make a long walk a series of
    // creeps.
    const last = this.leg === this.path.length - 1 && !this.pathPartial;
    if (this.leg === this.path.length - 1 && this.endOfRoute(pos, step.cell, d)) return;
    this.face(dx, dz, now);
    if (step.move === 'walk' && this.overLedge(pos, dx, dz)) {
      // THE PLAN DID NOT AUTHORISE THIS DROP. Either the world changed under the route (a
      // turtle mined the floor) or the chunk ahead unloaded and stopped being walkable.
      //
      // STAND STILL — do not re-plan from here. Re-planning was the first version of this
      // and it was wrong in a way only the live server showed: this runs every frame, so a
      // body sitting at a lip burned all three re-plans in four frames and the walk gave up
      // 0.2 seconds after it started. The guard's job is only "do not take that step". The
      // stuck detector below already owns "this leg is not working", it owns it on a 1.2
      // second clock, and it escalates to a re-plan and then to an honest refusal by itself.
      this.halt();
      this.watchProgress(d, now);
      return;
    }
    this.moveIntent = this.driveFor(step, pos, d, last);
    this.watchProgress(d, now);
  }

  /**
   * Standing on the last waypoint. Is that the destination, or only as far as the plan got?
   *
   * TWO TOLERANCES, because the two answers are not the same question. A PARTIAL route ends
   * where a capped search ran out, so its last waypoint is an ordinary mid-route one and the
   * loose tolerance is right — the next stretch is planned from there and the walk carries
   * on. The real destination gets the tight one, because there is no next leg to absorb the
   * error and stopping three quarters of a block short of the block you tapped is the
   * failure this whole feature is about.
   *
   * Getting this wrong in the obvious direction is worse than it looks: a partial route
   * judged by the tight tolerance would report ARRIVED in the middle of a long walk, which
   * is a silent failure with a success message on it.
   */
  private endOfRoute(pos: readonly [number, number, number], cell: Cell, d: number): boolean {
    if (Math.abs(cell[1] - pos[1]) >= WAYPOINT_HEIGHT) return false;
    if (this.pathPartial) {
      if (d > WAYPOINT_BLOCKS) return false;
      this.halt();
      this.path = [];
      this.leg = 0;
      this.pathPartial = false;
      this.walkStatus = 'planning';
      return true;
    }
    if (d > ARRIVE_BLOCKS) return false;
    this.arrive();
    return true;
  }

  /**
   * The intent for one frame of one leg: how fast, whether to sprint, whether to jump.
   *
   * `analog` rather than `forward` on the final approach, because it is the only way to ask
   * for PART of walking speed — the boolean is all or nothing, and all-or-nothing overshoots
   * a 0.22-block target. It also keeps the speed calibration honest: `PredictedBody.observe`
   * only measures sample pairs where exactly one direction boolean was held, so a
   * deliberately-slowed approach is excluded from the measurement instead of dragging it
   * down. See SLOW_RADIUS.
   */
  private driveFor(
    step: Step,
    pos: readonly [number, number, number],
    d: number,
    last: boolean,
  ): PredictIntent {
    const jump = this.wantsJump(step, pos, d);
    const sprint = step.move === 'sprint' || (step.move === 'walk' && d >= SPRINT_MIN_BLOCKS);
    if (last && d < SLOW_RADIUS) {
      const m = Math.max(SLOW_FLOOR, d / SLOW_RADIUS);
      return { ...NO_INTENT, jump, analog: { x: 0, y: m } };
    }
    return { ...NO_INTENT, forward: true, sprint, jump };
  }

  /**
   * Tick off every waypoint the character is standing on, and return whether any went.
   *
   * It looks a few legs AHEAD rather than only at the current one, because the character
   * routinely overshoots: the server reports its position ten times a second and it walks
   * at 4.3 blocks a second, so a late sample can land it past a waypoint entirely. Without
   * the lookahead the walk would then turn round to collect a waypoint behind it, which
   * reads as the character dithering — and the whole point of a plan is that the next cell
   * is already known to be walkable from here.
   *
   * THE LAST WAYPOINT IS NEVER CONSUMED HERE. Arrival is decided in `follow` against the
   * much tighter `ARRIVE_BLOCKS`, and letting the loose mid-route tolerance tick off the
   * destination is precisely how the character used to stop three quarters of a block short
   * of the block you tapped and call it done.
   */
  private consume(pos: readonly [number, number, number]): boolean {
    const limit = Math.min(this.leg + LOOKAHEAD_LEGS, this.path.length - 2);
    let hit = -1;
    for (let i = this.leg; i <= limit; i++) if (this.reached(pos, this.path[i].cell)) hit = i;
    if (hit < 0) return false;
    this.leg = hit + 1;
    return true;
  }

  private reached(pos: readonly [number, number, number], cell: Cell): boolean {
    const d = Math.hypot(cell[0] + 0.5 - pos[0], cell[2] + 0.5 - pos[2]);
    return d <= WAYPOINT_BLOCKS && Math.abs(cell[1] - pos[1]) < WAYPOINT_HEIGHT;
  }

  /**
   * Should the body jump this frame?
   *
   * TWO DIFFERENT JUMPS, because they are known in two different ways.
   *
   * A GAP is known from the ROUTE: the planner proved the body's own constants carry it far
   * enough (pathfind.ts `jumpSpan`) and labelled the waypoint `jump` or `sprint`. The only
   * thing left to get right is WHEN, and the answer is "at or past the take-off cell's
   * centre" — the planner measured the jump centre to centre, so leaving early spends reach
   * that was never budgeted. That is what the projection below tests: it is negative while
   * the body is still short of the take-off and crosses zero exactly on it.
   *
   * A STEP UP is known from the TERRAIN, because it cannot be known from the route: legs
   * are straightened before they are walked, and a ten-block leg carries no record of where
   * the one-block rise in the middle of it was. Read off the block directly in front — solid
   * at foot level with two blocks of air over it — which is a step and nothing else. The
   * simulation steps 0.6 of a block by itself (slabs, stair treads), so this fires only for
   * the full block that really does need a jump.
   *
   * The old steering jumped every 600 ms whenever it had stopped making progress, which is
   * a guess made after the fact and fires just as often at a wall it can never climb. There
   * is no timer here at all: the simulation ignores `jump` unless the body is on the ground,
   * so holding it for a leg costs nothing and fires it at the first possible instant.
   */
  private wantsJump(step: Step, pos: readonly [number, number, number], d: number): boolean {
    if (step.move === 'walk') return this.stepAhead(pos, step.cell);
    const takeoff = this.leg > 0 ? this.path[this.leg - 1].cell : this.planStart;
    if (!d) return true;
    const dirX = (step.cell[0] + 0.5 - pos[0]) / d;
    const dirZ = (step.cell[2] + 0.5 - pos[2]) / d;
    const along = (pos[0] - (takeoff[0] + 0.5)) * dirX + (pos[2] - (takeoff[2] + 0.5)) * dirZ;
    return along >= 0;
  }

  /** A full block to climb, directly in front of the feet. See `wantsJump`. */
  private stepAhead(pos: readonly [number, number, number], toward: Cell): boolean {
    const dx = toward[0] + 0.5 - pos[0];
    const dz = toward[2] + 0.5 - pos[2];
    const len = Math.hypot(dx, dz);
    if (!len) return false;
    const x = Math.floor(pos[0] + (dx / len) * LEDGE_LOOKAHEAD);
    const z = Math.floor(pos[2] + (dz / len) * LEDGE_LOOKAHEAD);
    const y = Math.floor(pos[1] + 0.001);
    const nav = this.deps.nav;
    if (nav.classify(x, y, z) !== 'solid') return false;
    return nav.classify(x, y + 1, z) === 'air' && nav.classify(x, y + 2, z) === 'air';
  }

  /**
   * Is the cell the body is about to walk into a drop the plan never agreed to?
   *
   * "Never path off a ledge" is two requirements, not one. The planner covers the first —
   * it has no edge that drops further than `maxFall`. This covers the second: the body is
   * steered, not railed, so it can leave the planned line by a fraction of a block on a
   * corner, and the world can change under a route that was correct when it was made. A
   * column with nowhere to stand within a safe drop is a fall, and the body stops rather
   * than taking the step that starts it.
   *
   * Asks `groundWithin`, the same question the planner asks, so the two cannot disagree
   * about what counts as a ledge. Unloaded chunks answer "no ground", which is the right
   * answer: walking off the edge of the streamed world is the same accident.
   */
  private overLedge(pos: readonly [number, number, number], dx: number, dz: number): boolean {
    const len = Math.hypot(dx, dz);
    if (!len) return false;
    const x = Math.floor(pos[0] + (dx / len) * LEDGE_LOOKAHEAD);
    const z = Math.floor(pos[2] + (dz / len) * LEDGE_LOOKAHEAD);
    if (x === Math.floor(pos[0]) && z === Math.floor(pos[2])) return false;
    const y = Math.floor(pos[1] + 0.001);
    return !groundWithin(this.deps.nav, x, y, z, DEFAULT_LIMITS.maxFall);
  }

  /**
   * A leg that stops closing is a leg the world disagrees with the plan about.
   *
   * Re-plan rather than push harder: the terrain may have changed under a turtle, or the
   * character may be caught on geometry the block grid does not model (a fence gate, a
   * chest lid). A few of those and the walk is given up, because re-planning from a
   * position the steering cannot leave produces the same plan.
   */
  private watchProgress(d: number, now: number): void {
    if (d < this.lastLegDist - PROGRESS_BLOCKS) {
      this.lastLegDist = d;
      this.lastProgressAt = now;
      return;
    }
    if (now - this.lastProgressAt < STUCK_MS) return;
    this.replan(now);
  }

  /** Throw the route away and plan again, or give up if that has been tried enough. */
  private replan(now: number): void {
    this.halt();
    if (++this.stuckReplans > MAX_STUCK_REPLANS) {
      this.giveUp('stuck');
      return;
    }
    this.path = [];
    this.leg = 0;
    this.pathPartial = false;
    this.lastProgressAt = now;
    this.walkStatus = 'planning';
  }

  private arrive(): void {
    this.stop();
    this.walkStatus = 'arrived';
  }

  private giveUp(why: 'no path' | 'stuck'): void {
    this.stop();
    this.walkStatus = why;
  }

  /** Cancel the walk and make sure the character is actually told to stand still. */
  stop(): void {
    this.goal = null;
    this.planner = null;
    this.path = [];
    this.leg = 0;
    this.pathPartial = false;
    this.stuckReplans = 0;
    this.walkStatus = 'idle';
    this.halt();
  }

  /** Stand still. Does not touch the plan. */
  private halt(): void {
    this.moveIntent = { ...NO_INTENT };
  }

  /**
   * Point the body at the target.
   *
   * TWO CONSUMERS, ONE ANGLE, AND ONLY ONE OF THEM IS THROTTLED. The local simulation walks
   * along `bodyYaw` and needs it every frame or the body walks last frame's direction; the
   * SERVER only needs it so the bot is drawn facing the right way, and that goes out at the
   * same rate mouse-look does. Throttling both — which is what this used to do, because
   * there was only the server — would have made every turn a step in the wrong direction.
   */
  private face(dx: number, dz: number, now: number): void {
    const yaw = Math.atan2(-dx, -dz);
    this.bodyYaw = yaw;
    const turned = Number.isNaN(this.sentYaw) ? Infinity : Math.abs(wrapPi(yaw - this.sentYaw));
    if (turned < 0.02) return;
    if (now - this.lastLookSent < LOOK_THROTTLE_MS) return;
    this.lastLookSent = now;
    this.sentYaw = yaw;
    // Pitch level: an RTS character looks where it walks, not at its feet.
    this.deps.send({ t: 'look', yaw, pitch: 0 });
  }


  // -------------------------------------------------------------------------
  // Input

  private on<K extends keyof (WindowEventMap & DocumentEventMap)>(
    target: EventTarget,
    type: K,
    fn: (e: (WindowEventMap & DocumentEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const handler = fn as EventListener;
    target.addEventListener(type, handler, options);
    this.detach.push(() => target.removeEventListener(type, handler, options));
  }

  private bindMouse(): void {
    const c = this.deps.canvas;
    // Primary button turns the view; right button pans. Two different things to do with a
    // drag, and turning is the one you reach for constantly — so it gets the plain drag.
    this.on(c, 'mousedown', (e) => this.gestureStart(
      e.clientX, e.clientY, e.button === 0 ? 'rotate' : 'pan',
    ));
    this.on(window, 'mousemove', (e) => this.gestureMove(e.clientX, e.clientY));
    this.on(window, 'mouseup', (e) => this.gestureEnd(e.clientX, e.clientY));
    this.on(c, 'wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    }, { passive: false });
    this.on(window, 'contextmenu', (e) => {
      if (e.target === c) e.preventDefault();
    });
  }

  private bindTouch(): void {
    const opts = { passive: false } as const;
    const c = this.deps.canvas;
    this.on(c, 'touchstart', (e) => this.onTouchStart(e), opts);
    this.on(c, 'touchmove', (e) => this.onTouchMove(e), opts);
    this.on(c, 'touchend', (e) => this.onTouchEnd(e), opts);
    this.on(c, 'touchcancel', (e) => this.onTouchEnd(e), opts);
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      this.points.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (this.points.size === 1) {
      const [p] = [...this.points.values()];
      this.gestureStart(p.x, p.y, 'rotate');
      return;
    }
    // A second finger turns whatever this was into a pinch; it is no longer a tap. The
    // angle the first finger reached simply stays: there is nothing to release it to.
    this.gesture = null;
    this.pinch = this.spread();
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    // Where the two fingers were centred BEFORE this move: two fingers sliding together
    // pan, which is where panning went when the one-finger drag became the turn.
    const from = this.midpoint();
    for (const t of Array.from(e.changedTouches)) {
      const p = this.points.get(t.identifier);
      if (!p) continue;
      if (this.points.size === 1) this.gestureMove(t.clientX, t.clientY);
      p.x = t.clientX;
      p.y = t.clientY;
    }
    if (this.points.size < 2) return;
    const now = this.spread();
    if (this.pinch > 0 && now > 0) this.zoomBy(this.pinch / now);
    this.pinch = now;
    const to = this.midpoint();
    if (from && to) this.pan(to.x - from.x, to.y - from.y);
  }

  /** Centre of the two live touch points, or null when there are not two. */
  private midpoint(): Point | null {
    if (this.points.size < 2) return null;
    const [a, b] = [...this.points.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  }

  private onTouchEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      const p = this.points.get(t.identifier);
      this.points.delete(t.identifier);
      if (p && this.points.size === 0) this.gestureEnd(p.x, p.y);
    }
    if (this.points.size < 2) this.pinch = 0;
  }

  private spread(): number {
    const [a, b] = [...this.points.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  // One drag/tap resolver for mouse and touch alike: a press that moves is a pan, and a
  // press that does not is a destination. Same rule both ways, so the gesture you learn
  // with a mouse is the gesture that works with a thumb.

  private gestureStart(x: number, y: number, mode: 'rotate' | 'pan'): void {
    this.gesture = { x, y, travel: 0, at: performance.now(), mode };
  }

  private gestureMove(x: number, y: number): void {
    const g = this.gesture;
    if (!g) return;
    const dx = x - g.x;
    const dy = y - g.y;
    g.travel += Math.hypot(dx, dy);
    g.x = x;
    g.y = y;
    if (g.travel <= TAP_SLOP_PX) return;
    if (g.mode === 'pan') this.pan(dx, dy);
    else this.rotate(dx, dy);
  }

  private gestureEnd(x: number, y: number): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.travel > TAP_SLOP_PX || performance.now() - g.at > TAP_MS) return;
    this.walkTo(x, y);
  }
}

/** The block cell the character's feet are in. */
function cellOf(pos: readonly [number, number, number]): Cell {
  return [Math.floor(pos[0]), Math.floor(pos[1] + 0.001), Math.floor(pos[2])];
}

/** Shortest signed angle, so facing a target never takes the long way round. */
function wrapPi(a: number): number {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}
