/**
 * Fake-player control — the "play from the browser" path.
 *
 * A browser cannot open a TCP socket and a JS protocol client cannot decode a modded
 * NeoForge chunk (see ARCHITECTURE.md), so the only way to *act* in this world from a
 * browser is to have the server drive a real `ServerPlayer` on our behalf and to keep
 * rendering the world from the save files.
 *
 * WHAT THIS NEEDS THAT THE REFERENCE SERVER DOES NOT HAVE.
 * A mod that can create a real `ServerPlayer` without authentication — the mechanism
 * fabric-carpet uses in `EntityPlayerMPFake.createFake()`, which calls
 * `PlayerList.placeNewPlayer` with a `FakeClientConnection` and an offline UUID. That
 * yields a first-class player: it ticks, loads chunks, appears in the tab list, and is
 * seen as a real player by Create, AE2 and MineColonies. On NeoForge 1.21.1 the
 * maintained options are SiliconeDolls and Carpet: NeoForged.
 *
 * NeoForge's own `net.neoforged.neoforge.common.util.FakePlayer` is NOT this: it is an
 * attribution token with a stubbed connection, never added to the `PlayerList`, so it
 * does not tick and is not visible. It will not work.
 *
 * SO THIS IS OFF BY DEFAULT, IT ONLY ACTS WHEN ASKED, AND IT PROVES ITSELF ONCE.
 * `MCWV_FAKEPLAYER_ENABLE=1` only permits an attempt. Nothing is spawned at startup —
 * a fake player standing in the world because a container booted is a bot nobody asked
 * for. It appears when somebody presses Join, and it is despawned again on Leave or when
 * the last viewer disconnects.
 *
 * The first Join doubles as the capability probe. A server without the mod answers
 * `Unknown or incomplete command`, and this module then latches UNAVAILABLE and refuses
 * every subsequent control message. That matters more than it looks — the alternative is
 * a browser holding W and this bridge firing a failing command at a live server several
 * times a second, forever, with nothing on screen to say why nothing moves.
 *
 * The command strings are configurable because each mod spells them differently, and
 * guessing another mod's syntax is exactly how this breaks silently.
 */

/**
 * Every command is a template; `{name}` is the bot, the rest are per-call.
 *
 * These are SiliconeDolls' syntax, each one VERIFIED against the live server rather than
 * copied from documentation. Three of them differ from fabric-carpet, and all three fail
 * quietly rather than loudly, which is why they are pinned here:
 *
 *   moveStop   carpet stops with a bare `move`; SiliconeDolls rejects that
 *              ("Unknown or incomplete command") and stops with `stop`.
 *   hotbar     carpet is 0-8; SiliconeDolls is 1-based and rejects 0 outright
 *              ("Integer must not be less than 1"). See HOTBAR_BASE.
 *   turn       RELATIVE on both, and there is no absolute-angle command here —
 *              `look` takes only `at <pos>` or a compass direction. So the bridge
 *              tracks the bot's rotation and sends deltas. See `look()`.
 *
 * For fabric-carpet, override with MCWV_FAKEPLAYER_COMMANDS:
 *   {"moveStop":"player {name} move"}   and MCWV_HOTBAR_BASE=0
 */
export const DEFAULT_COMMANDS = {
  spawn: 'player {name} spawn',
  despawn: 'player {name} kill',
  moveForward: 'player {name} move forward',
  moveBack: 'player {name} move back',
  moveLeft: 'player {name} move left',
  moveRight: 'player {name} move right',
  moveStop: 'player {name} stop',
  jump: 'player {name} jump once',
  sneakOn: 'player {name} sneak',
  sprintOn: 'player {name} sprint',
  stop: 'player {name} stop',
  attack: 'player {name} attack once',
  use: 'player {name} use once',
  turn: 'player {name} turn {yaw} {pitch}',
  hotbar: 'player {name} hotbar {slot}',
  digStart: 'player {name} attack continue',
  /** Re-spawning a dead bot. SiliconeDolls reuses `spawn`; verified against the server. */
  respawn: 'player {name} spawn',
  drop: 'player {name} drop',
  /**
   * The bot has no chat command of its own, so it speaks through vanilla `say` run as
   * itself. That produces `[webviewer] hello` in chat and in the server log, which is
   * where the bridge reads chat back from.
   */
  chat: 'execute as {name} run say {message}',
};

/** SiliconeDolls numbers the hotbar from 1, and rejects 9 as "Invalid slot". */
export const HOTBAR_BASE = 1;
export const HOTBAR_SLOTS = 8;

