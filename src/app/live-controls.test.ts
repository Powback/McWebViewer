/**
 * Tests for the fake-player controls.
 *
 * These exist because of a bug whose whole signature was "the controls are bound and
 * nothing happens": the Join button worked, the HUD appeared, the key handlers were
 * registered — and the body still went the wrong way, because the browser's look angles
 * reached the server 180 degrees out and the browser never pushed them at all until the
 * mouse first moved.
 *
 * So what is pinned here is the OBSERVABLE traffic: which intents leave the browser, and
 * when. The angle conversion itself is pinned on the bridge side, in
 * `bridge/src/fake-player.test.mjs`, against direction vectors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_THROTTLE_MS, LiveControls, type ControlIntent } from './live-controls.js';
import type { Viewer } from '../render/viewer.js';
import type { World } from '../render/world.js';

interface Touch {
  identifier: number;
  clientX: number;
  clientY: number;
}

interface Harness {
  controls: LiveControls;
  sent: ControlIntent[];
  canvas: EventTarget;
  key: (type: 'keydown' | 'keyup', code: string) => void;
  touch: (type: 'touchstart' | 'touchmove' | 'touchend', points: Touch[]) => void;
  mouse: (type: 'mousedown' | 'mousemove' | 'mouseup', init: Record<string, number>) => void;
  doc: EventTarget & { pointerLockElement: EventTarget | null };
  typing: { value: boolean };
}

/**
 * A DOM small enough to be honest: LiveControls listens on `window`, `document` and the
 * renderer's canvas, and reads `document.pointerLockElement`. Nothing else is stubbed,
 * so the listener wiring under test is the real one.
 */
function harness(): Harness {
  // clientWidth is load-bearing: the touch layout splits the canvas down the middle.
  const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 600 });
  const win = new EventTarget();
  const doc: EventTarget & { pointerLockElement: EventTarget | null } =
    Object.assign(new EventTarget(), { pointerLockElement: canvas as EventTarget | null });
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: true });

  const sent: ControlIntent[] = [];
  const typing = { value: false };
  const controls = new LiveControls({
    viewer: { renderer: { domElement: canvas }, camera: { position: { x: 0, y: 0, z: 0 } } } as unknown as Viewer,
    world: { getState: () => 0 } as unknown as World,
    send: (msg) => sent.push(msg),
    isTyping: () => typing.value,
    onInventory: () => {},
    onChat: () => {},
    onUseBlock: () => {},
  });

  const key = (type: 'keydown' | 'keyup', code: string) => {
    win.dispatchEvent(Object.assign(new Event(type), { code, repeat: false, preventDefault() {} }));
  };
  const touch = (type: 'touchstart' | 'touchmove' | 'touchend', points: Touch[]) => {
    canvas.dispatchEvent(Object.assign(new Event(type), { changedTouches: points }));
  };
  const mouse = (type: 'mousedown' | 'mousemove' | 'mouseup', init: Record<string, number>) => {
    win.dispatchEvent(Object.assign(new Event(type), { movementX: 0, movementY: 0, ...init }));
  };
  return { controls, sent, canvas, key, touch, mouse, doc, typing };
}

const kinds = (sent: ControlIntent[]) => sent.map((m) => m.t);

/**
 * THE REGRESSION.
 *
 * A freshly spawned bot faces whatever the server chose. If the browser does not say
 * where it is looking until the mouse first moves, then a player who presses W straight
 * after joining — which is what everybody does — walks off along an unrelated heading.
 */
test('binding pushes the current look, so the body starts aligned with the camera', () => {
  const { controls, sent } = harness();
  controls.yaw = 1.25;
  controls.pitch = -0.5;

  controls.bind();

  assert.deepEqual(kinds(sent), ['look']);
  assert.equal(sent[0].yaw, 1.25);
  assert.equal(sent[0].pitch, -0.5);
});

test('WASD produces an input intent naming every control, not just the held one', () => {
  const { controls, sent, key } = harness();
  controls.bind();
  sent.length = 0;

  key('keydown', 'KeyW');
  assert.deepEqual(sent, [{
    t: 'input',
    forward: true, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false,
  }], 'the server has no memory of what was released; every frame states all of it');

  key('keyup', 'KeyW');
  assert.equal(sent[1].forward, false);
});

test('keys that are not controls do not emit an input intent', () => {
  const { controls, sent, key } = harness();
  controls.bind();
  sent.length = 0;

  key('keydown', 'KeyE');      // inventory panel, handled locally
  key('keydown', 'Digit3');
  assert.deepEqual(kinds(sent), ['hotbar']);
  assert.equal(sent[0].slot, 2, 'Digit3 is the third slot, 0-based on the wire');
});

