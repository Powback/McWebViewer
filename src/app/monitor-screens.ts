/**
 * Text on the monitors.
 *
 * The bake gives every monitor block a blank terminal backdrop (ber-overlays.ts). This
 * paints what a program has written over it: one canvas texture per merged panel, on a
 * plane a hair in front of the screen, sized to the panel and turned to its facing — the
 * shape of CC:T's own `MonitorBlockEntityRenderer`, which draws the terminal once across
 * the whole panel rather than per block.
 *
 * Where the text comes from is the bridge's business (monitors.mjs): the game has no read
 * path for a terminal, so the feed is whoever wrote it. This module only places and paints.
 *
 * CC:T terminal metrics, from the mod: a monitor block is 7 columns by 5 rows at text
 * scale 1, and the terminal is inset from the panel edge by RENDER_MARGIN (0.5/16 block)
 * times 1.1. A 3x4 advanced panel is therefore 21x20 characters; longer lines are clipped,
 * extra rows are dropped, and the font is monospace so columns stay columns.
 */

import * as THREE from 'three';
import type { LiveMonitor } from './live.js';

export const COLS_PER_BLOCK = 7;
export const ROWS_PER_BLOCK = 5;
/** CC:T `TileMonitor.RENDER_MARGIN * 1.1`, in blocks. */
export const SCREEN_MARGIN = (0.5 / 16) * 1.1;
/** How far in front of the block face the text plane sits: in front of the bezel, no z-fight. */
export const SCREEN_LIFT = 0.004;
/** Canvas pixels per character cell — CC's 6x9 font cell, scaled 3x for legibility. */
const CELL_W = 18;
const CELL_H = 27;

export interface Placement {
  /** world-space centre of the text plane */
  centre: [number, number, number];
  /** unit vector along the panel to the viewer's right */
  right: [number, number, number];
  /** unit normal out of the screen, toward the viewer */
  normal: [number, number, number];
  /** plane size in blocks, margins already taken off */
  w: number;
  h: number;
}

/**
 * The facing's frame. `right` is the viewer's right when looking AT the screen: a viewer
 * in front of a south-facing monitor looks north, so east is on their right.
 */
const FRAME: Record<LiveMonitor['facing'], { normal: [number, number, number]; right: [number, number, number] }> = {
  south: { normal: [0, 0, 1], right: [1, 0, 0] },
  north: { normal: [0, 0, -1], right: [-1, 0, 0] },
  east: { normal: [1, 0, 0], right: [0, 0, -1] },
  west: { normal: [-1, 0, 0], right: [0, 0, 1] },
};

/** Where a panel's text plane goes, from its top-left block, facing and size. */
export function placement(m: Pick<LiveMonitor, 'x' | 'y' | 'z' | 'facing' | 'width' | 'height'>): Placement {
  const { normal, right } = FRAME[m.facing];
  // Centre of the top-left block, then half the panel to the right and half down, then out
  // to the front face plus a lift.
  const cx = m.x + 0.5 + right[0] * (m.width - 1) / 2 + normal[0] * (0.5 + SCREEN_LIFT);
  const cy = m.y + 0.5 - (m.height - 1) / 2;
  const cz = m.z + 0.5 + right[2] * (m.width - 1) / 2 + normal[2] * (0.5 + SCREEN_LIFT);
  return {
    centre: [cx, cy, cz],
    right,
    normal,
    w: m.width - 2 * SCREEN_MARGIN,
    h: m.height - 2 * SCREEN_MARGIN,
  };
}

/** Columns and rows a panel shows at text scale 1. */
export function gridOf(
  m: Pick<LiveMonitor, 'width' | 'height'> & Partial<Pick<LiveMonitor, 'cols' | 'rows'>>,
): { cols: number; rows: number } {
  // A source that knows the terminal's real size beats one that infers it from block count
  // and an assumed text scale. See the note on `cols` in live.ts.
  if (m.cols && m.rows) return { cols: m.cols, rows: m.rows };
  return { cols: m.width * COLS_PER_BLOCK, rows: m.height * ROWS_PER_BLOCK };
}

/** The lines as they fit the grid: `rows` of them, each clipped to `cols` characters. */
export function fitLines(lines: readonly string[], cols: number, rows: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push((lines[r] ?? '').slice(0, cols));
  return out;
}

/** A stable identity for a panel: where it is and which way it looks. */
export function panelKey(m: Pick<LiveMonitor, 'x' | 'y' | 'z' | 'facing'>): string {
  return `${m.x},${m.y},${m.z},${m.facing}`;
}

interface Screen {
  mesh: THREE.Mesh;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  /** what the texture currently shows, so an unchanged feed repaints nothing */
  painted: string;
}