/** Shortest signed angle from `from` to `to`, so a turn never takes the long way round. */
export function angleDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Browser look angles (three.js radians) -> Minecraft rotation (degrees).
 *
 * THE TWO CONVENTIONS ARE 180 DEGREES APART, and getting that wrong is silent.
 *
 *   three.js  a camera at yaw 0 looks down -Z; facing = (-sin y, sin p, -cos y * cos p)
 *   Minecraft yaw 0 faces +Z (south), 90 faces -X (west); facing = (-sin Y, .., cos Y)
 *
 * Solving those for the same heading gives `Y = 180 - y`, not `Y = -y`. The renderer has
 * always known this — `entityYawDeg()` draws a player with exactly the same `180 - yaw`
 * — but this conversion did not, so the body faced the reverse of the camera. Measured
 * against the live server: camera facing (0,0,-1), `W` moved the bot +3.7 on Z. Every
 * direction was mirrored — forward walked backwards, left strafed right, and the
 * crosshair pointed at the block behind you.
 *
 * Pitch is a plain negation: three.js pitch is positive looking up, Minecraft's is
 * negative looking up, and neither has an offset.
 */
export function mcRotation(yawRad, pitchRad) {
  return {
    yaw: 180 - (yawRad * 180) / Math.PI,
    pitch: -(pitchRad * 180) / Math.PI,
  };
}

/**
 * How a Brigadier server says "I have never heard of this command". Checked as a set of
 * signatures rather than one string because the reply differs between a missing root
 * command and a bad argument, and both mean the same thing here: this mod is not present.
 */
const NOT_A_COMMAND = [
  'Unknown or incomplete command',
  '<--[HERE]',
  'Unknown command',
];

export function isCommandMissing(reply) {
  const text = String(reply ?? '');
  return NOT_A_COMMAND.some((sig) => text.includes(sig));
}

export function template(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Bot names go into a command string, so they get the same validation player names do. */
export function isValidBotName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
}

const DIRECTIONS = ['forward', 'back', 'left', 'right'];

export class FakePlayer {
  #run;
  #lastMove = '';

