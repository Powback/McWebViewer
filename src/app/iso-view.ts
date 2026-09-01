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
 * CLICK TO MOVE IS PLANNED, NOT STEERED. It used to be steering — face the point, hold
 * forward, jump on a hunch, give up after four seconds — because the bridge's vocabulary is
 * `move forward|back|left|right` plus `turn` and has no goto in it. That is still all the
 * bridge offers; what changed is that the ROUTE is worked out here first, over the same
 * chunks this view is rendering, and the steering is handed one waypoint at a time. See
 * pathfind.ts for the planner and what it will and will not agree to walk.
 */

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { LOOK_THROTTLE_MS, type ControlIntent } from './live-controls.js';
import { voxelCast, type VoxelHit, type VoxelSource } from './raycast.js';
import {
  nearestStandable, PathPlanner, smoothPath, type Cell, type NavWorld,
} from './pathfind.js';

/** Which camera owns the screen. Not a launch flag — the UI toggles it. */
export type CameraMode = 'first' | 'iso';

/** ~35.3 degrees below horizontal: the angle that makes a cube's three faces equal. */
const ISO_PITCH = -0.6155;
/** Azimuth. 45 degrees puts the world's axes on the screen diagonals, as isometric does. */
const ISO_YAW = Math.PI / 4;
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
/** How many waypoints ahead an overshoot may be recognised at. See `consume`. */
const LOOKAHEAD_LEGS = 4;
/** Progress smaller than this over `STUCK_MS` means the steering is not getting there. */
const PROGRESS_BLOCKS = 0.05;
const JUMP_EVERY_MS = 400;
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
  send: (msg: ControlIntent) => void;
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

export class IsoView {
  private bound = false;
  private detach: Array<() => void> = [];
  private savedFov = 0;

  /** Camera framing. Public so the tests can read where it ended up. */
  dist = DEFAULT_DIST;
  panX = 0;
  panZ = 0;
  yaw = ISO_YAW;

  /** Live touch points by identifier, so a pinch can be told from a pan. */
  private points = new Map<number, Point>();
  private gesture: { x: number; y: number; travel: number; at: number } | null = null;
  private pinch = 0;