/** Keeps one textured plane per panel in the scene, in step with the feed. */
export class MonitorScreens {
  private screens = new Map<string, Screen>();

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.screens.size;
  }

  /** Reconcile the scene with the feed: add, repaint, move, and drop what is gone. */
  update(list: readonly LiveMonitor[]): void {
    const alive = new Set<string>();
    for (const m of list) {
      const key = panelKey(m);
      alive.add(key);
      let s = this.screens.get(key);
      if (!s) {
        s = this.create(m);
        this.screens.set(key, s);
      }
      this.place(s, m);
      this.paint(s, m);
    }
    for (const [key, s] of this.screens) {
      if (alive.has(key)) continue;
      this.dispose(s);
      this.screens.delete(key);
    }
  }

  clear(): void {
    for (const s of this.screens.values()) this.dispose(s);
    this.screens.clear();
  }

  private create(m: LiveMonitor): Screen {
    const { cols, rows } = gridOf(m);
    const canvas = document.createElement('canvas');
    canvas.width = cols * CELL_W;
    canvas.height = rows * CELL_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    // Drawn after the terrain's cutout layer so the screen wins over the bezel edge texels.
    mesh.renderOrder = 3;
    this.scene.add(mesh);
    return { mesh, texture, canvas, painted: '' };
  }

  private place(s: Screen, m: LiveMonitor): void {
    const p = placement(m);
    s.mesh.position.set(p.centre[0], p.centre[1], p.centre[2]);
    s.mesh.scale.set(p.w, p.h, 1);
    const right = new THREE.Vector3(...p.right);
    const normal = new THREE.Vector3(...p.normal);
    const up = new THREE.Vector3(0, 1, 0);
    s.mesh.setRotationFromMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
  }

  private paint(s: Screen, m: LiveMonitor): void {
    const { cols, rows } = gridOf(m);
    const lines = fitLines(m.lines, cols, rows);
    // The per-cell grids are part of the signature: a screen whose text is unchanged but
    // whose highlight moved must still repaint.
    const signature = `${m.bg}|${m.fg}|${lines.join('\n')}`
      + `|${m.fgCells?.join('') ?? ''}|${m.bgCells?.join('') ?? ''}`;
    if (signature === s.painted) return;
    const ctx = s.canvas.getContext('2d');
    if (!ctx) return;
    const cell = cellColours(m);
    ctx.fillStyle = m.bg;
    ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
    ctx.font = `bold ${Math.round(CELL_H * 0.78)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    if (cell) {
      // Backgrounds first, as whole cells, so a highlighted run reads as a band rather than
      // as coloured letters on the screen's own background.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < lines[r].length; c++) {
          const bg = cell.bg(r, c);
          if (!bg || bg === m.bg) continue;
          ctx.fillStyle = bg;
          ctx.fillRect(c * CELL_W, r * CELL_H, CELL_W, CELL_H);
        }
      }
    }
    ctx.fillStyle = m.fg;
    for (let r = 0; r < rows; r++) {
      const line = lines[r];
      for (let c = 0; c < line.length; c++) {
        if (cell) ctx.fillStyle = cell.fg(r, c) ?? m.fg;
        ctx.fillText(line[c], c * CELL_W + 1, r * CELL_H + CELL_H / 2, CELL_W);
      }
    }
    s.texture.needsUpdate = true;
    s.painted = signature;
  }

  private dispose(s: Screen): void {
    this.scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    (s.mesh.material as THREE.Material).dispose();
    s.texture.dispose();
  }
}

/**
 * Per-cell colour lookups for a monitor, or null when the source carries none.
 *
 * `palette[parseInt(digit, 16)]` and NOT `palette[15 - digit]`: the proxy has already undone
 * CC's storage order, and reversing a second time produces a screen that looks deliberately
 * inverted rather than obviously broken. A digit outside the palette, or a row shorter than
 * its line, falls back to the screen colour rather than to an arbitrary entry.
 */
export function cellColours(m: LiveMonitor): {
  fg: (r: number, c: number) => string | null;
  bg: (r: number, c: number) => string | null;
} | null {
  const pal = m.palette;
  if (!pal || pal.length === 0 || (!m.fgCells && !m.bgCells)) return null;
  const pick = (grid: readonly string[] | undefined, r: number, c: number): string | null => {
    const row = grid?.[r];
    if (!row || c >= row.length) return null;
    const i = parseInt(row[c], 16);
    return Number.isFinite(i) && i >= 0 && i < pal.length ? pal[i] : null;
  };
  return {
    fg: (r, c) => pick(m.fgCells, r, c),
    bg: (r, c) => pick(m.bgCells, r, c),
  };
}

/**
 * Whether a panel carries per-character colour.
 *
 * The test for "is this the richer description of the same panel": a source with a grid can
 * say everything a source without one can, and more.
 */
export function hasCellColour(m: LiveMonitor): boolean {
  return Boolean(m.palette?.length && (m.fgCells?.length || m.bgCells?.length));
}