test('while the chat box owns the keyboard, movement keys are ignored', () => {
  const { controls, sent, key, typing } = harness();
  controls.bind();
  sent.length = 0;

  typing.value = true;
  key('keydown', 'KeyW');
  assert.deepEqual(sent, [], 'typing "w" into chat must not walk the player into a wall');

  typing.value = false;
  key('keydown', 'KeyW');
  assert.equal(sent.length, 1);
});

test('unbinding removes the listeners, so a leave really does stop the input', () => {
  const { controls, sent, key } = harness();
  controls.bind();
  controls.unbind();
  sent.length = 0;

  key('keydown', 'KeyW');
  key('keyup', 'KeyW');
  assert.deepEqual(sent, [], 'a page that left must not keep driving a bot it no longer owns');
});

// ---------------------------------------------------------------------------
// Touch.
//
// Pointer lock does not exist on touch and there is no keyboard, so EVERY control bound
// above is one a phone cannot produce. Before this, pressing Join on a phone gave a HUD
// and a view that could not be moved or turned by any gesture — which is exactly the
// report that could never be reproduced on a desktop harness.

test('a phone can walk: the left half of the canvas is a movement stick', () => {
  const { controls, sent, touch } = harness();
  controls.bind();
  sent.length = 0;

  // Land on the left half, then drag upward past the dead zone.
  touch('touchstart', [{ identifier: 1, clientX: 200, clientY: 300 }]);
  touch('touchmove', [{ identifier: 1, clientX: 200, clientY: 240 }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'input');
  assert.equal(sent[0].forward, true, 'pushing the stick up walks forward');

  // A held stick must not become one command per touchmove.
  touch('touchmove', [{ identifier: 1, clientX: 200, clientY: 235 }]);
  touch('touchmove', [{ identifier: 1, clientX: 200, clientY: 230 }]);
  assert.equal(sent.length, 1, 'only a CHANGE of direction is worth a command');

  // Swinging it left is a different direction, and only one direction at a time —
  // the server has no diagonal walk.
  touch('touchmove', [{ identifier: 1, clientX: 120, clientY: 300 }]);
  assert.equal(sent.at(-1)!.left, true);
  assert.equal(sent.at(-1)!.forward, false);

  // Lifting the finger stops.
  touch('touchend', [{ identifier: 1, clientX: 120, clientY: 300 }]);
  assert.equal(sent.at(-1)!.left, false);
  assert.equal(sent.at(-1)!.forward, false);
});

test('a phone can look: the right half of the canvas is a look drag', async () => {
  const { controls, sent, touch } = harness();
  controls.bind();
  sent.length = 0;

  touch('touchstart', [{ identifier: 2, clientX: 600, clientY: 300 }]);
  touch('touchmove', [{ identifier: 2, clientX: 700, clientY: 300 }]);
  touch('touchend', [{ identifier: 2, clientX: 700, clientY: 300 }]);

  assert.ok(controls.yaw !== 0, 'dragging on the right half must turn the view');

  // A gesture shorter than the look throttle is the common case on touch — a flick — and
  // it must still reach the server, or the camera and the body disagree for good.
  await new Promise((r) => setTimeout(r, LOOK_THROTTLE_MS + 20));
  controls.flushLook();
  assert.equal(sent.at(-1)!.t, 'look', 'a throttled look is owed, not discarded');
  assert.equal(sent.at(-1)!.yaw, controls.yaw);
});

test('a stick touch and a look touch work at the same time', async () => {
  const { controls, sent, touch } = harness();
  controls.bind();
  sent.length = 0;

  touch('touchstart', [
    { identifier: 1, clientX: 200, clientY: 300 },
    { identifier: 2, clientX: 600, clientY: 300 },
  ]);
  touch('touchmove', [{ identifier: 1, clientX: 200, clientY: 200 }]);
  touch('touchmove', [{ identifier: 2, clientX: 680, clientY: 300 }]);
  await new Promise((r) => setTimeout(r, LOOK_THROTTLE_MS + 20));
  controls.flushLook();

  assert.ok(sent.some((m) => m.t === 'input' && m.forward === true));
  assert.ok(sent.some((m) => m.t === 'look'));
  assert.equal(controls.diag.touches, 2);
});

test('flushLook owes nothing when nothing was suppressed', async () => {
  const { controls, sent } = harness();
  controls.bind();
  sent.length = 0;

  await new Promise((r) => setTimeout(r, LOOK_THROTTLE_MS + 20));
  controls.flushLook();
  controls.flushLook();
  assert.deepEqual(sent, [], 'a per-frame call must not become a per-frame look command');
});

// ---------------------------------------------------------------------------
// The on-screen action buttons.
//
// THE REGRESSION THESE PIN. Driven on an emulated iPhone against the live bridge, the
// touch surface produced `input` for the stick and `look` for the drag — and NOTHING at
// all for a tap, a 1.2 second hold or a two-finger tap. Jump, mine and place were bound
// only to Space, the left mouse button and the right mouse button, none of which a phone
// can produce, so the page took every gesture and had no verb to spend it on.

test('a phone can jump: the pad puts a jump on an ordinary input frame', () => {
  const { controls, sent } = harness();
  controls.bind();
  sent.length = 0;

  controls.touchJump();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'input', 'the protocol has no jump verb; it rides an input frame');
  assert.equal(sent[0].jump, true);
});

