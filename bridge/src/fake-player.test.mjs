/**
 * Tests for the fake-player control path.
 *
 * The property that matters most is NOT "movement works" — it is that on a server
 * WITHOUT the mod, nothing is ever sent. The reference server is exactly that server, and
 * the failure mode this replaces was a browser holding W while the bridge fired a command
 * the server rejects, several times a second, at a live world.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMANDS, FakePlayer, angleDelta, isCommandMissing, isValidBotName, mcRotation,
  template,
} from './fake-player.mjs';

/** Records every command issued, and replies with whatever the test scripted. */
function harness({ enabled = true, botName = 'WebViewer', reply = 'ok', commands } = {}) {
  const sent = [];
  const logs = [];
  const fp = new FakePlayer({
    enabled,
    botName,
    commands,
    run: async (cmd) => {
      sent.push(cmd);
      if (typeof reply === 'function') return reply(cmd, sent.length - 1);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    log: (m) => logs.push(m),
  });
  return { fp, sent, logs };
}

/** The real reply from the reference server, which has no `/player` command. */
const NO_SUCH_COMMAND = 'Unknown or incomplete command, see below for error\nplayer Web<--[HERE]';

test('template fills the bot name and per-call arguments', () => {
  assert.equal(template(DEFAULT_COMMANDS.spawn, { name: 'Bob' }), 'player Bob spawn');
  assert.equal(
    template(DEFAULT_COMMANDS.turn, { name: 'Bob', yaw: '90.0', pitch: '-5.0' }),
    'player Bob turn 90.0 -5.0',
  );
  // A missing variable becomes empty rather than a literal '{slot}' reaching the server.
  assert.equal(template('player {name} hotbar {slot}', { name: 'Bob' }), 'player Bob hotbar ');
});

test('isCommandMissing recognises the ways Brigadier says no', () => {
  assert.equal(isCommandMissing(NO_SUCH_COMMAND), true);
  assert.equal(isCommandMissing('Unknown command'), true);
  assert.equal(isCommandMissing(''), false);
  assert.equal(isCommandMissing('WebViewer joined the game'), false);
  assert.equal(isCommandMissing(undefined), false);
});

test('a bot name is validated before it is put into a command', () => {
  assert.equal(isValidBotName('WebViewer'), true);
  assert.equal(isValidBotName('Bot\nsay pwned'), false);
  assert.equal(isValidBotName(''), false);
  assert.equal(isValidBotName('a'.repeat(17)), false);
});

test('disabled: nothing is spawned and nothing is ever sent', async () => {
  const { fp, sent } = harness({ enabled: false });
  assert.equal(await fp.join(), false);
  await fp.input({ forward: true });
  await fp.look(1, 0);
  await fp.action('dig');
  await fp.hotbar(3);
  assert.deepEqual(sent, [], 'a disabled control path must be completely silent');
  assert.equal(fp.active, false);
  assert.match(fp.status().reason, /MCWV_FAKEPLAYER_ENABLE/);
});

test('enabled but the mod is absent: one attempt, then permanent silence', async () => {
  // This is the reference server. The whole point of latching is that the count below
  // stays at 1 no matter how much the browser sends, or how often Join is pressed.
  const { fp, sent, logs } = harness({ reply: NO_SUCH_COMMAND });
  assert.equal(await fp.join(), false);
  assert.equal(sent.length, 1, 'the join attempt itself is the only command');
  assert.deepEqual(sent, ['player WebViewer spawn']);

  for (let i = 0; i < 10; i++) await fp.join();
  assert.equal(sent.length, 1, 'mashing Join must not re-ask a server that already said no');

  for (let i = 0; i < 50; i++) {
    await fp.input({ forward: true });
    await fp.input({ forward: false });
    await fp.look(i, 0);
    await fp.action('dig');
  }
  assert.equal(sent.length, 1, 'a browser holding W must not become 200 failing commands');
  assert.equal(fp.active, false);
  assert.equal(fp.status().available, false);
  assert.match(fp.status().reason, /SiliconeDolls|Carpet/);
  assert.match(logs.join('\n'), /UNAVAILABLE/);
});

/**
 * A TRANSPORT failure is not a verdict about the mod, and must not latch.
 *
 * `save-all flush` takes 1-7 s on the reference server and shares one serialised RCON
 * pipe with everything else, so a Join issued behind one times out. Latching on that gave
 * a Join button that stayed disabled — saying the server had no `/player` command, which
 * it does — until the bridge was restarted. Observed on the deployed bridge.
 */
test('an RCON failure during join is retryable, not latched', async () => {
  let fail = true;
  const { fp, sent } = harness({
    reply: (cmd) => {
      if (fail) throw new Error('rcon timeout: ' + cmd);
      return 'ok';
    },
  });

  assert.equal(await fp.join(), false);
  assert.equal(fp.status().available, null, 'a timeout says nothing about the mod');
  assert.match(fp.status().reason, /rcon timeout/);

  // Nothing is being driven in the meantime — that guarantee is unchanged.
  await fp.input({ forward: true });
  await fp.look(0, 0);
  assert.equal(sent.length, 1, 'a failed join must not leave anything sending');

  // ...and pressing Join again actually tries again.
  fail = false;
  assert.equal(await fp.join(), true);
  assert.equal(fp.active, true);
});

test('a server that ANSWERS no still latches, so W never becomes 200 failing commands', async () => {
  const { fp, sent } = harness({ reply: NO_SUCH_COMMAND });
  assert.equal(await fp.join(), false);
  assert.equal(fp.status().available, false);
  for (let i = 0; i < 10; i++) await fp.join();
  assert.equal(sent.length, 1, 'a verdict is final; a timeout is not');
});

test('an illegal bot name is refused before any command is built', async () => {
  const { fp, sent } = harness({ botName: 'Bot say hi' });
  assert.equal(await fp.join(), false);
  assert.deepEqual(sent, []);
  assert.match(fp.status().reason, /not a legal player name/);
});

test('with the mod present, movement is sent on CHANGE only', async () => {
  const { fp, sent } = harness({ reply: 'WebViewer joined the game' });
  assert.equal(await fp.join(), true);
  assert.equal(fp.active, true);
  sent.length = 0;

  await fp.input({ forward: true });
  await fp.input({ forward: true });
  await fp.input({ forward: true });
  assert.deepEqual(sent, ['player WebViewer move forward'], 'held keys must not repeat');

  await fp.input({ forward: false, back: true });
  await fp.input({});
  // NOT a bare `move` — SiliconeDolls rejects that; it stops with `stop`. Verified
  // against the live server.
  assert.deepEqual(sent, [
    'player WebViewer move forward',
    'player WebViewer move back',
    'player WebViewer stop',
  ]);
});

test('look converts browser radians to Minecraft degrees, and refuses NaN', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  // Browser yaw PI/2 -> camera facing -X (west) -> Minecraft yaw 90. The bot spawns at
  // yaw 0, so the relative turn is +90.
  await fp.look(Math.PI / 2, 0);
  assert.deepEqual(sent, ['player WebViewer turn 90.0 0.0']);

  await fp.look(NaN, 0);
  await fp.look(0, Infinity);
  assert.equal(sent.length, 1, 'a NaN yaw must never reach the server');
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR SECOND.
 *
 * This conversion was `-yaw` rather than `180 - yaw`, so the body faced the exact reverse
 * of the camera: W walked backwards, A strafed right, and the crosshair pointed at the
 * block behind you. It was invisible in every unit test because both sides of the wrong
 * conversion agreed with each other; only the world disagreed.
 *
 * So this asserts against DIRECTION VECTORS rather than against numbers, which is the
 * form the failure actually took. Measured on the live server before the fix: camera
 * facing (0,0,-1) and the bot moved +3.7 on Z — a dot product of -1.
 */
test('the body faces where the camera looks, not the reverse of it', () => {
  /** three.js: a camera at yaw 0 looks down -Z. */
  const cameraFacing = (yawRad) => [-Math.sin(yawRad), 0, -Math.cos(yawRad)];
  /** Minecraft: yaw 0 faces +Z (south), 90 faces -X (west). */
  const minecraftFacing = (yawDeg) => {
    const r = (yawDeg * Math.PI) / 180;
    return [-Math.sin(r), 0, Math.cos(r)];
  };

  for (let deg = -180; deg <= 180; deg += 15) {
    const yawRad = (deg * Math.PI) / 180;
    const cam = cameraFacing(yawRad);
    const body = minecraftFacing(mcRotation(yawRad, 0).yaw);
    const dot = cam[0] * body[0] + cam[2] * body[2];
    assert.ok(dot > 0.9999, `browser yaw ${deg} deg: camera and body disagree (dot ${dot})`);
  }

  // The four cardinals, spelled out, because "180 - yaw" is easy to talk yourself out of.
  assert.equal(mcRotation(0, 0).yaw, 180, 'looking down -Z is Minecraft north (180)');
  assert.equal(mcRotation(Math.PI / 2, 0).yaw, 90, 'looking down -X is Minecraft west (90)');
  assert.equal(mcRotation(Math.PI, 0).yaw, 0, 'looking down +Z is Minecraft south (0)');
  assert.equal(mcRotation(-Math.PI / 2, 0).yaw, 270, 'looking down +X is Minecraft east');
});

test('pitch is a plain negation: three.js up is positive, Minecraft up is negative', () => {
  // `assert.ok` rather than `equal`: negating 0 gives -0, which is === 0 but not deepEqual.
  assert.ok(mcRotation(0, 0).pitch === 0);
  assert.equal(mcRotation(0, Math.PI / 2).pitch, -90, 'looking up is -90 in Minecraft');
  assert.equal(mcRotation(0, -Math.PI / 2).pitch, 90, 'looking down is +90 in Minecraft');
});

test('hotbar is 1-based for this mod, and clamped to slots it accepts', async () => {
  // Verified against the live server: `hotbar 0` -> "Integer must not be less than 1",
  // `hotbar 9` -> "Invalid slot". The browser sends 0-based (Digit1 -> 0).
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;
  await fp.hotbar(0);
  await fp.hotbar(2);
  await fp.hotbar(99);
  await fp.hotbar(-4);
  await fp.hotbar(1.5);
  assert.deepEqual(sent, [
    'player WebViewer hotbar 1',
    'player WebViewer hotbar 3',
    'player WebViewer hotbar 8',
    'player WebViewer hotbar 1',
  ]);
});

test('hotbarBase 0 restores fabric-carpet numbering', () => {
  const fp = new FakePlayer({ enabled: true, botName: 'B', hotbarBase: 0, run: async () => 'ok' });
  assert.equal(fp.hotbarBase, 0);
});

test('angleDelta always takes the short way round', () => {
  assert.equal(angleDelta(0, 90), 90);
  assert.equal(angleDelta(0, -90), -90);
  // 170 -> -170 is 20 degrees the short way, not 340 the long way.
  assert.equal(angleDelta(170, -170), 20);
  assert.equal(angleDelta(-170, 170), -20);
  assert.equal(angleDelta(0, 360), 0);
});

test('look sends a DELTA, because turn is relative and there is no absolute command', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  // Browser yaw PI/2 (camera facing west) is Minecraft yaw 90; the bot spawns at 0.
  await fp.look(Math.PI / 2, 0);
  assert.deepEqual(sent, ['player WebViewer turn 90.0 0.0']);
  assert.equal(fp.yaw, 90);

  // The SAME absolute angle again must send nothing — the bot is already there.
  await fp.look(Math.PI / 2, 0);
  assert.equal(sent.length, 1, 'an unchanged absolute look must not re-turn the player');

  // A further absolute target (browser PI = Minecraft 0) sends only the difference.
  await fp.look(Math.PI, 0);
  assert.deepEqual(sent[1], 'player WebViewer turn -90.0 0.0');
  assert.equal(fp.yaw, 0);
});

/**
 * THE OVERSHOOT.
 *
 * The rotation poll and a turn command run on two different RCON connections now, so they
 * genuinely overlap. A read issued before a turn returns the bot's rotation from BEFORE it,
 * and anchoring the model to that rewinds it — then the browser, which holds an ABSOLUTE
 * angle, re-sends the same delta and the server applies it twice. Measured before the fix:
 * 180 degrees of turning for a 90 degree target, and then oscillation.
 */
test('a rotation read that raced a turn is discarded, not applied', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  // The poll issues `data get ... Rotation`; the server will answer 0.
  const seqAtRead = fp.turnSeq;

  // Meanwhile the browser turns to Minecraft yaw 90.
  await fp.look(Math.PI / 2, 0);
  assert.deepEqual(sent, ['player WebViewer turn 90.0 0.0']);

  // The stale answer lands, describing where the bot was before that turn.
  fp.syncRotation(0, 0, seqAtRead);
  assert.equal(fp.yaw, 90, 'a read that raced a turn must not rewind the model');

  // The browser is still holding the same absolute angle.
  await fp.look(Math.PI / 2, 0);
  const turned = sent
    .map((c) => Number(/turn (-?[\d.]+)/.exec(c)[1]))
    .reduce((a, b) => a + b, 0);
  assert.equal(turned, 90, `the bot turned ${turned} deg for a 90 deg target`);
});

