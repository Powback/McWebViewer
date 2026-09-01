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
 * WHAT THIS IS NOT: PATHFINDING. The bridge's command set (see fake-player.mjs) is
 * `move forward|back|left|right` and `turn` — stateful direction holds, with no goto in
 * it. So "click to move" is implemented honestly as steering: face the point, hold
 * forward, stop on arrival. It walks around nothing. A one-block step or a fence gets a
 * jump (`unstick`), and a walk that stops making progress is ABANDONED rather than left
 * shoving into a wall forever. Told plainly here because the alternative is a feature that
 * looks like pathfinding until the first tree.
 */

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { LOOK_THROTTLE_MS, type ControlIntent } from './live-controls.js';
import { voxelCast, type VoxelHit, type VoxelSource } from './raycast.js';

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

/** Within this many blocks of the tapped point, the walk is done. */
const ARRIVE_BLOCKS = 1.0;
/** Progress smaller than this over `GIVE_UP_MS` counts as stuck. */
const PROGRESS_BLOCKS = 0.15;
const JUMP_EVERY_MS = 600;
const GIVE_UP_MS = 4000;
/** Camera-to-ground can be 160 blocks plus the terrain behind it. */
const PICK_RANGE = 400;

/** A press this short that travelled this little was a tap, not a pan. */
const TAP_SLOP_PX = 10;
const TAP_MS = 400;

export interface IsoViewDeps {
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  world: VoxelSource;
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

  /** Where the character has been told to walk, or null when it is standing still. */
  private target: [number, number, number] | null = null;
  private walking = false;
  private sentYaw = NaN;
  private lastLookSent = 0;
  private lastDist = Infinity;
  private lastProgressAt = 0;
  private lastJumpAt = 0;

  constructor(private deps: IsoViewDeps) {}

  get active(): boolean {
    return this.bound;
  }

  get walkTarget(): [number, number, number] | null {
    return this.target;
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
    this.steer(pos, now);
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
   */
  walkTo(clientX: number, clientY: number, now = performance.now()): boolean {
    const hit = this.pick(clientX, clientY);
    if (!hit) return false;
    // Stand ON the block that was tapped, not inside it.
    this.target = [hit.block[0] + 0.5, hit.block[1] + 1, hit.block[2] + 0.5];
    this.lastDist = Infinity;
    this.lastProgressAt = now;
    this.lastJumpAt = 0;
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

  private steer(pos: readonly [number, number, number], now: number): void {
    if (!this.target) return;
    const dx = this.target[0] - pos[0];
    const dz = this.target[2] - pos[2];
    const d = Math.hypot(dx, dz);
    if (d <= ARRIVE_BLOCKS) {
      this.stop();
      return;
    }
    this.face(dx, dz, now);
    if (!this.walking) {
      this.walking = true;
      this.sendInput({ forward: true });
    }
    this.unstick(d, now);
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

  /**
   * Steering is not pathfinding, so it gets stuck. A jump clears the overwhelmingly common
   * case — a one-block step, a slab, a fence post. When even jumping makes no progress the
   * walk is given up, because a bot holding forward into a wall is indistinguishable on
   * screen from a bot that has crashed, and it never stops on its own.
   */
  private unstick(d: number, now: number): void {
    if (d < this.lastDist - PROGRESS_BLOCKS) {
      this.lastDist = d;
      this.lastProgressAt = now;
      return;
    }
    if (now - this.lastProgressAt > GIVE_UP_MS) {
      this.stop();
      return;
    }
    if (now - this.lastJumpAt < JUMP_EVERY_MS) return;
    this.lastJumpAt = now;
    this.sendInput({ forward: true, jump: true });
  }

  /** Cancel the walk and make sure the character is actually told to stand still. */
  stop(): void {
    this.target = null;
    if (!this.walking) return;
    this.walking = false;
    this.sendInput();
  }

  /**
   * Every input frame names every control. The bridge has no memory of what was released,
   * so a frame that omits a direction is a frame that says nothing about it.
   */
  private sendInput(flags: Record<string, boolean> = {}): void {
    this.deps.send({
      t: 'input',
      forward: false, back: false, left: false, right: false,
      jump: false, sneak: false, sprint: false,
      ...flags,
    });
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

/** Shortest signed angle, so facing a target never takes the long way round. */
function wrapPi(a: number): number {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}