/**
 * The bridge fires `player <name> jump once` on ANY input frame carrying `jump: true`, so
 * a flag left latched jumps again the next time the stick changes direction — walking a
 * phone player across a field would pogo the whole way.
 */
test('the jump is edge-triggered and does not ride the next input frame', () => {
  const { controls, sent, touch } = harness();
  controls.bind();
  controls.touchJump();
  sent.length = 0;

  touch('touchstart', [{ identifier: 1, clientX: 200, clientY: 300 }]);
  touch('touchmove', [{ identifier: 1, clientX: 200, clientY: 240 }]);

  assert.equal(sent.at(-1)!.t, 'input');
  assert.equal(sent.at(-1)!.jump, false, 'the jump must not repeat on the next input frame');
});

test('a phone can mine: the pad holds the button, it does not tap it', () => {
  const { controls, sent } = harness();
  controls.bind();
  sent.length = 0;

  controls.touchDig(true);
  assert.deepEqual(sent, [{ t: 'dig', down: true }]);

  // Minecraft breaks blocks over TIME and the server owns that timer. A tap handler would
  // put both edges on the wire inside one frame and never break anything.
  controls.touchDig(false);
  assert.deepEqual(sent.at(-1), { t: 'dig', down: false });
});

test('a repeated release does not put a second stop on the wire', () => {
  const { controls, sent } = harness();
  controls.bind();
  controls.touchDig(true);
  sent.length = 0;

  // The pad binds its release on the window in four places on purpose — a finger that
  // slides off the button never delivers touchend to it — so they routinely all fire.
  controls.touchDig(false);
  controls.touchDig(false);
  controls.touchDig(false);
  assert.deepEqual(sent, [{ t: 'dig', down: false }]);
});

test('a phone can place: the pad has the verb the right mouse button had', () => {
  const { controls, sent } = harness();
  controls.bind();
  sent.length = 0;

  controls.touchUse();
  assert.deepEqual(kinds(sent), ['use']);
});

test('the pad is inert before Join, so it cannot drive a bot that does not exist', () => {
  const { controls, sent } = harness();
  sent.length = 0;

  controls.touchJump();
  controls.touchDig(true);
  controls.touchUse();
  assert.deepEqual(sent, []);
});

/**
 * A PHONE GETS NO MOUSEUP AND NO POINTERLOCKCHANGE. Switching apps or taking a call with
 * the Mine button held used to leave the bot attacking with nothing to stop it — the two
 * events the release relied on are both desktop-only.
 */
test('hiding the tab releases a held dig', () => {
  const { controls, sent, doc } = harness();
  controls.bind();
  controls.touchDig(true);
  sent.length = 0;

  (doc as unknown as { hidden: boolean }).hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));

  assert.ok(
    sent.some((m) => m.t === 'dig' && m.down === false),
    'a backgrounded tab must not leave a bot mining',
  );
});

// ---------------------------------------------------------------------------
// Pointer lock, and surviving without it.