test('a rotation read that did NOT race a turn is still applied', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.look(Math.PI / 2, 0);
  sent.length = 0;

  // Nothing was sent between issuing this read and its answer, so it is ground truth:
  // a turn really was dropped, and the model must accept the correction.
  fp.syncRotation(0, 0, fp.turnSeq);
  assert.equal(fp.yaw, 0);

  await fp.look(Math.PI / 2, 0);
  assert.deepEqual(sent, ['player WebViewer turn 90.0 0.0'], 'a dropped turn must be re-sent');
});

test('syncRotation re-anchors the model from the server, so it cannot drift', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.look(Math.PI / 2, 0);   // model now believes yaw 90
  sent.length = 0;

  // The server says it is actually at 0 — a command was dropped. The next look must be
  // computed from the truth, not from the stale model.
  fp.syncRotation(0, 0);
  await fp.look(Math.PI / 2, 0);
  assert.deepEqual(sent, ['player WebViewer turn 90.0 0.0']);
});

test('halt stops the bot walking without making it leave', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.input({ forward: true });
  sent.length = 0;
  await fp.halt();
  assert.deepEqual(sent, ['player WebViewer stop']);
  assert.equal(fp.joined, true, 'halt is not leave');
  // And the next forward after a halt must be re-sent, not suppressed as "unchanged".
  await fp.input({ forward: true });
  assert.deepEqual(sent, ['player WebViewer stop', 'player WebViewer move forward']);
});

