/**
 * Live computers — turtles above all — read with `computercraft dump`.
 *
 * WHY. Turtles are drawn from the region files' block entities, and a block entity only
 * moves when its chunk is flushed and re-read: every ~5 s at best. The crafter turtle
 * covers 24 blocks in 2 s, so on that path the fleet looks stuck and then teleports. CC:T's
 * own command lists every loaded computer with its block position:
 *
 *   Computer | On | Position
 *   ==============================
 *   #62      | Y  | -480, 64, 75
 *   #47      | Y  | -478, 64, 75
 *
 * (each row prefixed with an ANSI reset over RCON, and ~35 rows on the reference server).
 * One command a second, one packet of reply, and the browser interpolates between the
 * readings exactly as it does for players. There are no labels here — those come from the
 * turtle block entities the browser already has in the region data.
 *
 * DISCIPLINE. This is one more command on the observe connection, serialised behind the
 * roster poll by RconClient (never two packets on the wire at once), run only while a
 * viewer is connected, floored at 500 ms, never overlapping (one loop, each poll awaited),
 * REPORTED when it fails rather than swallowed, and LATCHED OFF the moment the server says
 * it does not know the command — a server without CC:T must not be asked 3600 times an
 * hour. Everything a browser sees comes from this file's one parse; nothing here writes.
 */

export const TURTLE_FLOOR_MS = 500;
export const TURTLE_DEFAULT_MS = 1000;

/** ESC [ ... m — built rather than written, so no control character sits in a regex literal. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const ROW_RE = /^#(\d+)\s*\|\s*([YN])\s*\|\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)$/;
const HEADER_RE = /^(Computer\s*\|\s*On\s*\|\s*Position|=+)$/i;
const UNKNOWN_RE = /Unknown or incomplete command|Incorrect argument for command|Unknown command/i;

/**
 * `computercraft dump` -> { computers: [{ id, on, x, y, z }], skipped }.
 *
 * Lines that are neither the header nor a row are counted, not guessed at: a pocket
 * computer has no block position and CC:T prints something else for it, and a future
 * version may add a column. Unparseable rows are the caller's to report, not to draw.
 */
export function parseComputerDump(text) {
  const out = { computers: [], skipped: 0 };
  if (typeof text !== 'string') return out;
  for (const raw of text.replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || HEADER_RE.test(line)) continue;
    const m = ROW_RE.exec(line);
    if (!m) {
      out.skipped++;
      continue;
    }
    out.computers.push({
      id: Number(m[1]),
      on: m[2] === 'Y',
      x: Number(m[3]),
      y: Number(m[4]),
      z: Number(m[5]),
    });
  }
  return out;
}

/** The server's own words for "no such command" — CC:T is not installed, or renamed it. */
export function isUnknownCommand(reply) {
  return UNKNOWN_RE.test(String(reply ?? ''));
}

export class TurtlePoller {
  #running = false;
  #lastSkipped = 0;

  /**
   * @param {object} opts
   * @param {number}  opts.intervalMs  poll cadence; 0 or NaN disables; floored at 500 ms
   * @param {(cmd: string) => Promise<string>} opts.run  the serialised RCON command runner
   * @param {(msg: object) => void} opts.emit  broadcast to every browser
   * @param {(id: number) => ({ name?: string|null, label?: string|null }|null)} [opts.labelFor]
   *        activity label for one computer id, from HQ. Folded into each emitted row so the
   *        browser gets "where" and "what" in one message; null when HQ has nothing for it.
   * @param {(msg: string) => void} [opts.log]
   * @param {(ms: number) => Promise<void>} [opts.sleep]  injected for tests
   */
  constructor(opts) {
    const ms = Number(opts.intervalMs);
    this.enabled = Number.isFinite(ms) && ms > 0;
    this.intervalMs = this.enabled ? Math.max(TURTLE_FLOOR_MS, ms) : 0;
    this.run = opts.run;
    this.emit = opts.emit;
    this.labelFor = opts.labelFor ?? (() => null);
    this.log = opts.log ?? (() => {});
    this.sleep = opts.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
    /** null until the first reply has been seen; false once the server said no. */
    this.available = this.enabled ? null : false;
    this.reason = this.enabled ? '' : 'disabled (MCWV_TURTLE_MS=0)';
    this.failures = 0;
    this.polls = 0;
    this.count = 0;
    /** The last good roster, for a browser that connects between polls. */
    this.last = [];
  }

  get running() {
    return this.#running;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      intervalMs: this.intervalMs,
      count: this.count,
      failures: this.failures,
      reason: this.reason,
    };
  }

  /**
   * Poll until `shouldRun()` says stop. A second call while running is a no-op, which is
   * what lets the observer call it from every place the viewer count changes.
   */
  async loop(shouldRun) {
    if (this.#running || !this.enabled || this.available === false) return;
    this.#running = true;
    try {
      while (shouldRun() && this.available !== false) {
        await this.once();
        await this.sleep(this.intervalMs);
      }
    } finally {
      this.#running = false;
    }
  }

  /** One poll. Never throws: every outcome is either a broadcast or a report. */
  async once() {
    let reply;
    try {
      reply = await this.run('computercraft dump');
    } catch (e) {
      this.#failed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (isUnknownCommand(reply)) {
      this.#latchOff(reply);
      return;
    }
    const { computers, skipped } = parseComputerDump(reply);
    if (!computers.length && skipped) {
      this.#failed(`reply not understood: ${String(reply).slice(0, 80)}`);
      return;
    }
    if (skipped !== this.#lastSkipped) {
      this.#lastSkipped = skipped;
      if (skipped) this.log(`computercraft dump: ${skipped} line(s) not understood, not drawn`);
    }
    this.available = true;
    this.polls++;
    this.count = computers.length;
    const list = computers.map((c) => this.#withLabel(c));
    this.last = list;
    this.#recovered();
    this.emit({ t: 'turtles', list, at: Date.now() });
  }

  /** Fold HQ's name and activity line into one row, leaving them off when HQ has none. */
  #withLabel(computer) {
    const l = this.labelFor(computer.id);
    if (!l) return computer;
    const row = { ...computer };
    if (l.name != null) row.name = l.name;
    if (l.label != null) row.label = l.label;
    return row;
  }

  /** Same reporting rhythm as the roster poll: every failure logged, the browser told on the first and every tenth. */
  #failed(message) {
    this.failures++;
    this.log(`turtle poll FAILED (${this.failures} in a row): ${message}`);
    if (this.failures === 1 || this.failures % 10 === 0) {
      this.emit({ t: 'pollError', scope: 'turtle', failures: this.failures, message });
    }
  }

  #recovered() {
    if (!this.failures) return;
    const n = this.failures;
    this.failures = 0;
    this.log(`turtle poll recovered after ${n} failure(s)`);
    this.emit({ t: 'status', message: `turtle poll recovered after ${n} failure(s)` });
  }

  #latchOff(reply) {
    this.available = false;
    this.reason = `server does not know 'computercraft dump': ${String(reply).trim().slice(0, 80)}`;
    this.log(`turtles: OFF — ${this.reason}`);
    this.emit({ t: 'status', message: `live turtles unavailable — ${this.reason}` });
  }
}
