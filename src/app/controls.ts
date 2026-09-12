/**
 * Minecraft-style creative-flight camera.
 *
 * Desktop: WASD + space/shift, pointer-lock mouselook, wheel to change speed.
 * Touch: left half of the screen is a virtual stick, right half is a look drag — the
 * standard mobile layout, chosen because pointer lock does not exist on touch, so without
 * it there is no way to turn the camera at all.
 *
 * Altitude on touch comes from pitching and pushing forward rather than from separate
 * up/down buttons: movement already follows the camera's facing vector, so looking up and
 * pushing the stick climbs. That keeps the whole control surface to two gestures.
 */

import type { PerspectiveCamera } from 'three';

/** stick travel in CSS px for full deflection */
const STICK_RADIUS = 56;
const LOOK_SENSITIVITY = 0.0022;
/** touch look needs to be less sensitive than a mouse or it is unusable */
const TOUCH_LOOK_SENSITIVITY = 0.0045;

interface Drag {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export class FlyControls {
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  /** left-half touch acting as a movement stick */
  private stick: Drag | null = null;
  /** right-half touch acting as a look drag */
  private look: Drag | null = null;
  speed = 30;

  constructor(
    private camera: PerspectiveCamera,
    private canvas: HTMLCanvasElement,
  ) {
    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  /**
   * Whether clicking the canvas should capture the pointer.
   *
   * False in isometric mode. Set by whoever owns the camera mode rather than read from it here, so
   * this class keeps knowing nothing about live view, joining or cameras.
   */
  pointerLockAllowed = true;

  /** Release the pointer if this control currently holds it. Safe to call when it does not. */
  releasePointer(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private bindKeyboard(): void {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'ShiftLeft' || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  private bindMouse(): void {
    this.canvas.addEventListener('click', () => {
      // NOT IN ISOMETRIC. There is nothing to mouselook at from a fixed overhead camera, and the
      // lock actively fights that mode: a captured pointer swallows the drag-to-rotate gesture and
      // every click on the page's own controls, so you have to press Escape to reach a button.
      if (!this.pointerLockAllowed) return;
      // Pointer lock does not exist on touch and requesting it there throws; the touch
      // handlers own those devices.
      if (matchMedia('(pointer: fine)').matches) void this.canvas.requestPointerLock();
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.turn(-e.movementX * LOOK_SENSITIVITY, -e.movementY * LOOK_SENSITIVITY);
    });
    addEventListener('wheel', (e) => {
      this.speed = Math.max(2, Math.min(400, this.speed * (e.deltaY > 0 ? 0.9 : 1.1)));
    });
  }

  private bindTouch(): void {
    const c = this.canvas;
    c.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    for (const ev of ['touchend', 'touchcancel']) {
      c.addEventListener(ev, (e) => this.onTouchEnd(e as TouchEvent), { passive: false });
    }
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    const half = this.canvas.clientWidth / 2;
    for (const t of Array.from(e.changedTouches)) {
      const drag: Drag = { id: t.identifier, startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY };
      if (t.clientX < half && !this.stick) this.stick = drag;
      else if (!this.look) this.look = drag;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.stick?.id === t.identifier) {
        this.stick.x = t.clientX;
        this.stick.y = t.clientY;
      } else if (this.look?.id === t.identifier) {
        this.turn(
          -(t.clientX - this.look.x) * TOUCH_LOOK_SENSITIVITY,
          -(t.clientY - this.look.y) * TOUCH_LOOK_SENSITIVITY,
        );
        this.look.x = t.clientX;
        this.look.y = t.clientY;
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (this.stick?.id === t.identifier) this.stick = null;
      if (this.look?.id === t.identifier) this.look = null;
    }
  }

  private turn(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dPitch));
  }

  /** Point the camera at a target once, deriving yaw/pitch so mouselook continues from there. */
  lookAt(x: number, y: number, z: number) {
    const dx = x - this.camera.position.x;
    const dy = y - this.camera.position.y;
    const dz = z - this.camera.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  /** Held movement keys as three -1..1 axes: forward, strafe (right positive), up. */
  private moveAxes(): { f: number; s: number; u: number } {
    let f = 0;
    let s = 0;
    let u = 0;
    if (this.keys.has('KeyW')) f += 1;
    if (this.keys.has('KeyS')) f -= 1;
    if (this.keys.has('KeyD')) s += 1;
    if (this.keys.has('KeyA')) s -= 1;
    if (this.keys.has('Space')) u += 1;
    if (this.keys.has('ShiftLeft')) u -= 1;
    if (this.stick) {
      const clamp = (v: number) => Math.max(-1, Math.min(1, v / STICK_RADIUS));
      f += clamp(this.stick.startY - this.stick.y);
      s += clamp(this.stick.x - this.stick.startX);
    }
    return { f, s, u };
  }

  update(dt: number) {
    const c = this.camera;
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const { f, s, u } = this.moveAxes();
    if (!f && !s && !u) return;

    const boost = this.keys.has('ControlLeft') ? 4 : 1;
    const v = this.speed * boost * dt;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    // forward in the camera's facing direction, strafe on the horizontal plane
    c.position.x += (-sinY * cosP * f + cosY * s) * v;
    c.position.y += (sinP * f + u) * v;
    c.position.z += (-cosY * cosP * f - sinY * s) * v;
  }
}