test('nothing is joined until Join is pressed', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  assert.equal(fp.joined, false);
  assert.equal(fp.active, false);
  // Control messages before a join must not reach the server.
  await fp.input({ forward: true });
  await fp.action('dig');
  assert.deepEqual(sent, [], 'a bridge that just booted must not be driving anything');
  assert.equal(fp.status().available, null, 'availability is unknown until asked');
});

test('leave despawns, and stops accepting control', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  assert.equal(fp.active, true);
  sent.length = 0;

  await fp.leave();
  assert.deepEqual(sent, ['player WebViewer kill']);
  assert.equal(fp.joined, false);
  assert.equal(fp.active, false);

  await fp.input({ forward: true });
  assert.equal(sent.length, 1, 'input after leaving must go nowhere');
});

test('leave is idempotent — a second disconnect must not re-kill', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;
  await fp.leave();
  await fp.leave();
  assert.deepEqual(sent, ['player WebViewer kill']);
});

test('rejoining after leaving works, and re-sends the held direction', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.input({ forward: true });
  await fp.leave();
  sent.length = 0;

  await fp.join();
  await fp.input({ forward: true });
  assert.deepEqual(sent, ['player WebViewer spawn', 'player WebViewer move forward'],
    'a fresh bot is not already walking, so the intent must be re-sent');
});

