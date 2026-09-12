/**
 * Monitor screens from SpacetimeDB.
 *
 * The bridge reads a computer's `screen.json` — which contains `lines`, a label and nothing
 * else — and finds the panel by walking the monitor blocks around the computer. SpacetimeDB
 * mirrors the terminal itself: one row per panel, keyed on its origin block, carrying the
 * text AND a per-character colour grid AND the panel's own position and size.
 *
 * WHY THE CONSUMER WAS WIDENED RATHER THAN THIS FLATTENED. `LiveMonitor` used to carry one
 * `fg`/`bg` for a whole screen, because that was all the bridge could ever supply. Measured:
 * a real `computercraft/computer/<id>/screen.json` on the live server has keys
 * `['id','lines','updated','label']` — **no colour data of any kind**. So the per-cell grid
 * is the entire difference between the two sources for monitors, and flattening it would
 * make this path exactly equal to the one it is meant to improve on.
 *
 * THE NUMBER I COULD NOT GET. The intended measurement was "what fraction of cells on the 7
 * live panels differ from the default pair". The mirror reachable from here is the seed-7
 * DEV replica — 3 block entities, no ComputerCraft at all, `monitor` empty — and the live
 * mirror is not reachable without pointing a bot at the production server, which is not mine
 * to do. The argument above does not depend on that fraction, but the fraction is still worth
 * taking when someone can: it would say how much of a screen is highlight rather than body.
 *
 * TWO THINGS THE PROXY HAS ALREADY DONE, WHICH MUST NOT BE DONE AGAIN:
 *
 * - **The palette is un-reversed.** CC stores entries in `Colour.values()` order while a
 *   cell's digit is the Lua index, and the mod renders `palette[15 - digit]`. The proxy
 *   undoes it, so indexing directly is correct; reversing again yields black-on-white from a
 *   white-on-black screen, which looks deliberate rather than broken.
 * - **`block_width`/`block_height` are 0 until the block entity has been seen**, because they
 *   come from the BE rather than the screen payload — text scale is not on the wire. Zero
 *   means NOT YET KNOWN, and a panel with no size is skipped rather than drawn at zero size.
 *   Verified against the live mirror: the normal path reports 3x4 and 3x5, and 0 does occur.
 *
 * THE CLEAR COLOUR IS THE MODE, NOT THE TOP-LEFT CELL — and this is a correction. The first
 * version took cell (0,0) as the screen's own pair, reasoning that CC clears to the current
 * colours so the corner is the background everywhere nothing was written. Measured against
 * the live MapServer panel, that is wrong: its top-left cell is digit `4`, because the first
 * thing written to the screen is a YELLOW TITLE. Taking the corner made the whole-screen
 * fallback yellow, and it skewed the usage measurement badly — reporting 99.6% of cells as
 * "differing" when the truth is that 13 cells are yellow and 2,951 are white.
 *
 * The most common digit is the right answer instead: on a scrolling log the body colour
 * dominates by construction, and a title or a highlight cannot outvote it.
 *
 * THE ROW'S `y` IS THE BOTTOM OF THE PANEL, and `LiveMonitor.y` is the TOP — a second
 * assumption that did not survive contact. Proven from the data rather than from a
 * screenshot: three panels share the wall at x=71, z=33, at y 67 (3x1), 68 (1x1) and 69
 * (3x2). Read as top-origin the 3x2 would occupy y 68..69 and collide with the 1x1, which
 * real blocks cannot do; read as bottom-origin they stack exactly. Untranslated, every panel
 * hung a full panel-height too low and its text appeared to sit at the bottom of an empty
 * wall.
 */

import type { LiveMonitor } from './live.js';

/** One `monitor` row, as the module stores it. */
export interface MonitorRow {
  x: number;
  y: number;
  z: number;
  facing: string;
  blockWidth: number;
  blockHeight: number;
  termWidth: number;
  termHeight: number;
  hasScreen: boolean;
  lines: readonly string[];
  fg: readonly string[];
  bg: readonly string[];
  palette: readonly string[];
  updatedAt?: number | bigint;
}

const FACINGS = new Set(['north', 'south', 'east', 'west']);

/** The screen's own colours, for the areas no cell overrides. */
const DEFAULT_BG = '#000000';
const DEFAULT_FG = '#ffffff';

