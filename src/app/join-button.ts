/**
 * The Join button.
 *
 * Its whole job is to make one fact impossible to miss: whether this page can drive a
 * player on the server it is looking at. That fact used to be buried in a HUD string, and
 * before that it was not represented at all — the controls simply bound and did nothing.
 *
 * Four states, and the button is honest in each:
 *
 *   hidden      not in live mode; there is no server to join
 *   disabled    the bridge has the control path switched off, or the server said no —
 *               and the reason is printed under the button, in the server's own words
 *   Join        control is possible and nobody has joined yet
 *   Leave       a fake player is in the world and this page is driving it
 *
 * `buttonState` is a pure function of the control state so it can be tested without a DOM.
 */

import type { ControlState } from './live.js';

export type JoinVisual = {
  hidden: boolean;
  disabled: boolean;
  label: string;
  /** true when pressing it despawns rather than spawns */
  leaving: boolean;
  /** shown under the button; empty means nothing to explain */
  why: string;
};

const HIDDEN: JoinVisual = { hidden: true, disabled: true, label: 'Join', leaving: false, why: '' };

/**
 * What the button should look like for a given control state.
 *
 * `null` control means live mode is on but the bridge has not said anything yet — the
 * button appears immediately, disabled, rather than popping in later and moving the
 * layout under a thumb that is already reaching for it.
 */
export function buttonState(
  control: ControlState | null,
  live: boolean,
  sourceKind: 'bridge' | 'spacetime' = 'bridge',
): JoinVisual {
  if (!live) return HIDDEN;
  // SPACETIME IS A READ-ONLY MIRROR. It carries the world — chunks, light, entities,
  // players, block entities — and has no channel for sending input back to the server at
  // all. Control (join, movement, the fake player) exists only through the RCON bridge,
  // which this mode deliberately does not open.
  //
  // So the button is disabled for a REAL reason, and must say that reason. It used to fall
  // through to "connecting to the bridge...", which is a lie twice over: nothing is
  // connecting, and nothing ever will.
  if (sourceKind === 'spacetime' && !control) {
    return {
      hidden: false,
      disabled: true,
      label: 'Join',
      leaving: false,
      why: 'View only: spacetime is a read-only mirror and has no control channel.'
        + ' Playing needs the bridge — switch the source to bridge.',
    };
  }
  if (!control) {
    return { hidden: false, disabled: true, label: 'Join', leaving: false, why: 'connecting to the bridge...' };
  }
  if (!control.enabled) {
    return {
      hidden: false,
      disabled: true,
      label: 'Join',
      leaving: false,
      why: 'Browser control is switched off on the bridge. Set MCWV_FAKEPLAYER_ENABLE=1.',
    };
  }
  if (control.available === false) {
    return { hidden: false, disabled: true, label: 'Join', leaving: false, why: control.reason };
  }
  if (control.joined) {
    return {
      hidden: false,
      disabled: false,
      label: `Leave (${control.name ?? 'bot'})`,
      leaving: true,
      why: '',
    };
  }
  // available === true (joined before, then left) or null (never tried). Both are
  // joinable; the first press is also what discovers whether the server can do it.
  return { hidden: false, disabled: false, label: 'Join', leaving: false, why: '' };
}

export interface JoinButtonDeps {
  button: HTMLButtonElement;
  why: HTMLElement;
  onJoin: () => void;
  onLeave: () => void;
}

export class JoinButton {
  private leaving = false;

  constructor(private deps: JoinButtonDeps) {
    deps.button.addEventListener('click', () => {
      // Optimistically disable: spawning goes over RCON and takes a moment, and a
      // double-tap on a phone would otherwise send two joins.
      deps.button.disabled = true;
      // GIVE THE KEYBOARD BACK. A clicked button keeps focus, and SPACE ACTIVATES A
      // FOCUSED BUTTON — so the first thing a player does after joining, pressing space to
      // jump, lands on Leave instead. It presents as "I cannot jump", which is exactly
      // what was reported.
      deps.button.blur();
      if (this.leaving) deps.onLeave();
      else deps.onJoin();
    });
  }

  render(
    control: ControlState | null,
    live: boolean,
    sourceKind: 'bridge' | 'spacetime' = 'bridge',
  ): void {
    const v = buttonState(control, live, sourceKind);
    const { button, why } = this.deps;
    this.leaving = v.leaving;
    button.hidden = v.hidden;
    button.disabled = v.disabled;
    button.textContent = v.label;
    button.classList.toggle('leave', v.leaving);
    why.hidden = v.hidden || !v.why;
    why.textContent = v.why;
  }
}