test('command strings are overridable for a mod that spells them differently', async () => {
  const { fp, sent } = harness({
    reply: 'ok',
    commands: { spawn: 'dolls spawn {name}', moveForward: 'dolls {name} walk fwd' },
  });
  await fp.join();
  await fp.input({ forward: true });
  assert.deepEqual(sent, ['dolls spawn WebViewer', 'dolls WebViewer walk fwd']);
});

// ---------------------------------------------------------------------------
// The action surface. These guard the thing SiliconeDolls makes easy to get wrong:
// it has exactly one stop, and it stops EVERYTHING.

test('dig holds the button down, and the server owns the breaking time', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  await fp.dig(true);
  assert.deepEqual(sent, ['player WebViewer attack continue']);
  await fp.dig(true);
  assert.equal(sent.length, 1, 'holding the mouse must not re-send every frame');

  await fp.dig(false);
  assert.deepEqual(sent, ['player WebViewer attack continue', 'player WebViewer stop']);
});

test('releasing the mouse while walking does not also stop you walking', async () => {
  // SiliconeDolls' `stop` cancels movement too, so the walk has to be re-asserted.
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.input({ forward: true });
  await fp.dig(true);
  sent.length = 0;

  await fp.dig(false);
  assert.deepEqual(sent, ['player WebViewer stop', 'player WebViewer move forward']);
});

