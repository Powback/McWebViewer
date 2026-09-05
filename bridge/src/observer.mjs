/**
 * The live tier: a READ-ONLY observer of a running Minecraft server.
 *
 * It issues exactly four kinds of command, all of them over RCON:
 *
 *   list                                  who is online
 *   data get entity <name> Pos|Rotation|Dimension    where they are
 *   computercraft dump                    where every loaded computer (turtle) is
 *   save-all flush                        ask the server to write changed chunks to disk
 *
 * The first three are pure reads. The fourth is a write, and it is the only one — it is
 * guarded hard by FlushTimer (off by default, only while a viewer is connected, floored
 * at 2 s, self-backing-off). See flush-timer.mjs for why that guard is not optional.
 *
 * NOTHING HERE MOVES ANYTHING. The previous version of this file drove a fake player with
 * `/player <name> spawn|move|turn|attack`. That is fabric-carpet syntax; this server runs
 * NeoForge with no carpet-equivalent mod installed, so every one of those commands failed
 * at runtime. They are gone rather than left behind a flag, because a control path that
 * cannot work is worse than no control path — see ARCHITECTURE.md.
 *
 * The world itself is NOT streamed over this socket. It is read from the save files by
 * the browser (see src/app/region-sync.ts): save files are string-keyed, so every modded
 * block renders exactly, which the network protocol cannot do on a NeoForge server.
 */

import { RconClient } from './rcon.mjs';
import { FlushTimer } from './flush-timer.mjs';
import { FakePlayer } from './fake-player.mjs';
import { ChatLog } from './chat-log.mjs';
import { TURTLE_DEFAULT_MS, TurtlePoller } from './computers.mjs';
import { HqPoller } from './hq.mjs';
import { readBlock, readInventory, readPos, readRotation, readVitals } from './player-state.mjs';
import {
  isValidPlayerName, parseDimension, parsePlayerList, parsePos, parseRotation,
} from './players.mjs';

/** Roster polling floor. `list` + 3 `data get`s per player is cheap, but not free. */
export const POLL_FLOOR_MS = 500;
export const POLL_DEFAULT_MS = 1000;

/**
 * The bot's own position, polled far faster than the roster because it is what the camera
 * follows. Measured on the reference server: 10 Hz of `data get … Pos` is indistinguishable
 * from idle in the tick-time distribution (median mspt 26.0 under load vs 36.4 idle across
 * one interleaved run, 18.8 vs 24.6 across the next — the server's own variance is larger
 * than the cost). The real limit is round-trip latency, ~3-6 ms median and ~26-50 ms p95,
 * because commands are drained on the tick thread; polling faster than that just queues.
 */
export const SELF_FLOOR_MS = 50;
export const SELF_DEFAULT_MS = 100;
/** Health/hunger/XP/slot change at human speed. */
export const VITALS_DEFAULT_MS = 500;
/** Inventory is the most expensive read; it is also the one that changes least. */
export const INVENTORY_DEFAULT_MS = 2000;
/** Cap the per-tick command count regardless of how busy the server gets. */
export const MAX_TRACKED_DEFAULT = 10;

/**
 * The server's own words for "that player is not here any more".
 *
 * Emitted when somebody logs out or changes dimension between the `list` and the `data
 * get` that follows it. It is the ONLY parse failure that is not a fault, which is why it
 * is matched explicitly instead of treating every unreadable reply as a departure.
 */
const LEFT_RE = /No entity was found/i;

export class Observer {
  #rcon = null;
  /**
   * A SECOND RCON connection, used only for control commands.
   *
   * `save-all flush` takes 1-7 s on this server and blocks the connection it runs on for
   * the whole of it — RCON is one request per connection at a time, by protocol. With one
   * pipe, a Join or a keypress issued while a flush was in flight queued behind it and,
   * often enough, exceeded the command timeout: the browser pressed Join, nothing spawned,
   * and live block updates had to be turned off entirely for playing to work at all.
   *
   * Vanilla's RCON server handles each connection on its own thread with its own buffer,
   * so a second connection is not the pipelining hazard a second in-flight command on ONE
   * connection is (see rcon.mjs). Control and flushing now genuinely coexist.
   */
  #control = null;
  #stopped = false;
  /** Pending reconnect timers, so `stop()` really stops. */
  #retries = new Set();
  #polling = false;
  #selfPolling = false;
  #clients = 0;
  #seq = 0;

