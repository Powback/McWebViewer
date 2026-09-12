/**
 * An on-screen movement joystick.
 *
 * POINTER EVENTS, not touch events, so one implementation covers a finger, a trackpad and a
 * mouse. The existing left-half touch stick in `live-controls.ts` is touch-only and invisible
 * — fine on a phone, useless on a laptop, where there is nothing on screen to drag.
 *
 * OWNERSHIP IS BY AREA, DECIDED AT POINTER-DOWN. The iso view now rotates the camera on a
 * primary drag, so a movement drag and a camera drag would otherwise fight over the same
 * gesture. Rather than guess from direction or distance — which means one of them starts
 * wrong and has to be taken back — the joystick owns a fixed circle at the bottom LEFT of
 * the screen: a pointer that goes down inside it belongs to the joystick for the whole
 * gesture, and one that goes down anywhere else never reaches it. The action pad already
 * owns the bottom RIGHT, so the two do not overlap either.
 *
 * `setPointerCapture` is what makes "for the whole gesture" true: without it a drag that
 * leaves the circle stops being delivered here, the knob sticks where it was, and the player
 * keeps walking after letting go — the same class of bug as the Mine button that binds its
 * release to the window rather than to itself.
 *
 * The output is ANALOG. Eight-way snapping is what a keyboard does because a keyboard has
 * eight directions; a stick that can only do eight is immediately noticeable as worse than
 * the thing it replaces.
 */

/** How far the knob travels from centre, in CSS pixels, for full deflection. */
const RADIUS = 46;
/** Below this fraction of the radius the stick reads as centred, so a resting thumb is still. */
const DEADZONE = 0.18;

export interface JoystickDeps {
  root: HTMLElement;
  /** called whenever the direction changes materially, so intents are not spammed */
  onChange?: (v: JoystickVector) => void;
}

export interface JoystickVector {
  /** -1 (left) .. 1 (right), in screen space */
  x: number;
  /** -1 (forward/up) .. 1 (back/down), in screen space */
  y: number;
  /** 0..1 — how far the stick is pushed, after the deadzone */
  magnitude: number;
}

export const CENTRED: JoystickVector = { x: 0, y: 0, magnitude: 0 };

/**
 * Raw pixel offset to a clamped, dead-zoned vector.
 *
 * Pure so the geometry is testable without a DOM: the deadzone and the clamp are where a
 * stick feels wrong, and "it drifts when I let go" is not something to check by hand.
 */
export function vectorFrom(dx: number, dy: number, radius = RADIUS): JoystickVector {
  const dist = Math.hypot(dx, dy);
  if (dist < radius * DEADZONE) return CENTRED;
  const clamped = Math.min(dist, radius);
  // Re-scale so the vector runs 0..1 ACROSS the live part of the travel rather than
  // jumping to the deadzone's value the moment it is crossed.
  const magnitude = (clamped - radius * DEADZONE) / (radius * (1 - DEADZONE));
  return { x: (dx / dist) * magnitude, y: (dy / dist) * magnitude, magnitude };
}

/** Where the knob should be drawn, in pixels from centre. */
export function knobOffset(dx: number, dy: number, radius = RADIUS): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) return { x: dx, y: dy };
  return { x: (dx / dist) * radius, y: (dy / dist) * radius };
}

export class Joystick {
  private el: HTMLDivElement;
  private knob: HTMLDivElement;
  private pointerId: number | null = null;
  private origin = { x: 0, y: 0 };
  private value: JoystickVector = CENTRED;

  constructor(private deps: JoystickDeps) {
    this.el = document.createElement('div');
    this.el.className = 'mcwv-stick';
    this.knob = document.createElement('div');
    this.knob.className = 'mcwv-stick-knob';
    this.el.appendChild(this.knob);
    deps.root.appendChild(this.el);
    this.bind();
  }

  get vector(): JoystickVector {
    return this.value;
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  private bind(): void {
    this.el.addEventListener('pointerdown', (e) => {
      this.pointerId = e.pointerId;
      // The gesture belongs to this element now — including the part of it that strays
      // outside. Without the capture the knob sticks and the player keeps walking.
      this.el.setPointerCapture(e.pointerId);
      const rect = this.el.getBoundingClientRect();
      this.origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      this.el.classList.add('held');
      // Stop here: the camera-rotate drag listens further up, and this press is not for it.
      e.preventDefault();
      e.stopPropagation();
      this.move(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      this.move(e);
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      this.el.addEventListener(type, (e) => {
        if (e.pointerId !== this.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        this.release();
      });
    }
  }

  private move(e: PointerEvent): void {
    const dx = e.clientX - this.origin.x;
    const dy = e.clientY - this.origin.y;
    const knob = knobOffset(dx, dy);
    this.knob.style.transform = `translate(${knob.x}px, ${knob.y}px)`;
    this.set(vectorFrom(dx, dy));
  }

  private release(): void {
    if (this.pointerId !== null && this.el.hasPointerCapture(this.pointerId)) {
      this.el.releasePointerCapture(this.pointerId);
    }
    this.pointerId = null;
    this.knob.style.transform = 'translate(0px, 0px)';
    this.el.classList.remove('held');
    this.set(CENTRED);
  }

  private set(v: JoystickVector): void {
    const prev = this.value;
    // Only report a real change: this feeds the server-command path, which must not be sent
    // a fresh intent on every pixel of a drag.
    if (Math.abs(prev.x - v.x) < 0.02 && Math.abs(prev.y - v.y) < 0.02
      && Math.abs(prev.magnitude - v.magnitude) < 0.02) {
      this.value = v;
      return;
    }
    this.value = v;
    this.deps.onChange?.(v);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (!on) this.release();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }
}
