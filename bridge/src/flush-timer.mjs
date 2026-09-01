/**
 * The guarded `save-all flush` scheduler.
 *
 * WHY THIS FILE IS SO CAREFUL. Live block updates work by asking the Minecraft server to
 * write modified chunks to disk, then re-reading them. That command runs ON THE SERVER
 * TICK THREAD, and this particular server is not a toy: a ComputerCraft turtle fleet
 * lives in it. That fleet has already been destroyed once by exactly this failure mode —
 * host load spiked, the server could not tick, and CC:T killed a long-running computer
 * mid-write, taking the settlement down for hours. A fixed-cadence flush held through a
 * struggling server is a way to cause that again.
 *
 * So every rule below is a safety property, not a preference:
 *
 *   OFF BY DEFAULT           `enabled` must be set explicitly. Constructing this with no
 *                            options flushes nothing, ever.
 *   ONLY WHILE WATCHED       the timer runs only while `setClients(n)` has been told
 *                            n > 0. Zero viewers means zero flushes — we never flush into
 *                            an empty room.
 *   HARD FLOOR               the interval is clamped to FLOOR_MS no matter what the
 *                            config says. Faster looks smoother in the browser, and the
 *                            cost lands on the fleet, not on the viewer.
 *   SELF-BACKING-OFF         every flush is timed. One slow flush doubles the interval and
 *                            says so in the log. The cadence is never held through a
 *                            server that is visibly struggling.
 *   RECOVERS SLOWLY          the interval halves back toward the configured value only
 *                            after several consecutive fast flushes, so a server that is
 *                            intermittently slow settles at the slower cadence rather than
 *                            oscillating.
 *
 * The first flush is scheduled one interval AFTER a client connects, never immediately:
 * a browser in a reconnect loop would otherwise turn into a flush loop.
 *
 * Timer functions are injected so the whole policy is testable without real time; see
 * flush-timer.test.mjs.
 */

/** Never flush faster than this, whatever the configuration asks for. */
export const FLOOR_MS = 2000;
/** Default cadence when flushing is enabled but no interval is given. */
export const DEFAULT_MS = 5000;
/** Back-off ceiling. Past this the viewer is barely live, but the server is protected. */
export const MAX_MS = 120_000;
/**
 * A flush slower than this counts as "the server is struggling". The reference server
 * answers `save-all flush` in ~130 ms when healthy, so a full second is already an order
 * of magnitude off and worth backing away from.
 */
export const SLOW_MS = 1000;
/** Consecutive fast flushes required before the interval steps back down. */
export const RECOVER_AFTER = 5;

export class FlushTimer {
  #handle = null;
  #clients = 0;
  #fastRun = 0;
  #busy = false;

  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled]     master switch; false means this object does nothing
   * @param {number}  [opts.intervalMs]  requested cadence, clamped to >= FLOOR_MS
   * @param {number}  [opts.slowMs]      a flush slower than this triggers a back-off
   * @param {number}  [opts.maxMs]       back-off ceiling
   * @param {() => Promise<unknown>} opts.flush  performs one `save-all flush`
   * @param {(msg: string) => void}  [opts.log]
   * @param {() => number} [opts.now]
   * @param {(fn: () => void, ms: number) => unknown} [opts.schedule]
   * @param {(handle: unknown) => void} [opts.cancel]
   */
  constructor(opts) {
    this.enabled = opts.enabled === true;
    this.baseMs = clampInterval(opts.intervalMs ?? DEFAULT_MS, opts.maxMs ?? MAX_MS);
    this.intervalMs = this.baseMs;
    this.slowMs = opts.slowMs ?? SLOW_MS;
    this.maxMs = opts.maxMs ?? MAX_MS;
    this.flush = opts.flush;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h));
    /** Set once per flush so callers can report real, measured latency. */
    this.lastDurationMs = 0;
    this.flushes = 0;
  }

  get running() {
    return this.#handle !== null;
  }

  get clients() {
    return this.#clients;
  }

  /**
   * Tell the timer how many viewers are connected. This is the only thing that starts it:
   * the flush cost is only ever paid while somebody is actually looking.
   */
  setClients(n) {
    const had = this.#clients;
    this.#clients = Math.max(0, n | 0);
    if (!this.enabled) return;
    if (this.#clients > 0 && had === 0) {
      this.log(`flush timer on (${this.intervalMs} ms) — ${this.#clients} viewer(s) connected`);
      this.#arm();
    } else if (this.#clients === 0 && had > 0) {
      this.log('flush timer off — no viewers connected');
      this.stop();
    }
  }

  stop() {
    if (this.#handle !== null) this.cancel(this.#handle);
    this.#handle = null;
  }

  #arm() {
    this.stop();
    if (!this.enabled || this.#clients === 0) return;
    this.#handle = this.schedule(() => {
      this.#handle = null;
      void this.#tick();
    }, this.intervalMs);
  }

  async #tick() {
    // Overlapping flushes are exactly what a struggling server must not be given.
    if (this.#busy) return this.#arm();
    this.#busy = true;
    const t0 = this.now();
    let failed = false;
    try {
      await this.flush();
    } catch (e) {
      failed = true;
      this.log(`flush failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.#busy = false;
    }
    this.lastDurationMs = this.now() - t0;
    this.flushes++;
    this.#adjust(this.lastDurationMs, failed);
    this.#arm();
  }

  /** Back off on a slow or failed flush; step back down only after a run of fast ones. */
  #adjust(durationMs, failed) {
    if (failed || durationMs > this.slowMs) {
      this.#fastRun = 0;
      const next = Math.min(this.maxMs, this.intervalMs * 2);
      if (next !== this.intervalMs) {
        this.log(
          `flush took ${durationMs} ms (> ${this.slowMs} ms) — backing off ` +
            `${this.intervalMs} ms -> ${next} ms`,
        );
        this.intervalMs = next;
      }
      return;
    }
    if (this.intervalMs === this.baseMs) return;
    if (++this.#fastRun < RECOVER_AFTER) return;
    this.#fastRun = 0;
    const next = Math.max(this.baseMs, Math.floor(this.intervalMs / 2));
    this.log(`${RECOVER_AFTER} fast flushes — easing back ${this.intervalMs} ms -> ${next} ms`);
    this.intervalMs = next;
  }
}

/** The floor is not negotiable; the ceiling is, but must not sit below the floor. */
export function clampInterval(ms, maxMs = MAX_MS) {
  const n = Number.isFinite(ms) ? ms : DEFAULT_MS;
  return Math.min(Math.max(n, FLOOR_MS), Math.max(maxMs, FLOOR_MS));
}
