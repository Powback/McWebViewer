/**
 * Browser controls for the fake-player path.
 *
 * These are bound ONLY when the bridge has said the control path is live — meaning the
 * fake-player mod is both enabled and answered its probe. That ordering is the whole
 * design: the previous version bound WASD, mouse-look, dig and place unconditionally, so
 * on a server without the mod you got a viewer that looked playable, took your input, and
 * did nothing with it. Nothing on screen said why. Now a server without the mod produces
 * a viewer with no controls and a HUD line explaining what is missing.
 *
 * Movement is command-driven, so this is remote *control*, not a 20 tps client. Intents
 * go out on change (`sendControls`) and look is throttled; the server decides where the
 * player ends up and the camera follows what it reports, so there is no client-side
 * prediction and therefore nothing to rubber-band.
 */

import type { Viewer } from '../render/viewer.js';
import type { World } from '../render/world.js';
import { voxelCast, type VoxelHit } from './raycast.js';

/**
 * How often look intents may be sent. The server does not need 500 turns a second.
 *
 * 50 ms, not 100: the whole of this interval is time the body spends behind the view, and
 * during a fast sweep 100 ms of mouse travel is tens of degrees — which is most of the
 * "turning and hitting disagree" this page used to warn about. 50 ms is the server's own
 * tick, and RCON commands are drained on the tick thread, so asking faster than that only
 * queues. Halving it was not safe until control got its own RCON connection: on the shared
 * pipe these turns competed with the 10 Hz position poll and a 1-7 s flush.
 */
export const LOOK_THROTTLE_MS = 50;
const MOUSE_SENSITIVITY = 0.0022;
const MAX_PITCH = 1.55;
/** Vanilla's standing eye height. */
export const EYE_HEIGHT = 1.62;

const CONTROL_KEYS: Record<string, string> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak',
  ControlLeft: 'sprint',
};

export interface ControlIntent {
  t: string;
  [k: string]: unknown;
}

export interface LiveControlDeps {
  viewer: Viewer;
  world: World;
  send: (msg: ControlIntent) => void;
  /** E — open/close the inventory panel */
  onInventory: () => void;
  /** T — open the chat box */
  onChat: () => void;
  /** true while the chat box owns the keyboard; movement keys must not also fire */
  isTyping: () => boolean;
  /** right-clicked a block: its coordinates, so a container can be read */
  onUseBlock: (pos: [number, number, number]) => void;
}

/** How far a touch must travel from where it landed for full stick deflection, in CSS px. */
const STICK_RADIUS = 48;
/** A touch look drag needs to be far less sensitive than a mouse or it is unusable. */
const TOUCH_LOOK_SENSITIVITY = 0.0045;
/** How far an unlocked press may travel before it counts as a look drag, not a dig. */
const DRAG_SLOP = 6;

interface TouchDrag {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

/**
 * What the input path is actually doing, counted at every layer it can die at.
 *
 * This exists because "the controls do nothing" was reported from a real browser that no
 * headless harness could reproduce, and every layer between a keypress and the server
 * fails the same silent way. Each counter isolates one of them, so ONE line read off the
 * screen says which:
 *
 *   rawKeys   the window saw a keydown at all — 0 means the page never had the keyboard
 *   tried     an intent was built and handed to the socket client
 *   touches   touch points seen — non-zero on a device with no pointer lock to give
 */
export interface InputDiagnostics {
  rawKeys: number;
  tried: number;
  touches: number;
  /** verbatim from `pointerlockerror`, empty when the lock was never refused */
  lockError: string;
}

export class LiveControls {
  private held = new Set<string>();
  private lastLookSent = 0;
  private bound = false;
  private detach: Array<() => void> = [];
  private stick: TouchDrag | null = null;
  private lookDrag: TouchDrag | null = null;
  private stickDir = '';
  /** A look the throttle suppressed, owed to the server when the gesture ends. */
  private lookDirty = false;
  /**
   * Drag-to-look, used ONLY when the pointer is not locked.
   *
   * Pointer lock is refused more often than it looks: a click the browser did not count as
   * a user gesture, a permissions policy, an embedded frame, a user who just pressed
   * Escape. Observed for real in Chrome here — `WrongDocumentError: the root document of
   * this element is not valid for pointer lock`. Without a fallback that is a page where
   * the mouse does nothing at all and nothing says why, which is the exact report this
   * whole investigation started from. With no lock there is also no dig on this button,
   * so it resolves drag-versus-click instead — see `dragOrDig`.
   */
  private mouseDrag: { x: number; y: number; dug: boolean } | null = null;
  /** Whether this class currently believes the dig button is held. See `setDig`. */
  private digging = false;
  /**
   * Latched for exactly one input frame.
   *
   * The bridge's jump is EDGE-triggered — `player <name> jump once` fires on any input
   * frame with `jump: true` — so a held flag would jump again every time the stick changed
   * direction. Set, sent, cleared.
   */
  private jumpOnce = false;

