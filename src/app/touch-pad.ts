/**
 * The on-screen action buttons, and the crosshair they aim with.
 *
 * WHY BUTTONS AND NOT GESTURES. The left half of the canvas is already a movement stick
 * and the right half is already a look drag, so every finger a phone has is spoken for.
 * Overloading those with taps and holds would make mining and turning ambiguous — the
 * desktop path already has to resolve exactly that ambiguity for an unlocked mouse (see
 * `dragOrDig`), and it can only do it because a mouse has a second button. A phone does
 * not. Buttons are also the only version of this that is DISCOVERABLE: there is nothing on
 * a black canvas to tell you a two-finger tap places a block.
 *
 * MINE IS A HOLD. Minecraft breaks blocks over time and the server owns that timer, so the
 * button reports its edges and nothing else. A tap would send both edges inside one frame.
 *
 * The release is bound on the WINDOW, not on the button. A finger that slides off the
 * button before lifting delivers its `touchend` to the document, not to the node it
 * started on, and a Mine button that only listens to itself would hold the dig forever.
 * That is the same failure the safety release in LiveControls exists for, from the other
 * direction, and both are needed.
 */

export interface TouchPadDeps {
  root: HTMLElement;
  /** press and release of the mine button */
  onDig: (down: boolean) => void;
  /** place a block, open a door, eat — whatever `use` means where you are standing */
  onUse: () => void;
  onJump: () => void;
  /** the inventory panel, which is otherwise behind the E key a phone does not have */
  onInventory: () => void;
}

/**
 * Does this device actually need the pad?
 *
 * `(pointer: coarse)` is the honest question — "is the primary pointer a finger" — and
 * `maxTouchPoints` catches the touchscreen laptop whose primary pointer is a trackpad.
 * A desktop with a mouse gets none of this, because it has a keyboard and two mouse
 * buttons and the pad would only cover the world.
 */
export function isTouchDevice(): boolean {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const points = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse || points;
}

export class TouchPad {
  private el = document.createElement('div');
  private crosshair = document.createElement('div');
  private buttons: HTMLElement[] = [];
  private holding = false;
  private shown = false;
  /** hidden until the mode that needs it is on AND the device is one that needs it */
  private forced = false;

  constructor(private deps: TouchPadDeps) {
    this.build();
  }

  private build(): void {
    this.el.className = 'mcwv-pad';
    this.crosshair.className = 'mcwv-crosshair';
    this.hold(this.add('mine', 'MINE'), this.deps.onDig);
    this.tap(this.add('use', 'PLACE'), this.deps.onUse);
    this.tap(this.add('jump', 'JUMP'), this.deps.onJump);
    this.tap(this.add('inv', 'INV'), this.deps.onInventory);
    this.deps.root.append(this.el, this.crosshair);
    this.setVisible(false);
  }

  private add(kind: string, label: string): HTMLElement {
    const node = document.createElement('button');
    node.className = `mcwv-pad-btn mcwv-pad-${kind}`;
    node.textContent = label;
    node.type = 'button';
    this.buttons.push(node);
    this.el.appendChild(node);
    return node;
  }

  /**
   * Show the pad. `touchSeen` lets a device that lied about being coarse — or a desktop
   * browser being driven by a touchscreen — reveal it on the first real touch, rather than
   * leaving a player with no mine button and no way to ask for one.
   */
  setVisible(on: boolean, touchSeen = false): void {
    if (touchSeen) this.forced = true;
    this.shown = on && (this.forced || isTouchDevice());
    this.el.hidden = !this.shown;
    // The crosshair follows the pad: it is what the mine and place buttons aim with, and
    // on a desktop the pointer-locked mouse is its own crosshair.
    this.crosshair.hidden = !this.shown;
    if (!this.shown) this.release();
  }

  /** First person aims through the crosshair; the isometric view aims by tapping the ground. */
  setCrosshair(on: boolean): void {
    this.crosshair.hidden = !(on && this.shown);
  }

  get visible(): boolean {
    return this.shown;
  }

  private tap(node: HTMLElement, fn: () => void): void {
    // `touchstart`, not `click`: a tap on a phone fires click ~300 ms later on some
    // browsers, and a jump that lands a third of a second after the thumb is a jump the
    // player has already given up on. preventDefault also stops the synthesised mouse
    // events, so the handler cannot run twice for one thumb.
    node.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
    node.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
  }

  private hold(node: HTMLElement, fn: (down: boolean) => void): void {
    const down = (e: Event) => {
      e.preventDefault();
      if (this.holding) return;
      this.holding = true;
      node.classList.add('held');
      fn(true);
    };
    this.releaseHold = () => {
      if (!this.holding) return;
      this.holding = false;
      node.classList.remove('held');
      fn(false);
    };
    node.addEventListener('touchstart', down, { passive: false });
    node.addEventListener('mousedown', down);
    // On the window, because the lift routinely happens somewhere else entirely.
    for (const ev of ['touchend', 'touchcancel', 'mouseup', 'blur']) {
      addEventListener(ev, () => this.release());
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.release();
    });
  }

  private releaseHold: () => void = () => {};

  /** Stop mining, whatever the reason. Safe to call when nothing is held. */
  release(): void {
    this.releaseHold();
  }
}