  /**
   * @param {object} opts
   * @param {boolean} opts.enabled          MCWV_FAKEPLAYER_ENABLE — permission to try
   * @param {string}  opts.botName
   * @param {object}  [opts.commands]       overrides for DEFAULT_COMMANDS
   * @param {(cmd: string) => Promise<string>} opts.run  issues one RCON command
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.enabled = opts.enabled === true;
    this.name = opts.botName;
    this.commands = { ...DEFAULT_COMMANDS, ...(opts.commands ?? {}) };
    this.#run = opts.run;
    this.hotbarBase = opts.hotbarBase ?? HOTBAR_BASE;
    this.log = opts.log ?? (() => {});
    /**
     * The bridge's model of where the bot is looking, in Minecraft degrees.
     *
     * `turn` is relative and there is no absolute-angle command, so an absolute browser
     * yaw has to become a delta. The model is corrected from the real `Rotation` on every
     * player poll, so it cannot drift for more than a second even if a command is dropped.
     */
    this.yaw = 0;
    this.pitch = 0;
    /**
     * Bumped on every turn sent. A rotation read carries the value it saw when it was
     * issued, so `syncRotation` can tell a fresh answer from one that describes the bot
     * before a turn it did not know about. See `syncRotation`.
     */
    this.turnSeq = 0;
    /** null until the first join attempt; true/false afterwards and then latched. */
    this.available = null;
    /** Whether a fake player is in the world right now. */
    this.joined = false;
    /** Why it is unavailable, verbatim from the server where there is a reply. */
    this.reason = this.enabled ? 'not tried yet' : 'disabled (MCWV_FAKEPLAYER_ENABLE is not 1)';
  }

  /** Control messages are honoured only while a player has actually been joined. */
  get active() {
    return this.enabled && this.available === true && this.joined;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      joined: this.joined,
      reason: this.reason,
      name: this.enabled ? this.name : null,
    };
  }

  /**
   * Spawn the fake player. This is what the Join button does, and the first call is also
   * the capability probe.
   *
   * Never throws: a control path that cannot come up must leave the observer — which is
   * the part that always works — running.
   */
  async join() {
    if (!this.enabled) return false;
    if (this.available === false) return false; // already latched; do not re-ask
    if (this.joined) return true;
    if (!isValidBotName(this.name)) {
      this.#unavailable(`bot name ${JSON.stringify(this.name)} is not a legal player name`);
      return false;
    }
    let reply;
    try {
      reply = await this.#run(template(this.commands.spawn, { name: this.name }));
    } catch (e) {
      // NOT latched. A transport failure is not a verdict: `save-all flush` can take
      // seconds on this server and shares one serialised RCON pipe with everything else,
      // so a Join issued behind one can simply time out. Latching on that turned a slow
      // tick into a Join button that stayed disabled until the bridge was restarted.
      this.#retryable(`spawn command failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (isCommandMissing(reply)) {
      this.#unavailable(
        'the server has no `/player` command — install SiliconeDolls or Carpet: NeoForged,'
        + ' or set MCWV_FAKEPLAYER_COMMANDS for a mod that spells it differently',
      );
      return false;
    }
    this.available = true;
    this.joined = true;
    // 'moveStop' rather than '': a first input frame with no key held is the common case
    // (the browser sends one on focus) and must not fire a `stop` at the server.
    this.#lastMove = 'moveStop';
    this.yaw = 0;
    this.pitch = 0;
    this.intent = { move: '', digging: false, sneak: false, sprint: false };
    this.reason = reply.trim() || 'spawned';
    this.log(`fake player: ${this.name} joined (${this.reason})`);
    return true;
  }

  /** Despawn. Called by the Leave button and when the last viewer disconnects. */
  async leave() {
    if (!this.joined) return;
    this.joined = false;
    this.#lastMove = '';
    await this.#send(this.commands.despawn);
    this.log(`fake player: ${this.name} left`);
  }

  /**
   * The server ANSWERED and the answer was no. Latched: `available` stays false, every
   * later control message is refused, and the browser prints the reason under a disabled
   * button. This is the guard that stops a browser holding W from becoming a stream of
   * failing commands at a live world.
   */
  #unavailable(reason) {
    this.available = false;
    this.reason = reason;
    this.log(`fake player: UNAVAILABLE — ${reason}`);
  }

  /**
   * The attempt never reached a verdict. Deliberately does NOT latch — `available` stays
   * null, so pressing Join again tries again. Nothing is left running either way: without
   * `joined`, `active` is false and no control message reaches the server.
   */
  #retryable(reason) {
    this.reason = reason;
    this.log(`fake player: join did not complete (retryable) — ${reason}`);
  }

  /**
   * Movement is stateful in these mods: `move forward` walks until `move` with no
   * direction. So a command goes out only when the intent actually changes, rather than
   * one per browser frame.
   */
  async input(msg) {
    if (!this.active) return;
    const held = DIRECTIONS.find((d) => msg[d] === true);
    const key = held ? `move${held[0].toUpperCase()}${held.slice(1)}` : 'moveStop';
    this.intent.move = held ? key : '';
    if (key !== this.#lastMove) {
      this.#lastMove = key;
      // Stopping movement means `stop`, which also cancels digging and sneaking; put
      // them back rather than letting a key release silently cancel a mouse hold.
      if (!held) await this.#stopAll();
      else await this.#send(this.commands[key]);
    }
    if (msg.jump) await this.#send(this.commands.jump);
    await this.#setToggle('sneak', msg.sneak === true, this.commands.sneakOn);
    await this.#setToggle('sprint', msg.sprint === true, this.commands.sprintOn);
  }

  /**
   * `sneak` and `sprint` are TOGGLES with no explicit off, so the bridge tracks their
   * state and only sends the command when the browser's intent actually flips. Sending it
   * on every input frame would turn a held Shift into a flicker.
   */
  async #setToggle(field, want, command) {
    if (this.intent[field] === want) return;
    this.intent[field] = want;
    await this.#send(command);
  }

  /**
   * The only stop this mod has, plus everything it collaterally cancelled.
   *
   * SiliconeDolls' `stop` is all-or-nothing. Digging while walking and then releasing one
   * of them has to leave the other running, so the intent is re-applied afterwards.
   */
  async #stopAll() {
    await this.#send(this.commands.stop);
    this.#lastMove = this.intent.move || 'moveStop';
    if (this.intent.move) await this.#send(this.commands[this.intent.move]);
    if (this.intent.digging) await this.#send(this.commands.digStart);
    if (this.intent.sneak) await this.#send(this.commands.sneakOn);
    if (this.intent.sprint) await this.#send(this.commands.sprintOn);
  }

  /**
   * Hold-to-break. The SERVER decides how long a block takes — hardness, tool, efficiency,
   * haste, whether the bot is underwater — so "the correct block-breaking time" is not
   * something this bridge computes or could get wrong. It just holds the button down.
   */
  async dig(down) {
    if (!this.active || this.intent.digging === down) return;
    this.intent.digging = down;
    if (down) await this.#send(this.commands.digStart);
    else await this.#stopAll();
  }

  /** Right-click: place a block, open a door or a chest, press a button, use an item. */
  async use() {
    if (!this.active) return;
    await this.#send(this.commands.use);
  }

  async drop() {
    if (!this.active) return;
    await this.#send(this.commands.drop);
  }

  /**
   * Come back after dying.
   *
   * Deliberately checks `joined` rather than `active`: a dead bot is still joined, and
   * `active` is what gates ordinary actions — which should stay blocked while dead.
   */
  async respawn() {
    if (!this.enabled || !this.joined) return;
    this.intent = { move: '', digging: false, sneak: false, sprint: false };
    await this.#send(this.commands.respawn);
  }

  /**
   * Speak as the bot. The message is scrubbed rather than escaped: it is interpolated
   * into a server command, so a newline would become a second command line.
   */
  async chat(message) {
    if (!this.active || typeof message !== 'string') return;
    const clean = message.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    await this.#send(this.commands.chat, { message: clean });
  }

  /**
   * Point the bot at an ABSOLUTE browser yaw/pitch (radians).
   *
   * `turn` is relative, so this sends the difference from the tracked model and then
   * advances the model by exactly what it sent — which is sound because `turn` adds
   * precisely its argument. `syncRotation` re-anchors it from the server each poll.
   *
   * The browser's angles are three.js's; `mcRotation` is what makes the body face where
   * the camera is actually looking rather than the reverse of it.
   */
  async look(yaw, pitch) {
    if (!this.active || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    const { yaw: targetYaw, pitch: targetPitch } = mcRotation(yaw, pitch);
    const dYaw = angleDelta(this.yaw, targetYaw);
    const dPitch = Math.max(-90, Math.min(90, targetPitch)) - this.pitch;
    // Sub-degree turns are below what the player can even represent; skip the round trip.
    if (Math.abs(dYaw) < 0.5 && Math.abs(dPitch) < 0.5) return;
    this.yaw += dYaw;
    this.pitch += dPitch;
    this.turnSeq++;
    await this.#send(this.commands.turn, { yaw: dYaw.toFixed(1), pitch: dPitch.toFixed(1) });
  }

  /**
   * Ground truth from the player poll; stops the model drifting on a lost command.
   *
   * `seq` is `turnSeq` AS IT WAS WHEN THE READ WAS ISSUED, and a mismatch means a turn was
   * sent while the read was in flight — so the answer describes the bot BEFORE that turn.
   * Anchoring to it rewinds the model, and because the browser holds an ABSOLUTE angle, the
   * next look computes the same delta again and sends a turn the server has already
   * applied. Measured in `fake-player.test.mjs`: the bot turned 180 degrees for a 90 degree
   * target, then oscillated.
   *
   * This is only reachable because control has its own RCON connection now — on one shared
   * pipe the read and the turn could not overlap. Fixing the head-of-line blocking is what
   * made the race real, which is the usual price of removing a queue.
   *
   * A stale sample is DISCARDED rather than merged: the next poll is 500 ms away at worst,
   * and the model is exactly right in the meantime unless a command was actually dropped.
   */
  syncRotation(yaw, pitch, seq) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    if (seq !== undefined && seq !== this.turnSeq) return;
    this.yaw = yaw;
    this.pitch = pitch;
  }

  async action(kind) {
    if (!this.active) return;
    await this.#send(kind === 'dig' ? this.commands.attack : this.commands.use);
  }

  /** `slot` is 0-based from the browser (Digit1 -> 0); the mod may number from 1. */
  async hotbar(slot) {
    if (!this.active || !Number.isInteger(slot)) return;
    const base = this.hotbarBase;
    const n = Math.max(base, Math.min(base + HOTBAR_SLOTS - 1, slot + base));
    await this.#send(this.commands.hotbar, { slot: n });
  }

  /** Drop every intent — the browser released the pointer lock, or the last one left. */
  async halt() {
    if (!this.active) return;
    this.intent = { move: '', digging: false, sneak: false, sprint: false };
    this.#lastMove = 'moveStop';
    await this.#send(this.commands.stop);
  }

  #send(tpl, vars = {}) {
    return this.#run(template(tpl, { name: this.name, ...vars })).catch((e) => {
      this.log(`fake player command failed: ${e.message}`);
      return '';
    });
  }
}