  readonly diag: InputDiagnostics = { rawKeys: 0, tried: 0, touches: 0, lockError: '' };

  yaw = 0;
  pitch = 0;
  /** Latest server-reported position; LiveView owns smoothing and prediction. */
  private target: [number, number, number] | null = null;

  constructor(private deps: LiveControlDeps) {}

  get active(): boolean {
    return this.bound;
  }

  /** Movement keys and stick directions held right now, for the on-screen diagnostic. */
  get heldNames(): string[] {
    const names = [...this.held].map((code) => CONTROL_KEYS[code]);
    if (this.stickDir) names.push(`${this.stickDir}(stick)`);
    return names;
  }

  /** Whether THIS canvas holds the pointer lock — not merely that something does. */
  get pointerLocked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.canvas;
  }

  /**
   * Whether this device has a pointer that can be locked at all.
   *
   * False on a phone or tablet, where pointer lock does not exist. That is not a failure,
   * but it does mean mouse-look can never be the answer there — which is why the touch
   * path below exists rather than the page simply doing nothing.
   */
  get pointerFine(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
  }

  /** Idempotent: the bridge may re-send `hello` on reconnect. */
  bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.bindPointer();
    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
    this.bindSafetyRelease();
    // The server spawns the bot facing whatever IT chose, which has nothing to do with
    // where this camera is pointing. Push the browser's look straight away, so the first
    // W goes where the player is looking instead of wherever the bot happened to face.
    // Without this the alignment only happens on the first mouse move — and a player who
    // presses W before touching the mouse walks off in an unrelated direction.
    this.sendLook();
  }

  unbind(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.bound = false;
    this.held.clear();
    this.stick = null;
    this.lookDrag = null;
    this.mouseDrag = null;
    this.stickDir = '';
    this.lookDirty = false;
    this.digging = false;
    this.target = null;
  }

  /**
   * The stops that have nothing to do with the pointer.
   *
   * On desktop a dig always ends in a `mouseup` or a `pointerlockchange`, and both were
   * relied on. NEITHER EXISTS ON A PHONE. Switching apps, taking a call or locking the
   * screen with the Mine button held delivers no release event to the button at all, and
   * the bot is left attacking until somebody notices. These two are the only events that
   * still arrive in that case.
   */
  private bindSafetyRelease(): void {
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.on(window, 'blur', () => this.releaseAll());
  }

  /**
   * Place the camera at an already-smoothed position.
   *
   * The smoothing and prediction live in LiveView, which is the thing that sees the
   * sample timestamps; this only applies the result plus the eye height and the local
   * look angles. Yaw and pitch stay client-side because the browser is authoritative for
   * them — it is what generated them — and round-tripping them would add a poll of lag to
   * simply turning your head.
   */
  setCameraTo(pos: readonly [number, number, number]): void {
    const cam = this.deps.viewer.camera;
    cam.position.set(pos[0], pos[1] + EYE_HEIGHT, pos[2]);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Latest server-reported position, kept so the raycast starts from the real player. */
  setBotPose(pos: [number, number, number]): void {
    this.target = pos;
  }

  get botPos(): [number, number, number] | null {
    return this.target;
  }

  // -------------------------------------------------------------------------

  /**
   * Every listener is registered through here so `unbind()` can remove all of them. The
   * event map is the union of window's and document's, because `pointerlockchange` only
   * exists on the latter.
   */
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

  private get canvas(): HTMLCanvasElement {
    return this.deps.viewer.renderer.domElement;
  }

  private bindPointer(): void {
    this.on(this.canvas, 'click', () => {
      // Pointer lock does not exist on touch and requesting it there throws.
      if (!this.pointerFine) return;
      // The promise rejects when the browser refuses — a click that was not a real user
      // gesture, a sandboxed frame, a lock the user just escaped from. Recorded rather
      // than swallowed: "the mouse does nothing" has to be readable off the screen.
      // Older browsers return void here, newer ones a promise. Handle both rather than
      // pretending to know which this is.
      const lock: unknown = this.canvas.requestPointerLock();
      if (lock instanceof Promise) {
        lock.catch((err: unknown) => {
          this.diag.lockError = err instanceof Error ? err.message : String(err);
        });
      }
    });
    this.on(document, 'pointerlockerror', () => {
      this.diag.lockError = 'the browser refused pointer lock (pointerlockerror)';
    });
    this.on(document, 'pointerlockchange', () => {
      if (this.pointerLocked) {
        this.diag.lockError = '';
        return;
      }
      // Releasing the pointer must stop the bot walking into a wall — and stop it mining.
      this.releaseAll();
    });
  }

  private bindKeyboard(): void {
    this.on(window, 'keydown', (e) => {
      // Counted BEFORE every filter below, so "the page never saw the key" and "the page
      // saw it and dropped it" cannot look the same on screen.
      this.diag.rawKeys++;
      if (e.repeat || this.deps.isTyping()) return;
      if (CONTROL_KEYS[e.code]) {
        e.preventDefault();
        this.held.add(e.code);
        this.sendControls();
        return;
      }
      this.verb(e);
    });
    this.on(window, 'keyup', (e) => {
      if (!CONTROL_KEYS[e.code]) return;
      this.held.delete(e.code);
      this.sendControls();
    });
  }

  /** Non-movement keys. Split out to keep the keydown handler within complexity limits. */
  private verb(e: KeyboardEvent): void {
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      this.send({ t: 'hotbar', slot: Number(digit[1]) - 1 });
      return;
    }
    if (e.code === 'KeyQ') this.send({ t: 'drop' });
    else if (e.code === 'KeyE') this.deps.onInventory();
    else if (e.code === 'KeyT' || e.code === 'Slash') { e.preventDefault(); this.deps.onChat(); }
    else if (e.code === 'KeyR') this.send({ t: 'respawn' });
  }

  /**
   * The ONE way an intent leaves this class, so `diag.tried` means what it says: every
   * intent this class built and handed on. A second, uncounted path would put a number on
   * screen that quietly disagrees with reality — which is the failure being diagnosed.
   */
  private send(msg: ControlIntent): void {
    this.diag.tried++;
    this.deps.send(msg);
  }

  private bindMouse(): void {
    this.on(window, 'mousemove', (e) => {
      if (this.pointerLocked) this.dragLook(-e.movementX, -e.movementY, MOUSE_SENSITIVITY);
      else this.dragOrDig(e);
    });
    // Left button HOLDS. The server decides how long the block takes to break — hardness,
    // tool, efficiency, haste — so the browser's only job is to say when the button is
    // down and when it is up.
    //
    // NEITHER BUTTON REQUIRES POINTER LOCK. They used to, and that silently removed mining
    // and placing on every browser that refuses the lock — the player could walk and look
    // (drag-to-look) and simply could not touch the world, with nothing saying why.
    this.on(window, 'mousedown', (e) => {
      if (e.button === 2) {
        this.rightClick();
        return;
      }
      if (e.button !== 0) return;
      // Unlocked, this same press might turn out to be a look drag; `mouseDrag` records
      // where it started so a drag past the threshold can take the dig back.
      if (!this.pointerLocked) this.mouseDrag = { x: e.clientX, y: e.clientY, dug: true };
      this.setDig(true);
    });
    this.on(window, 'mouseup', (e) => {
      if (e.button !== 0) return;
      this.mouseDrag = null;
      this.setDig(false);
    });
    // Always: without this the browser menu eats every right click and nothing is ever
    // placed. There is no other use for a context menu on a canvas you are playing in.
    this.on(window, 'contextmenu', (e) => {
      if (e.target === this.canvas) e.preventDefault();
    });
  }

  /**
   * Turn an unlocked left-drag into a look, taking back the dig it started as.
   *
   * A press with no lock is ambiguous — mine, or turn? Resolved the way every drag-vs-click
   * surface resolves it: it is a dig until the pointer travels far enough to prove it was a
   * drag, and then the dig is cancelled. Holding still mines; moving looks.
   */
  private dragOrDig(e: MouseEvent): void {
    const drag = this.mouseDrag;
    if (!drag) return;
    if (drag.dug && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_SLOP) {
      drag.dug = false;
      this.setDig(false);
    }
    if (!drag.dug) this.dragLook(drag.x - e.clientX, drag.y - e.clientY, MOUSE_SENSITIVITY);
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  // -------------------------------------------------------------------------
  // Touch
  //
  // WITHOUT THIS, PLAY MODE IS INERT ON A PHONE. Pointer lock does not exist on touch, so
  // mouse-look is unreachable, and there is no keyboard, so WASD is unreachable — every
  // control this class binds is a control such a device cannot produce. The Join button is
  // sized for a thumb and the fly camera has had touch controls all along, so a tap on
  // Join went from "flying with two gestures" to a HUD and a frozen view.
  //
  // Same layout as the fly camera, so the gesture you learn watching still works playing:
  // LEFT half is a movement stick, RIGHT half is a look drag.

  private bindTouch(): void {
    const opts = { passive: false } as const;
    this.on(this.canvas, 'touchstart', (e) => this.onTouchStart(e), opts);
    this.on(this.canvas, 'touchmove', (e) => this.onTouchMove(e), opts);
    this.on(this.canvas, 'touchend', (e) => this.onTouchEnd(e), opts);
    this.on(this.canvas, 'touchcancel', (e) => this.onTouchEnd(e), opts);
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    const half = this.canvas.clientWidth / 2;
    for (const t of Array.from(e.changedTouches)) {
      this.diag.touches++;
      const drag: TouchDrag = {
        id: t.identifier, startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY,
      };
      if (t.clientX < half && !this.stick) this.stick = drag;
      else if (!this.lookDrag) this.lookDrag = drag;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.stick?.id === t.identifier) {
        this.stick.x = t.clientX;
        this.stick.y = t.clientY;
        this.updateStick();
      } else if (this.lookDrag?.id === t.identifier) {
        this.dragLook(this.lookDrag.x - t.clientX, this.lookDrag.y - t.clientY);
        this.lookDrag.x = t.clientX;
        this.lookDrag.y = t.clientY;
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (this.stick?.id === t.identifier) {
        this.stick = null;
        this.updateStick();
      }
      if (this.lookDrag?.id === t.identifier) this.lookDrag = null;
    }
  }

  // -------------------------------------------------------------------------
  // What the on-screen buttons call.
  //
  // THE STICK AND THE LOOK DRAG WERE THE WHOLE OF THE TOUCH SURFACE, and every remaining
  // verb — jump, mine, place — was bound to a key or a mouse button that a phone cannot
  // produce. Measured on an emulated iPhone against the live bridge: a tap, a 1.2 s hold
  // and a two-finger tap each produced ZERO intents on the wire, while the same session's
  // stick and look drag produced `input` and `look` normally. So the gestures are not
  // subtly wrong, they were never bound; these three entry points are what the pad drives.
  //
  // They live here rather than in the pad because this class is the one place that knows
  // whether the controls are bound at all, and it owns `diag.tried`.

  /**
   * Jump. Sent as an ordinary input frame, because that is what the bridge understands —
   * there is no separate jump verb in the protocol.
   */
  touchJump(): void {
    if (!this.bound) return;
    this.jumpOnce = true;
    this.sendControls();
    this.jumpOnce = false;
  }

  /**
   * Mine. PRESS AND HOLD, not a tap: the server decides how long a block takes to break,
   * so the browser's only job is to say when the button went down and when it came up. A
   * tap handler would send both edges within a frame and never break anything harder than
   * a torch, which is indistinguishable from "mining does not work".
   */
  touchDig(down: boolean): void {
    if (!this.bound) return;
    this.setDig(down);
  }

  /** Place / use, from the pad's own button rather than a right-click a phone cannot do. */
  touchUse(): void {
    if (!this.bound) return;
    this.use();
  }

  /**
   * The single owner of the dig hold, for the mouse and the on-screen button alike.
   *
   * De-duplicated because the release is bound in several places on purpose (button up,
   * finger off the button, tab hidden, window blurred) and they routinely fire together;
   * without this each one would put another frame on the wire. `force` re-states a release
   * this class already believes happened — used only when the page loses input entirely,
   * where being wrong costs a bot that mines forever.
   */
  private setDig(down: boolean, force = false): void {
    if (this.digging === down && !force) return;
    this.digging = down;
    this.send({ t: 'dig', down });
  }

  /** One turn path for mouse and touch alike; only the sensitivity differs. */
  private dragLook(dx: number, dy: number, sensitivity = TOUCH_LOOK_SENSITIVITY): void {
    this.yaw += dx * sensitivity;
    this.pitch += dy * sensitivity;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    if (performance.now() - this.lastLookSent < LOOK_THROTTLE_MS) {
      this.lookDirty = true;
      return;
    }
    this.sendLook();
  }

  /**
   * Send a look the throttle swallowed. Called once per frame.
   *
   * The throttle drops an intent on the assumption another is right behind it — true
   * mid-gesture, false at the end of one. Without this, a flick shorter than the throttle
   * window turns the view and never turns the body, and the camera and the player
   * disagree permanently until the next drag. Still throttled, so calling it every frame
   * costs nothing when there is nothing owed.
   */
  flushLook(): void {
    if (!this.lookDirty) return;
    if (performance.now() - this.lastLookSent < LOOK_THROTTLE_MS) return;
    this.sendLook();
  }

  /**
   * The stick's deflection as ONE direction.
   *
   * Deliberately not a blend: `move forward` and `move left` are separate stateful
   * commands on the server and only one can be running, so the honest mapping is the
   * dominant axis past a dead zone — not a diagonal the server cannot walk.
   */
  private stickDirection(): string {
    const s = this.stick;
    if (!s) return '';
    const dx = s.x - s.startX;
    const dy = s.y - s.startY;
    if (Math.hypot(dx, dy) < STICK_RADIUS * 0.3) return '';
    if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'forward' : 'back';
    return dx < 0 ? 'left' : 'right';
  }

  /** Only speaks when the direction actually changes; a held stick is not 60 commands/s. */
  private updateStick(): void {
    const dir = this.stickDirection();
    if (dir === this.stickDir) return;
    this.stickDir = dir;
    this.sendControls();
  }

  /**
   * Right click: use whatever is under the crosshair.
   *
   * The `use` goes out immediately and unconditionally — placing a block, opening a door,
   * pressing a button and eating are all the same verb to the server, and second-guessing
   * which one this is would only ever be wrong. The raycast is used solely to tell the
   * app WHICH block was targeted, so a container's contents can be read afterwards.
   */
  private rightClick(): void {
    this.use();
  }

  /** Use whatever is under the crosshair, and report the block so a container can be read. */
  private use(): void {
    this.send({ t: 'use' });
    const hit = this.raycast();
    if (hit) this.deps.onUseBlock(hit.block);
  }

  /** Release everything — used when the pointer unlocks or a panel takes the keyboard. */
  releaseAll(): void {
    if (!this.bound) return;
    this.held.clear();
    this.stickDir = '';
    this.sendControls();
    // Forced: this is the path that runs when the page has lost input altogether, and a
    // dig this class wrongly believes is already released is a bot left mining.
    this.setDig(false, true);
  }

  /**
   * The one place a look intent leaves the browser. Angles are three.js's; the bridge
   * converts them to Minecraft's, which are 180 degrees apart on yaw.
   */
  private sendLook(): void {
    this.lastLookSent = performance.now();
    this.lookDirty = false;
    this.send({ t: 'look', yaw: this.yaw, pitch: this.pitch });
  }

  private sendControls(): void {
    const msg: ControlIntent = { t: 'input' };
    for (const control of Object.values(CONTROL_KEYS)) msg[control] = false;
    for (const code of this.held) msg[CONTROL_KEYS[code]] = true;
    if (this.stickDir) msg[this.stickDir] = true;
    if (this.jumpOnce) msg.jump = true;
    this.send(msg);
  }

  /**
   * Voxel raycast from the eye along the view direction, so dig and place target the same
   * block the crosshair is on. The walk itself is shared with the isometric picker.
   */
  private raycast(maxDist = 5): VoxelHit | null {
    const dir: [number, number, number] = [
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
    return voxelCast(this.deps.world, this.deps.viewer.camera.position, dir, maxDist);
  }
}