test('releasing the key while digging does not also stop you digging', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.dig(true);
  await fp.input({ forward: true });
  sent.length = 0;

  await fp.input({});
  assert.deepEqual(sent, ['player WebViewer stop', 'player WebViewer attack continue']);
});

test('sneak and sprint are toggles, so they are sent only on a real change', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  await fp.input({ sneak: true });
  await fp.input({ sneak: true });
  await fp.input({ sneak: true });
  assert.deepEqual(sent, ['player WebViewer sneak'], 'a held Shift must not flicker');

  await fp.input({ sneak: false });
  assert.deepEqual(sent, ['player WebViewer sneak', 'player WebViewer sneak']);
});

test('a sneak that survived a stop is restored with everything else', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.input({ forward: true, sneak: true });
  await fp.dig(true);
  sent.length = 0;

  await fp.dig(false);
  assert.deepEqual(sent, [
    'player WebViewer stop',
    'player WebViewer move forward',
    'player WebViewer sneak',
  ]);
});

test('chat goes through `say` as the bot, and cannot inject a second command', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;

  await fp.chat('hello there');
  assert.deepEqual(sent, ['execute as WebViewer run say hello there']);

  // A newline would end the command and start another one on the server console.
  await fp.chat('hi\nop @a');
  assert.deepEqual(sent[1], 'execute as WebViewer run say hi op @a');

  await fp.chat('   ');
  await fp.chat('');
  await fp.chat(undefined);
  assert.equal(sent.length, 2, 'empty chat must not be sent');
});

test('chat is length-capped', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  sent.length = 0;
  await fp.chat('x'.repeat(500));
  assert.equal(sent[0].length, 'execute as WebViewer run say '.length + 200);
});

test('halt clears every intent, so a reconnect does not resume digging', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.join();
  await fp.input({ forward: true, sneak: true });
  await fp.dig(true);
  sent.length = 0;

  await fp.halt();
  assert.deepEqual(sent, ['player WebViewer stop'], 'halt restores nothing');
  assert.deepEqual(fp.intent, { move: '', digging: false, sneak: false, sprint: false });
});

test('no action reaches the server before Join', async () => {
  const { fp, sent } = harness({ reply: 'ok' });
  await fp.dig(true);
  await fp.use();
  await fp.drop();
  await fp.chat('hi');
  assert.deepEqual(sent, []);
});
