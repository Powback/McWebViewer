/**
 * The settlement brain, as a label source for the live turtles.
 *
 * `computercraft dump` (computers.mjs) says WHERE every turtle is; it does not say what any
 * of them is DOING. HQ does: it is the fleet's own controller, and its `fleet.status` tool
 * reports each drone's name and a free-text line — "searching 6 chest(s) for stone_bricks",
 * "fetching wood", "depositing" — keyed by the ComputerCraft computer id, which is exactly
 * the id the turtle tracker already keys on. So this polls HQ once a second, in PARALLEL
 * with the dump, and hands the turtle emit a `id -> { name, detail }` map to fold in.
 *
 * WHY THE BRIDGE AND NOT THE BROWSER. HQ lives on the Minecraft compose network as
 * `http://hq:4400`; the browser cannot reach it and would hit CORS if it could. The bridge
 * is already on that network for RCON, so the call is a plain server-side fetch.
 *
 * DISCIPLINE, the same as every other poll here:
 *   - one HTTP call per tick, with a SHORT timeout (a slow brain must not slow the fleet
 *     view), and it NEVER throws — a rejected fetch is a logged miss, not a crash;
 *   - LAST-KNOWN LABELS ARE RETAINED across a miss, so a blip does not blank every tag; the
 *     turtle stream is never blocked on HQ, it just carries slightly older words that tick;
 *   - it writes nothing anywhere and reads one endpoint. HQ is the source of truth; this is
 *     a read of it.
 *
 * The label text itself is chosen here, once, so the browser receives a finished string:
 * `detail` (the drone's own words) if present, else `reported`, else `doing`, else `status`.
 */

export const HQ_DEFAULT_URL = 'http://hq:4400';
export const HQ_DEFAULT_MS = 1000;
export const HQ_FLOOR_MS = 500;
/** A brain slower than this is skipped THIS tick; the turtle view keeps the last labels. */
export const HQ_TIMEOUT_MS = 800;

/**
 * The line to show for one drone: its own words first, the controller's next.
 *
 * `detail`/`reported` come from `fleet.status`; `doing` from `/brief`; `status` from both.
 * All four are handled so the pick is correct whichever endpoint fed it, and an empty or
 * non-string field is skipped rather than shown as blank.
 */
export function pickDetail(drone) {
  for (const field of ['detail', 'reported', 'doing', 'status']) {
    const v = drone?.[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The drone array out of either endpoint's envelope: `{ok,data:{drones}}` or `{fleet:{drones}}`. */
export function dronesOf(json) {
  const d = json?.data?.drones ?? json?.fleet?.drones ?? json?.drones;
  return Array.isArray(d) ? d : [];
}

/**
 * `fleet.status` JSON -> Map<id, { name, status, detail }>.
 *
 * Only drones with an integer id are kept — the id is the join key, and a record without one
 * cannot be matched to a turtle. Everything else fails soft: a missing name is null, a
 * missing detail is null, and a payload of the wrong shape yields an empty map, never a throw.
 */
export function parseFleet(json) {
  const out = new Map();
  for (const d of dronesOf(json)) {
    const id = Number(d?.id);
    if (!Number.isInteger(id)) continue;
    out.set(id, {
      name: typeof d.name === 'string' && d.name ? d.name : null,
      status: typeof d.status === 'string' ? d.status : null,
      detail: pickDetail(d),
    });
  }
  return out;
}

/** Enabled unless the cadence is 0/NaN; when enabled, floored so a config typo cannot spam HQ. */
function resolveInterval(raw) {
  const ms = Number(raw ?? HQ_DEFAULT_MS);
  const enabled = Number.isFinite(ms) && ms > 0;
  return { enabled, intervalMs: enabled ? Math.max(HQ_FLOOR_MS, ms) : 0 };
}

export class HqPoller {
  #running = false;

  /**
   * @param {object} opts
   * @param {number}  [opts.intervalMs] poll cadence; 0/NaN disables; floored at HQ_FLOOR_MS
   * @param {string}  [opts.url]        HQ base, default http://hq:4400
   * @param {number}  [opts.timeoutMs]  per-call timeout
   * @param {typeof fetch} [opts.fetch] injected for tests
   * @param {(msg: string) => void} [opts.log]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   */
  constructor(opts = {}) {
    const { enabled, intervalMs } = resolveInterval(opts.intervalMs);
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.url = (opts.url ?? HQ_DEFAULT_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? HQ_TIMEOUT_MS;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});
    this.sleep = opts.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
    /** id -> { name, status, detail }; the last good read, retained across misses. */
    this.labels = new Map();
    this.available = this.enabled ? null : false;
    this.failures = 0;
    this.polls = 0;
  }

  get running() {
    return this.#running;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      intervalMs: this.intervalMs,
      count: this.labels.size,
      failures: this.failures,
    };
  }

  /** What to fold into a turtle row: name and the finished label line, or null if unknown. */
  labelFor(id) {
    const l = this.labels.get(id);
    return l ? { name: l.name, label: l.detail } : null;
  }

  async loop(shouldRun) {
    if (this.#running || !this.enabled) return;
    this.#running = true;
    try {
      while (shouldRun()) {
        await this.once();
        await this.sleep(this.intervalMs);
      }
    } finally {
      this.#running = false;
    }
  }

  /** One read. Replaces the label map on success; on any failure keeps the last one. */
  async once() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.url}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'fleet.status', args: {} }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const map = parseFleet(await res.json());
      this.labels = map;
      this.polls++;
      this.#recovered();
      this.available = true;
    } catch (e) {
      this.#failed(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Logged, never streamed to the browser: a missing label is not a fault the viewer can act on. */
  #failed(message) {
    this.failures++;
    if (this.available === null) this.available = false;
    if (this.failures === 1 || this.failures % 30 === 0) {
      this.log(`HQ label poll miss (${this.failures} in a row): ${message} — keeping the last labels`);
    }
  }

  #recovered() {
    if (!this.failures) return;
    this.log(`HQ label poll recovered after ${this.failures} miss(es)`);
    this.failures = 0;
  }
}