test('with no pointer lock, dragging the mouse still turns the view', async () => {
  const { controls, sent, canvas, mouse, doc } = harness();
  doc.pointerLockElement = null;   // the browser refused the lock
  controls.bind();
  sent.length = 0;

  assert.equal(controls.pointerLocked, false);
  mouse('mousedown', { button: 0, clientX: 400, clientY: 300 });
  mouse('mousemove', { button: 0, clientX: 500, clientY: 300 });

  assert.ok(controls.yaw !== 0, 'a refused pointer lock must not mean a dead mouse');
  assert.deepEqual(
    sent.filter((m) => m.t === 'dig'),
    [{ t: 'dig', down: true }, { t: 'dig', down: false }],
    'the press starts as a dig and the drag takes it back — see dragOrDig',
  );

  await new Promise((r) => setTimeout(r, LOOK_THROTTLE_MS + 20));
  controls.flushLook();
  assert.equal(sent.at(-1)!.t, 'look');
  assert.equal(canvas instanceof EventTarget, true);
});

test('with pointer lock held, the left button is a dig and not a look drag', () => {
  const { controls, sent, mouse } = harness();
  controls.bind();
  sent.length = 0;

  mouse('mousedown', { button: 0, clientX: 400, clientY: 300 });
  assert.deepEqual(sent, [{ t: 'dig', down: true }]);
  mouse('mousemove', { button: 0, clientX: 500, clientY: 300, movementX: 100, movementY: 0 });
  assert.ok(controls.yaw !== 0, 'locked look uses movementX');
});

/**
 * Mining and placing used to be gated on pointer lock, so a browser that refused the lock
 * gave a player who could walk and look and could not touch the world at all.
 */
test('mining and placing do not require pointer lock', () => {
  const { controls, sent, mouse, doc } = harness();
  doc.pointerLockElement = null;
  controls.bind();
  sent.length = 0;

  mouse('mousedown', { button: 2, clientX: 400, clientY: 300 });
  assert.ok(sent.some((m) => m.t === 'use'), 'right click must place/use with no lock');

  sent.length = 0;
  mouse('mousedown', { button: 0, clientX: 400, clientY: 300 });
  assert.deepEqual(sent, [{ t: 'dig', down: true }], 'holding still mines');
  mouse('mouseup', { button: 0, clientX: 400, clientY: 300 });
  assert.deepEqual(sent.at(-1), { t: 'dig', down: false });
});

test('an unlocked press that travels becomes a look, and takes the dig back', () => {
  const { controls, sent, mouse, doc } = harness();
  doc.pointerLockElement = null;
  controls.bind();
  sent.length = 0;

  mouse('mousedown', { button: 0, clientX: 400, clientY: 300 });
  assert.deepEqual(sent, [{ t: 'dig', down: true }]);

  // Under the slop threshold: still a dig, not yet a turn.
  mouse('mousemove', { button: 0, clientX: 403, clientY: 300 });
  assert.equal(sent.length, 1);
  assert.equal(controls.yaw, 0);

  // Past it: the dig is cancelled and the drag turns the view instead.
  mouse('mousemove', { button: 0, clientX: 440, clientY: 300 });
  assert.deepEqual(sent.at(-1), { t: 'dig', down: false }, 'a drag must not also mine');
  mouse('mousemove', { button: 0, clientX: 480, clientY: 300 });
  assert.ok(controls.yaw !== 0);
});

test('a pointer lock refusal is recorded where it can be read off the screen', () => {
  const { controls, doc } = harness();
  controls.bind();
  assert.equal(controls.diag.lockError, '');

  doc.dispatchEvent(new Event('pointerlockerror'));
  assert.match(controls.diag.lockError, /refused pointer lock/);
});

// ---------------------------------------------------------------------------
// The diagnostic.

test('the diagnostic counts a keydown the page saw but deliberately dropped', () => {
  const { controls, key, typing } = harness();
  controls.bind();
  const before = controls.diag.tried;

  typing.value = true;
  key('keydown', 'KeyW');

  assert.equal(controls.diag.rawKeys, 1, 'the page DID see the key');
  assert.equal(controls.diag.tried, before, 'and deliberately did not act on it');
});

test('the diagnostic reports held names for keys and for the stick alike', () => {
  const { controls, key, touch } = harness();
  controls.bind();

  key('keydown', 'KeyW');
  assert.deepEqual(controls.heldNames, ['forward']);

  touch('touchstart', [{ identifier: 1, clientX: 200, clientY: 300 }]);
  touch('touchmove', [{ identifier: 1, clientX: 120, clientY: 300 }]);
  assert.deepEqual(controls.heldNames, ['forward', 'left(stick)']);
});

test('bind is idempotent, so a bridge reconnect does not double every keystroke', () => {
  const { controls, sent, key } = harness();
  controls.bind();
  controls.bind();
  sent.length = 0;

  key('keydown', 'KeyW');
  assert.equal(sent.length, 1);
});