  /**
   * @param {object} opts
   * @param {(msg: object) => void} emit broadcast to every connected browser
   */
  constructor(opts, emit) {
    this.opts = opts;
    this.emit = emit;
    this.log = opts.log ?? (() => {});
    this.pollMs = Math.max(POLL_FLOOR_MS, opts.pollMs ?? POLL_DEFAULT_MS);
    this.selfMs = Math.max(SELF_FLOOR_MS, opts.selfMs ?? SELF_DEFAULT_MS);
    this.vitalsMs = opts.vitalsMs ?? VITALS_DEFAULT_MS;
    this.inventoryMs = opts.inventoryMs ?? INVENTORY_DEFAULT_MS;
    this.maxTracked = opts.maxTracked ?? MAX_TRACKED_DEFAULT;
    this.players = [];
    /** Consecutive roster polls that threw. Nonzero means the players on screen are stale. */
    this.pollFailures = 0;
    /** `data get` replies that could not be parsed, and were not a departure. */
    this.readFailures = 0;
    this.self = null;
    this.vitals = null;
    this.inventory = [];
    this.chatLog = opts.chatLogPath
      ? new ChatLog(opts.chatLogPath, (m) => this.emit({ t: 'chat', ...m }), { log: (x) => this.log(x) })
      : null;
    this.flushTimer = new FlushTimer({
      enabled: opts.flushEnabled,
      intervalMs: opts.flushMs,
      slowMs: opts.flushSlowMs,
      flush: () => this.flush(),
      log: (m) => this.log(m),
    });
    // Optional, off by default, and it proves itself against the real server before it
    // accepts anything from a browser. See fake-player.mjs.
    this.fakePlayer = new FakePlayer({
      enabled: opts.fakePlayerEnabled,
      botName: opts.botName ?? 'WebViewer',
      commands: opts.fakePlayerCommands,
      run: (cmd) => this.#runControl(cmd),
      log: (m) => this.log(m),
    });
    // What each turtle is DOING, from the settlement brain — polled in parallel with the
    // dump, off the docker network, never blocking the turtle stream. See hq.mjs.
    this.hq = new HqPoller({
      intervalMs: opts.hqMs,
      url: opts.hqUrl,
      log: (m) => this.log(m),
    });
    // Turtles by `computercraft dump`, about once a second while somebody is watching. It
    // runs on the observe connection, serialised behind the roster poll like every other
    // read here, and owns its own guards — see computers.mjs. Each row is decorated with
    // HQ's name and activity line at emit time, so "where" and "what" arrive together.
    this.turtles = new TurtlePoller({
      intervalMs: opts.turtleMs ?? TURTLE_DEFAULT_MS,
      run: (cmd) => this.#run(cmd),
      emit: (m) => this.emit(m),
      labelFor: (id) => this.hq.labelFor(id),
      log: (m) => this.log(m),
    });
  }

  get ready() {
    return !!this.#rcon?.connected;
  }

  /**
   * Whether a control frame arriving right now would actually reach the server.
   *
   * Reported back to the browser on every ack, so a page whose input is being silently
   * discarded says so on screen instead of looking identical to one that is working.
   */
  get driving() {
    return this.fakePlayer.active;
  }

  /** Snapshot for the status message a browser gets on connect. */
  status() {
    return {
      connected: this.ready,
      players: this.players,
      flush: {
        enabled: this.flushTimer.enabled,
        running: this.flushTimer.running,
        intervalMs: this.flushTimer.intervalMs,
        lastDurationMs: this.flushTimer.lastDurationMs,
        flushes: this.flushTimer.flushes,
      },
      // The browser binds its controls off this and nothing else, so a server without the
      // mod produces a viewer with no controls rather than controls that do nothing.
      control: this.fakePlayer.status(),
      chat: { available: !!this.chatLog?.available },
      turtles: this.turtles.status(),
      hq: this.hq.status(),
    };
  }