/**
 * One row to one panel, or null when it cannot yet be drawn.
 *
 * Null rather than a placeholder: a panel whose size the mirror has not learned would be
 * drawn at zero size, which is a hard-to-diagnose nothing rather than an obvious absence.
 */
export function toMonitor(row: MonitorRow): LiveMonitor | null {
  if (!row.hasScreen) return null;
  if (!FACINGS.has(row.facing)) return null;
  // 0 means the block entity has not been seen yet — not a zero-sized panel.
  if (!(row.blockWidth > 0) || !(row.blockHeight > 0)) return null;
  if (![row.x, row.y, row.z].every(Number.isFinite)) return null;

  const palette = row.palette?.length === 16 ? [...row.palette] : undefined;
  const bg = palette ? paletteAt(palette, modeDigit(row.bg)) ?? DEFAULT_BG : DEFAULT_BG;
  const fg = palette ? paletteAt(palette, modeDigit(row.fg)) ?? DEFAULT_FG : DEFAULT_FG;

  return {
    x: row.x,
    // Bottom-origin to top-origin; see the header.
    y: row.y + row.blockHeight - 1,
    z: row.z,
    facing: row.facing as LiveMonitor['facing'],
    width: row.blockWidth,
    height: row.blockHeight,
    label: null,
    lines: [...(row.lines ?? [])],
    bg,
    fg,
    fgCells: row.fg?.length ? [...row.fg] : undefined,
    bgCells: row.bg?.length ? [...row.bg] : undefined,
    palette,
    // The terminal's real size, which only the protocol knows — see live.ts.
    cols: row.termWidth > 0 ? row.termWidth : undefined,
    rows: row.termHeight > 0 ? row.termHeight : undefined,
    updated: Number(row.updatedAt ?? 0),
  };
}

/**
 * The most common digit in a colour grid — the screen's own colour.
 *
 * See the header for why this is not cell (0,0). On a scrolling log the body colour is the
 * overwhelming majority and a title cannot outvote it; on a blank screen every cell agrees.
 */
export function modeDigit(grid: readonly string[] | undefined): string | undefined {
  if (!grid?.length) return undefined;
  const counts = new Map<string, number>();
  for (const row of grid) {
    for (const ch of row) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [ch, n] of counts) {
    if (n > bestN) { best = ch; bestN = n; }
  }
  return best;
}

/** `palette[parseInt(digit, 16)]` — already un-reversed by the proxy. See the header. */
export function paletteAt(palette: readonly string[], digit: string | undefined): string | null {
  if (!digit) return null;
  const i = parseInt(digit, 16);
  return Number.isFinite(i) && i >= 0 && i < palette.length ? palette[i] : null;
}

/** Every drawable panel from a set of rows, in a stable order. */
export function toMonitors(rows: Iterable<MonitorRow>): LiveMonitor[] {
  const out: LiveMonitor[] = [];
  for (const r of rows) {
    const m = toMonitor(r);
    if (m) out.push(m);
  }
  out.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  return out;
}

/**
 * How much of a screen is coloured differently from its own default pair.
 *
 * The measurement that could not be taken here, as a function so it can be taken the moment
 * a live mirror is reachable — by the HUD, a test, or a one-liner.
 */
export function cellColourUsage(rows: Iterable<MonitorRow>): {
  cells: number; fgDiffering: number; bgDiffering: number;
} {
  let cells = 0;
  let fgDiffering = 0;
  let bgDiffering = 0;
  for (const r of rows) {
    // The screen's OWN colour, not its corner — see modeDigit. Using the corner reported a
    // yellow-titled log as 99.6% non-default when the truth is 0.4%.
    const baseFg = modeDigit(r.fg);
    const baseBg = modeDigit(r.bg);
    for (let i = 0; i < (r.lines?.length ?? 0); i++) {
      const line = r.lines[i];
      for (let c = 0; c < line.length; c++) {
        cells++;
        if (r.fg?.[i]?.[c] !== undefined && r.fg[i][c] !== baseFg) fgDiffering++;
        if (r.bg?.[i]?.[c] !== undefined && r.bg[i][c] !== baseBg) bgDiffering++;
      }
    }
  }
  return { cells, fgDiffering, bgDiffering };
}