  /** The cell the player asked for, or null when there is no walk in progress. */
  private goal: Cell | null = null;
  /** The search, while it is running. Null once it has an answer. */
  private planner: PathPlanner | null = null;
  /** The route being walked, and how far along it we are. */
  private path: Cell[] = [];
  private leg = 0;
  /** True when `path` stops short of the goal and has to be extended on arrival. */
  private pathPartial = false;
  private stuckReplans = 0;
  /** Where the current plan was made from, which is where smoothing has to start. */
  private planStart: Cell = [0, 0, 0];
  private walking = false;
  private sentYaw = NaN;
  private lastLookSent = 0;
  private lastLegDist = Infinity;
  private lastProgressAt = 0;
  private lastJumpAt = 0;

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
  get plannedPath(): readonly Cell[] {
    return this.path;
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
    this.place(pos);
    this.deps.setSubject(pos);
    this.navigate(pos, now);
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
    const cp = Math.cos(ISO_PITCH);
    // The camera's own facing vector, three.js convention — the same one the first-person
    // path and the bridge's angle conversion use, so "yaw" means one thing in this app.
    const dir = [-Math.sin(this.yaw) * cp, Math.sin(ISO_PITCH), -Math.cos(this.yaw) * cp];
    cam.position.set(f[0] - dir[0] * this.dist, f[1] - dir[1] * this.dist, f[2] - dir[2] * this.dist);
    cam.rotation.set(ISO_PITCH, this.yaw, 0, 'YXZ');
    // Picking unprojects through this matrix, and nothing else updates it until the
    // renderer draws — which is after the tap has already been resolved.
    cam.updateMatrixWorld();
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
    const stretch = perPx / Math.sin(-ISO_PITCH);
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
  walkTo(clientX: number, clientY: number, _now = performance.now()): boolean {
    const hit = this.pick(clientX, clientY);
    if (!hit) return false;
    // Stand ON the block that was tapped, not inside it.
    this.goal = [hit.block[0], hit.block[1] + 1, hit.block[2]];
    this.planner = null;
    this.path = [];
    this.leg = 0;
    this.pathPartial = false;
    this.stuckReplans = 0;
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
    return voxelCast(this.deps.world, cam, [dir.x, dir.y, dir.z], PICK_RANGE);
  }

  // -------------------------------------------------------------------------
  // Walking: plan, then follow.

  /** One frame of the walk: keep searching, or take one step along what was found. */
  private navigate(pos: readonly [number, number, number], now: number): void {
    if (!this.goal) return;
    if (this.planner) {
      // Standing still while the search runs. A character that sets off before it knows
      // where it is going is the steering this replaced.
      this.halt();
      this.advanceSearch();
      return;
    }
    if (!this.path.length) {
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
    this.planner = new PathPlanner(nav, start, goal);
    this.lastProgressAt = now;
    this.walkStatus = 'planning';
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
    // the spot. See smoothPath.
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
    if (this.leg >= this.path.length) {
      // A partial path ends short of where the player pointed on purpose — the search was
      // capped. Walking it and planning again from there is the whole point of the cap.
      if (this.pathPartial) {
        this.path = [];
        this.pathPartial = false;
        this.walkStatus = 'planning';
        return;
      }
      this.arrive();
      return;
    }
    const wp = this.path[this.leg];
    const dx = wp[0] + 0.5 - pos[0];
    const dz = wp[2] + 0.5 - pos[2];
    const d = Math.hypot(dx, dz);
    this.face(dx, dz, now);
    if (!this.walking) {
      this.walking = true;
      this.deps.send(inputFrame({ forward: true }));
    }
    this.stepUp(pos, dx, dz, now);
    this.watchProgress(d, now);
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
   */
  private consume(pos: readonly [number, number, number]): boolean {
    const limit = Math.min(this.leg + LOOKAHEAD_LEGS, this.path.length - 1);
    let hit = -1;
    for (let i = this.leg; i <= limit; i++) if (this.reached(pos, this.path[i])) hit = i;
    if (hit < 0) return false;
    this.leg = hit + 1;
    return true;
  }

  private reached(pos: readonly [number, number, number], cell: Cell): boolean {
    const d = Math.hypot(cell[0] + 0.5 - pos[0], cell[2] + 0.5 - pos[2]);
    return d <= WAYPOINT_BLOCKS && Math.abs(cell[1] - pos[1]) < WAYPOINT_HEIGHT;
  }

  /**
   * Jump when there is a block directly ahead to step onto, and only then.
   *
   * Read off the TERRAIN one block in front of the character rather than off the waypoint,
   * because waypoints are straightened before they are walked (see `smoothPath`) and a
   * ten-block leg carries no information about where the step in the middle of it is. The
   * plan has already established the leg is walkable, so a solid block at foot level with
   * two blocks of air over it is a step up and nothing else.
   *
   * The old steering jumped every 600 ms whenever it had stopped making progress, which is
   * a guess made after the fact and fires just as often at a wall it can never climb.
   */
  private stepUp(pos: readonly [number, number, number], dx: number, dz: number, now: number): void {
    if (now - this.lastJumpAt < JUMP_EVERY_MS) return;
    const len = Math.hypot(dx, dz);
    if (!len) return;
    const ahead = 0.75;
    const x = Math.floor(pos[0] + (dx / len) * ahead);
    const z = Math.floor(pos[2] + (dz / len) * ahead);
    const y = Math.floor(pos[1] + 0.001);
    const nav = this.deps.nav;
    if (nav.classify(x, y, z) !== 'solid') return;
    if (nav.classify(x, y + 1, z) !== 'air' || nav.classify(x, y + 2, z) !== 'air') return;
    this.lastJumpAt = now;
    this.deps.send(inputFrame({ forward: true, jump: true }));
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

  /** Release the movement keys, once. Does not touch the plan. */
  private halt(): void {
    if (!this.walking) return;
    this.walking = false;
    this.deps.send(inputFrame());
  }

  /** Point the body at the target. Throttled exactly as mouse-look is, for the same reason. */
  private face(dx: number, dz: number, now: number): void {
    const yaw = Math.atan2(-dx, -dz);
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
    this.on(c, 'mousedown', (e) => this.gestureStart(e.clientX, e.clientY));
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
      this.gestureStart(p.x, p.y);
      return;
    }
    // A second finger turns whatever this was into a pinch; it is no longer a tap.
    this.gesture = null;
    this.pinch = this.spread();
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
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

  private gestureStart(x: number, y: number): void {
    this.gesture = { x, y, travel: 0, at: performance.now() };
  }

  private gestureMove(x: number, y: number): void {
    const g = this.gesture;
    if (!g) return;
    const dx = x - g.x;
    const dy = y - g.y;
    g.travel += Math.hypot(dx, dy);
    g.x = x;
    g.y = y;
    if (g.travel > TAP_SLOP_PX) this.pan(dx, dy);
  }

  private gestureEnd(x: number, y: number): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.travel > TAP_SLOP_PX || performance.now() - g.at > TAP_MS) return;
    this.walkTo(x, y);
  }
}

/**
 * Every input frame names every control. The bridge has no memory of what was released, so
 * a frame that omits a direction is a frame that says nothing about it.
 */
function inputFrame(flags: Record<string, boolean> = {}): ControlIntent {
  return {
    t: 'input',
    forward: false, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false,
    ...flags,
  };
}

/** The block cell the character's feet are in. */
function cellOf(pos: readonly [number, number, number]): Cell {
  return [Math.floor(pos[0]), Math.floor(pos[1] + 0.001), Math.floor(pos[2])];
}

/** Shortest signed angle, so facing a target never takes the long way round. */
function wrapPi(a: number): number {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}