  async start() {
    this.emit({ t: 'status', message: `rcon: connecting to ${this.opts.host}:${this.opts.port}` });
    this.#rcon = new RconClient({
      host: this.opts.host,
      port: this.opts.port,
      password: this.opts.password,
    });
    this.#rcon.onClose = () => this.#onDisconnect();
    await this.#rcon.connect();
    this.log(`rcon connected to ${this.opts.host}:${this.opts.port}`);
    await this.#ensureControl();
    // NOTHING is spawned here. The fake player appears only when somebody presses Join.
    //
    // Except: if RCON dropped while a bot was in the world, `leave()` could not be
    // delivered and the bot is still standing there. Reconciling on reconnect is what
    // stops a dropped connection leaking a player into the server permanently.
    await this.#reconcileBot();
    if (this.chatLog && !this.chatLog.available) await this.chatLog.start();
    this.emit({ t: 'hello', backend: 'observe', ...this.status() });
    // Re-arm whatever the client count already was; a reconnect must not leave the
    // flush timer stopped while somebody is still watching.
    this.flushTimer.setClients(this.#clients);
    void this.#pollLoop();
    void this.#turtleLoop();
    void this.#hqLoop();
  }

  #onDisconnect() {
    if (this.#stopped) return;
    this.flushTimer.stop();
    this.emit({ t: 'error', message: 'rcon disconnected — retrying in 10s' });
    // Tracked so `stop()` can cancel it. Without that a stopped observer still holds a
    // 10-second timer, which keeps the process (and every test that made one) alive.
    this.#retries.add(setTimeout(() => {
      if (!this.#stopped) this.start().catch((e) => this.log(`rcon start failed: ${e.message}`));
    }, 10_000));
  }

  /** Viewer count drives BOTH the flush timer and the poll loop: no viewers, no traffic. */
  setClients(n) {
    this.#clients = n;
    this.flushTimer.setClients(n);
    if (n > 0 && this.ready) {
      void this.#pollLoop();
      void this.#selfLoop();
      void this.#turtleLoop();
    }
    // HQ is a separate service, not behind RCON — poll it whenever anyone is watching, so
    // the activity labels are warm the moment the turtle stream starts.
    if (n > 0) void this.#hqLoop();
    // Nobody is watching any more; do not leave a bot standing in the world.
    if (n === 0) void this.fakePlayer.leave().then(() => this.#announceControl());
  }

  /**
   * After an RCON reconnect, make the world match what the bridge believes.
   *
   * Only ever removes: if nobody is watching, a bot that survived the drop is despawned.
   * It never re-spawns one, because "the connection blipped" is not a reason to put a
   * player back into a live server that nobody asked for.
   */
  async #reconcileBot() {
    if (!this.fakePlayer.joined) return;
    if (this.#clients > 0) return;
    this.log('rcon reconnected with a bot still joined and no viewers — despawning it');
    await this.fakePlayer.leave();
  }

  /** Push the control state to every browser, so a Join by one updates the others. */
  #announceControl() {
    this.emit({ t: 'control', control: this.fakePlayer.status() });
  }

  async join() {
    await this.fakePlayer.join();
    this.#announceControl();
    if (this.fakePlayer.joined) {
      void this.#selfLoop();
      void this.#refresh();
      return;
    }
    // A latched refusal already prints under the disabled button. A RETRYABLE failure
    // leaves the button enabled, so without this the press would look like it did nothing.
    if (this.fakePlayer.available !== false) {
      this.emit({ t: 'status', message: `join did not complete: ${this.fakePlayer.reason}` });
    }
  }

  async leave() {
    await this.fakePlayer.leave();
    this.#announceControl();
  }

  /**
   * Control messages from the browser. Every one is a no-op unless the fake player both
   * was enabled and passed its probe, so this is safe to call unconditionally.
   */
  async control(msg) {
    if (msg.t === 'join') return this.join();
    if (msg.t === 'leave') return this.leave();
    // Respawn must work while dead, when `active` is false by design.
    if (msg.t === 'respawn') return this.#respawn();
    if (!this.fakePlayer.active) return;
    const handler = this.#actions[msg.t];
    return handler ? handler(msg) : undefined;
  }

  /**
   * Control verbs as a table rather than a switch: it stays flat as the surface grows,
   * and each line reads as one entry of the protocol.
   */
  #actions = {
    input: (m) => this.fakePlayer.input(m),
    look: (m) => this.fakePlayer.look(Number(m.yaw), Number(m.pitch)),
    dig: (m) => this.fakePlayer.dig(m.down === true),
    attack: () => this.fakePlayer.action('dig'),
    use: () => this.fakePlayer.use(),
    drop: () => this.fakePlayer.drop(),
    hotbar: (m) => this.fakePlayer.hotbar(Number(m.slot)),
    say: (m) => this.fakePlayer.chat(String(m.message ?? '')),
    openBlock: (m) => this.openBlock(Number(m.x), Number(m.y), Number(m.z)),
    refresh: () => this.#refresh(),
  };

  async #respawn() {
    await this.fakePlayer.respawn();
    await this.#refresh();
  }

  /** Force the slow tiers immediately — used right after an action changes them. */
  async #refresh() {
    if (!this.fakePlayer.joined || !this.ready) return;
    const run = (c) => this.#run(c);
    await this.#pollVitals(run, this.fakePlayer.name).catch(() => {});
    await this.#pollInventory(run, this.fakePlayer.name).catch(() => {});
  }

  async #pollLoop() {
    if (this.#polling) return;
    this.#polling = true;
    try {
      while (!this.#stopped && this.ready && this.#clients > 0) {
        await this.#pollOnce().then(() => this.#pollRecovered(), (e) => this.#pollFailed(e));
        await sleep(this.pollMs);
      }
    } finally {
      this.#polling = false;
    }
  }

  /**
   * A roster poll that failed is REPORTED, not swallowed.
   *
   * This was `.catch(() => {})`. The consequence is not that nothing happens — it is that
   * the browser keeps drawing the last roster it received, with no message of any kind
   * saying the numbers behind those players stopped moving. A player frozen at a stale
   * position looks exactly like a player standing still, and that is the single most
   * expensive failure shape this project has: a plausible-looking default carried on as if
   * it were an answer.
   *
   * Every failure goes to the bridge log. The browser is told on the first one and then
   * every tenth, which is often enough to be impossible to miss and rare enough not to
   * bury the rest of the status line.
   */
  #pollFailed(err) {
    this.pollFailures++;
    this.log(`player poll FAILED (${this.pollFailures} in a row): ${err.message}`);
    if (this.pollFailures === 1 || this.pollFailures % 10 === 0) {
      this.emit({
        t: 'pollError',
        scope: 'players',
        failures: this.pollFailures,
        message: err.message,
      });
    }
  }

  #pollRecovered() {
    if (!this.pollFailures) return;
    const n = this.pollFailures;
    this.pollFailures = 0;
    this.log(`player poll recovered after ${n} failure(s)`);
    this.emit({ t: 'status', message: `player poll recovered after ${n} failure(s)` });
  }

  /**
   * Turtles at ~1 Hz on the same serialised connection. The poller owns its guards (floor,
   * no overlap, latch-off on an unknown command, failures reported); this only tells it
   * when somebody is watching — the condition that gates every other poll here.
   */
  #turtleLoop() {
    return this.turtles.loop(() => !this.#stopped && this.ready && this.#clients > 0);
  }

  /** HQ activity labels, ~1 Hz while a viewer is watching. Independent of RCON. */
  #hqLoop() {
    return this.hq.loop(() => !this.#stopped && this.#clients > 0);
  }

  /**
   * A `data get` whose reply we could not parse.
   *
   * "No entity was found" is the server telling us the player left between the `list` and
   * this read; that is ordinary and handled by the caller. Anything else is a reply we do
   * not understand, and the visible effect of returning null for it is a player who
   * silently vanishes from the roster — identical on screen to one who logged out. So it is
   * named, with the reply that caused it, rather than counted as a departure.
   */
  #readFailed(name, field, reply) {
    this.readFailures++;
    const text = String(reply ?? '').slice(0, 120);
    this.log(`unreadable ${field} for ${name}: ${JSON.stringify(text)}`);
    this.emit({
      t: 'status',
      message: `bridge: could not read ${field} for ${name} — NOT drawing them (${text})`,
    });
  }

  /**
   * The fast lane: the bot's own position, plus vitals and inventory on slower sub-beats.
   *
   * Separate from the roster loop because they want completely different rates — the
   * camera needs 10 Hz and `list` does not — and because merging them would make the
   * cheap read wait behind the expensive one.
   */
  async #selfLoop() {
    if (this.#selfPolling) return;
    this.#selfPolling = true;
    try {
      let beat = 0;
      while (!this.#stopped && this.ready && this.#clients > 0) {
        if (this.fakePlayer.joined) await this.#selfOnce(beat++).catch(() => {});
        else beat = 0;
        await sleep(this.selfMs);
      }
    } finally {
      this.#selfPolling = false;
    }
  }

  async #selfOnce(beat) {
    const name = this.fakePlayer.name;
    const run = (c) => this.#run(c);
    const pos = await readPos(run, name);
    if (pos) {
      this.self = { pos, at: Date.now() };
      this.emit({ t: 'self', pos, at: this.self.at });
    }
    if (this.#due(beat, this.vitalsMs)) await this.#pollVitals(run, name);
    if (this.#due(beat, this.inventoryMs)) await this.#pollInventory(run, name);
  }

  /** True once every `everyMs` worth of fast beats. */
  #due(beat, everyMs) {
    const every = Math.max(1, Math.round(everyMs / this.selfMs));
    return beat % every === 0;
  }

  async #pollVitals(run, name) {
    const vitals = await readVitals(run, name);
    const wasDead = this.vitals?.dead === true;
    this.vitals = vitals;
    this.emit({ t: 'vitals', ...vitals });
    if (vitals.dead && !wasDead) this.emit({ t: 'died' });
    // The rotation model has to be re-anchored from the server or it drifts on a dropped
    // turn; this is the cheapest place to do it that is not the camera-rate loop.
    // Captured BEFORE the read goes out: a turn sent while it is in flight makes the
    // answer stale, and re-anchoring to a stale answer double-turns the bot.
    const seq = this.fakePlayer.turnSeq;
    const rot = await readRotation(run, name);
    if (rot) this.fakePlayer.syncRotation(rot.yaw, rot.pitch, seq);
  }

  async #pollInventory(run, name) {
    const { stacks, truncated } = await readInventory(run, name);
    this.inventory = stacks;
    this.emit({ t: 'inventory', stacks, truncated: !!truncated });
  }

  /** Read a container's contents straight out of its block entity. */
  async openBlock(x, y, z) {
    if (!this.ready) return;
    const block = await readBlock((c) => this.#run(c), x, y, z);
    this.emit({ t: 'block', block });
  }

  async #pollOnce() {
    // Captured before any of the reads below; see `FakePlayer.syncRotation`.
    const seq = this.fakePlayer.turnSeq;
    const names = parsePlayerList(await this.#run('list')).slice(0, this.maxTracked);
    const list = [];
    for (const name of names) {
      const p = await this.#readPlayer(name);
      if (p) list.push(p);
    }
    this.players = list;
    this.#syncBot(list, seq);
    this.emit({ t: 'players', list });
  }

  /**
   * Re-anchor the fake player's rotation model from the server's own answer.
   *
   * The name comparison is case-INSENSITIVE on purpose: `/player WebViewer spawn` creates
   * a player that `list` reports as `webviewer`. Matching case-sensitively silently never
   * finds the bot, which shows up as a camera that will not follow — verified against the
   * live server, not assumed.
   */
  #syncBot(list, seq) {
    const wanted = this.fakePlayer.name?.toLowerCase();
    if (!wanted || !this.fakePlayer.joined) return;
    const bot = list.find((p) => p.name.toLowerCase() === wanted);
    if (bot) this.fakePlayer.syncRotation(bot.yaw, bot.pitch, seq);
  }

  /**
   * Three small reads rather than one `data get entity <name>`: the latter returns the
   * whole player NBT — inventory, ender chest, advancements — which is both expensive to
   * produce and routinely larger than RCON's 4096-byte packet, so it comes back truncated.
   */
  async #readPlayer(name) {
    if (!isValidPlayerName(name)) return null;
    const [posOut, rotOut, dimOut] = await Promise.all([
      this.#run(`data get entity ${name} Pos`),
      this.#run(`data get entity ${name} Rotation`),
      this.#run(`data get entity ${name} Dimension`),
    ]);
    const pos = parsePos(posOut);
    if (!pos) {
      if (!LEFT_RE.test(String(posOut))) this.#readFailed(name, 'Pos', posOut);
      return null;
    }
    const rot = parseRotation(rotOut) ?? { yaw: 0, pitch: 0 };
    const dimension = parseDimension(dimOut);
    // Passed on as null rather than defaulted. The browser refuses to draw a player whose
    // dimension is unknown, because guessing puts a nether player in the overworld and
    // nothing on screen would say so.
    if (dimension === null) this.#readFailed(name, 'Dimension', dimOut);
    return { name, pos, yaw: rot.yaw, pitch: rot.pitch, dimension };
  }

  #run(command) {
    if (!this.ready) return Promise.reject(new Error('rcon not connected'));
    return this.#rcon.command(command);
  }

  /**
   * Bring up the control connection, or leave it down without taking the observer with it.
   *
   * Never throws and never blocks startup: the observer half is the part that always
   * works, and a server that refuses a second RCON connection should degrade to sharing
   * one pipe, not to no live view at all.
   */
  async #ensureControl() {
    if (this.#stopped || this.#control?.connected) return;
    const link = new RconClient({
      host: this.opts.host,
      port: this.opts.port,
      password: this.opts.password,
    });
    link.onClose = () => {
      if (this.#control !== link) return;
      this.#control = null;
      if (!this.#stopped) this.#retries.add(setTimeout(() => void this.#ensureControl(), 10_000));
    };
    try {
      await link.connect();
      this.#control = link;
      this.log('rcon control connection up — flushing can no longer delay input');
    } catch (e) {
      this.#control = null;
      this.log(`rcon control connection unavailable, sharing the poll pipe: ${e.message}`);
    }
  }

  /**
   * Issue a control command on the dedicated connection.
   *
   * Falls back to the shared pipe when that connection is down: control that queues behind
   * a flush is worse than control that does not, and far better than none.
   */
  #runControl(command) {
    if (this.#control?.connected) return this.#control.command(command);
    return this.#run(command);
  }

  /**
   * The one write. Timed by the caller (FlushTimer) so a struggling server is noticed;
   * the measured duration is passed on to the browser so the HUD can show the real cost
   * rather than the configured interval.
   */
  async flush() {
    const t0 = Date.now();
    await this.#run('save-all flush');
    const tookMs = Date.now() - t0;
    this.emit({
      t: 'reload',
      seq: ++this.#seq,
      tookMs,
      intervalMs: this.flushTimer.intervalMs,
    });
    return tookMs;
  }

  stop() {
    this.#stopped = true;
    for (const t of this.#retries) clearTimeout(t);
    this.#retries.clear();
    this.flushTimer.stop();
    this.chatLog?.stop();
    this.#rcon?.close();
    this.#control?.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
