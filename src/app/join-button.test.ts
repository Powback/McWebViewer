/**
 * Tests for the Join button's state machine.
 *
 * This is a small pure function guarding a claim the user actually cares about: whether
 * this page can play. Getting it wrong in the permissive direction reproduces the exact
 * bug this whole feature exists to kill — a control that looks live and does nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JoinButton, buttonState } from './join-button.js';
import type { ControlState } from './live.js';

function control(over: Partial<ControlState> = {}): ControlState {
  return {
    enabled: true,
    available: null,
    joined: false,
    reason: '',
    name: 'WebViewer',
    ...over,
  };
}

test('hidden entirely outside live mode', () => {
  assert.equal(buttonState(null, false).hidden, true);
  assert.equal(buttonState(control(), false).hidden, true);
});

test('visible but disabled before the bridge has said anything', () => {
  // It appears immediately rather than popping in later and shifting the layout under a
  // thumb that is already reaching for it.
  const v = buttonState(null, true);
  assert.equal(v.hidden, false);
  assert.equal(v.disabled, true);
  assert.match(v.why, /connecting/i);
});

test('disabled, with the fix, when the bridge has control switched off', () => {
  const v = buttonState(control({ enabled: false }), true);
  assert.equal(v.disabled, true);
  assert.match(v.why, /MCWV_FAKEPLAYER_ENABLE/);
});

test("disabled, in the server's own words, when the server said no", () => {
  const reason = 'the server has no `/player` command — install SiliconeDolls';
  const v = buttonState(control({ available: false, reason }), true);
  assert.equal(v.disabled, true);
  assert.equal(v.why, reason, 'the reason must be the server\'s, not a paraphrase');
  assert.equal(v.leaving, false);
});

test('joinable before anything has been tried — the first press is the probe', () => {
  const v = buttonState(control({ available: null }), true);
  assert.equal(v.disabled, false);
  assert.equal(v.label, 'Join');
  assert.equal(v.why, '');
});

test('joinable again after leaving', () => {
  const v = buttonState(control({ available: true, joined: false }), true);
  assert.equal(v.disabled, false);
  assert.equal(v.label, 'Join');
  assert.equal(v.leaving, false);
});

test('becomes Leave, naming the bot, once joined', () => {
  const v = buttonState(control({ available: true, joined: true }), true);
  assert.equal(v.disabled, false);
  assert.equal(v.leaving, true);
  assert.match(v.label, /^Leave \(WebViewer\)$/);
  assert.equal(v.why, '');
});

test('an unavailable server never becomes pressable, whatever else is set', () => {
  // Guards the ordering of the checks: `available === false` must win over `joined`,
  // which a stale message could otherwise leave set.
  const v = buttonState(control({ available: false, joined: true, reason: 'nope' }), true);
  assert.equal(v.disabled, true);
  assert.equal(v.leaving, false);
});

/**
 * SPACE IS JUMP, AND A FOCUSED BUTTON EATS SPACE.
 *
 * A clicked button keeps keyboard focus, and space activates a focused button. So the
 * first thing anybody does after joining — press space to jump — landed on Leave instead,
 * despawning the bot. It presents as "I cannot jump", which is what was reported.
 */
test('pressing the button hands the keyboard back', () => {
  const events: string[] = [];
  let blurred = false;
  const button = Object.assign(new EventTarget(), {
    disabled: false,
    blur: () => { blurred = true; },
  });
  new JoinButton({
    button: button as unknown as HTMLButtonElement,
    why: new EventTarget() as unknown as HTMLElement,
    onJoin: () => events.push('join'),
    onLeave: () => events.push('leave'),
  });

  button.dispatchEvent(new Event('click'));

  assert.deepEqual(events, ['join']);
  assert.equal(blurred, true, 'space must reach the game, not re-press this button');
  assert.equal(button.disabled, true, 'and a double-tap must not send two joins');
});
