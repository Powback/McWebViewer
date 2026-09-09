/**
 * Monitor screen contents, for the viewer to paint onto its monitor blocks.
 *
 * WHY THIS IS A POLL OF A SERVICE AND NOT A READ OF THE WORLD. A ComputerCraft monitor's
 * block entity saves its size and its index in the merged panel — and nothing else. The
 * terminal (the characters on it) lives only in server memory and is streamed to game
 * clients over the mod's own network channel; `computercraft` has no command that reads it
 * and the region files never contain it. So the only sources are (a) a real Minecraft
 * client on the mod's channel, or (b) whoever WROTE the text. HiveMind HQ writes it, and
 * exposes what it wrote at `GET <MCWV_MONITORS_URL>` as
 *
 *   { "monitors": [ { "x", "y", "z",            top-left monitor block, as seen facing the screen
 *                     "facing": "south",        which way the screen looks
 *                     "width", "height",        in blocks
 *                     "label", "lines": [..],   terminal rows, top first
 *                     "bg": "#111111", "fg": "#f0f0f0",
 *                     "updated": <epoch ms> } ] }
 *
 * The source is a URL, not HQ specifically: point MCWV_MONITORS_URL at anything that
 * answers in this shape. Until the endpoint exists (404, refused, malformed) the poll is a
 * logged miss and the screens stay blank — an absent feed is never an error on screen.
 *
 * Same discipline as hq.mjs: one short-timeout GET per tick, never throws, last good list
 * retained across a miss, nothing written anywhere.
 */

export const MONITORS_DEFAULT_MS = 2000;
export const MONITORS_FLOOR_MS = 500;
export const MONITORS_TIMEOUT_MS = 1500;

const FACINGS = new Set(['north', 'south', 'east', 'west']);

function int(v) {
  return Number.isInteger(v) ? v : null;
}

/**
 * One monitor record, checked field by field; null if it cannot be drawn. Lines are
 * coerced to strings and capped so a runaway payload cannot become a runaway texture.
 */
export function parseMonitor(m) {
  if (!m || typeof m !== 'object') return null;
  const pos = parsePosition(m);
  const size = parseSize(m);
  if (!pos || !size || !FACINGS.has(m.facing)) return null;
  return {
    ...pos,
    ...size,
    facing: m.facing,
    label: typeof m.label === 'string' ? m.label : null,
    lines: parseLines(m.lines, size.height),
    bg: typeof m.bg === 'string' ? m.bg : '#111111',
    fg: typeof m.fg === 'string' ? m.fg : '#f0f0f0',
    updated: Number.isFinite(m.updated) ? m.updated : 0,
  };
}

function parsePosition(m) {
  const x = int(m.x), y = int(m.y), z = int(m.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

/** 1..64 blocks a side: anything larger is not a monitor the game can build. */
function parseSize(m) {
  const width = int(m.width), height = int(m.height);
  if (!width || !height || width < 1 || height < 1 || width > 64 || height > 64) return null;
  return { width, height };
}

/** Lines as strings, capped so a runaway payload cannot become a runaway texture. */
function parseLines(lines, height) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, height * 5 * 2).map((l) => String(l ?? ''));
}

/** The whole payload -> drawable records; unknown shapes yield an empty list, never a throw. */
export function parseMonitors(json) {
  const arr = json?.monitors ?? json?.data?.monitors;
  if (!Array.isArray(arr)) return [];
  return arr.map(parseMonitor).filter(Boolean);
}

/** Option objects arrive with `undefined` for unset env — those must not shadow defaults. */
function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export class MonitorsPoller {
  #running = false;

  /**
   * @param {object} opts
   * @param {string}  [opts.url]        the endpoint; empty disables
   * @param {number}  [opts.intervalMs] cadence; 0/NaN disables; floored
   * @param {(msg: object) => void} opts.emit
   * @param {typeof fetch} [opts.fetch]
   * @param {(msg: string) => void} [opts.log]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   */
  constructor(opts) {
    const o = {
      intervalMs: MONITORS_DEFAULT_MS, url: '', timeoutMs: MONITORS_TIMEOUT_MS, fetch: globalThis.fetch,
      log: () => {}, sleep: (t) => new Promise((r) => setTimeout(r, t)), ...stripUndefined(opts),
    };
    const ms = Number(o.intervalMs);
    this.url = String(o.url).trim();
    this.enabled = !!this.url && Number.isFinite(ms) && ms > 0;
    this.intervalMs = Math.max(MONITORS_FLOOR_MS, ms || 0);
    this.timeoutMs = o.timeoutMs;
    this.emit = o.emit;
    this.fetch = o.fetch;
    this.log = o.log;
    this.sleep = o.sleep;
    /** the last good list, retained across misses */
    this.list = [];
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
      count: this.list.length,
      failures: this.failures,
    };
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

  /** One read. Emits the list on success (every tick, so a fresh viewer catches up in one). */
  async once() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.list = parseMonitors(await res.json());
      this.polls++;
      this.#recovered();
      this.available = true;
      this.emit({ t: 'monitors', list: this.list });
    } catch (e) {
      this.#failed(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  #failed(message) {
    this.failures++;
    if (this.available === null) this.available = false;
    if (this.failures === 1 || this.failures % 30 === 0) {
      this.log(`monitor feed miss (${this.failures} in a row): ${message} — screens stay as they were`);
    }
  }

  #recovered() {
    if (!this.failures) return;
    this.log(`monitor feed recovered after ${this.failures} miss(es)`);
    this.failures = 0;
  }
}
