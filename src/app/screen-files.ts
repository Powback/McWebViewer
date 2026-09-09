/**
 * Monitor text from the computers' own save folders.
 *
 * A ComputerCraft computer's files live in the world save at
 * `computercraft/computer/<id>/`. A program that drives a monitor also writes what it shows
 * to `screen.json` there — `{ label, lines[], updated, bg?, fg? }` — and this reads it. It
 * is the companion route to monitor text: the game offers no read path for a terminal, and
 * a real client on the mod's channel was judged not worth it (see the bridge's monitors.mjs
 * for the why). The world directory is already served read-only next to the region files,
 * so the page fetches the files itself, one small GET per driving computer every few
 * seconds, and hands the result to the same renderer the bridge feed uses.
 *
 * Which computers to read, and where their text goes, is not configured: every computer the
 * region data knows (`ComputerRegistry`) is tried, and the text is painted on the monitor
 * panel touching that computer's block (monitor-panels.ts). A computer with no adjacent
 * panel, or no file, contributes nothing. A file that fails to parse is skipped, not thrown.
 */

import type { LiveMonitor } from './live.js';
import { panelForComputer, type StateAt } from './monitor-panels.js';

export interface ScreenFile {
  label?: unknown;
  lines?: unknown;
  updated?: unknown;
  bg?: unknown;
  fg?: unknown;
}

export const SCREEN_FILE_BASE = '/dev/computercraft/computer';
export const SCREEN_POLL_MS = 2000;

/** One file's contents as a monitor record on the given panel; null if the file is unusable. */
export function screenToMonitor(
  file: ScreenFile | null,
  panel: ReturnType<typeof panelForComputer>,
): LiveMonitor | null {
  if (!file || !panel || !Array.isArray(file.lines)) return null;
  return {
    x: panel.x, y: panel.y, z: panel.z, facing: panel.facing,
    width: panel.width, height: panel.height,
    label: typeof file.label === 'string' ? file.label : null,
    lines: file.lines.slice(0, panel.height * 5 * 2).map((l) => String(l ?? '')),
    bg: typeof file.bg === 'string' ? file.bg : '#111111',
    fg: typeof file.fg === 'string' ? file.fg : '#f0f0f0',
    updated: typeof file.updated === 'number' ? file.updated : 0,
  };
}

export interface ComputerSite {
  id: number;
  pos: [number, number, number];
}

/**
 * Polls `screen.json` for every known computer and reports the panels that have text.
 * `fetchJson` is injected so the polling can be exercised without a network.
 */
export class ScreenFiles {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** ids whose fetch returned 404: retried every so often, not every tick */
  private absent = new Map<number, number>();

  constructor(
    private deps: {
      computers: () => Iterable<ComputerSite>;
      stateAt: StateAt;
      onMonitors: (list: LiveMonitor[]) => void;
      fetchJson?: (url: string) => Promise<ScreenFile | null>;
      base?: string;
    },
  ) {}

  start(intervalMs = SCREEN_POLL_MS): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round: read every driving computer's file and report what is on its panel. */
  async tick(): Promise<LiveMonitor[]> {
    const now = Date.now();
    const out: LiveMonitor[] = [];
    for (const c of this.deps.computers()) {
      const panel = panelForComputer(this.deps.stateAt, c.pos[0], c.pos[1], c.pos[2]);
      if (!panel) continue;
      const retryAt = this.absent.get(c.id);
      if (retryAt !== undefined && now < retryAt) continue;
      const file = await this.read(c.id);
      if (!file) {
        // No file yet: ask again in a while, not every two seconds for every computer.
        this.absent.set(c.id, now + 30_000);
        continue;
      }
      this.absent.delete(c.id);
      const m = screenToMonitor(file, panel);
      if (m) out.push(m);
    }
    this.deps.onMonitors(out);
    return out;
  }

  private async read(id: number): Promise<ScreenFile | null> {
    const url = `${this.deps.base ?? SCREEN_FILE_BASE}/${id}/screen.json`;
    if (this.deps.fetchJson) return this.deps.fetchJson(url);
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as ScreenFile;
    } catch {
      return null;
    }
  }
}
