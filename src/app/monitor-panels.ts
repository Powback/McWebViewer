/**
 * Which monitor panel a computer drives — found in the world, not configured.
 *
 * The companion route for monitor text: a computer writes what it shows to a file in its
 * own save folder (`computercraft/computer/<id>/screen.json`), and the viewer paints it on
 * the panel that computer is wired to. The file has no position in it and none is
 * hardcoded here: the panel is the merged monitor touching the computer's block, read from
 * the region data the page already holds.
 *
 * A merged monitor is a run of monitor blocks sharing a `facing`, whose `state` property
 * names the sides each block has a neighbour on — CC:T's edge letters `l` `r` `u` `d`
 * (left/right/up/down as seen from the front). The top-left block is the one with no `l`
 * and no `u`; walking `r` from it gives the width, walking `d` the height. That is the
 * mod's own description of the panel, so a 1x1 (`state=none`) and a 3x4 read the same way.
 */

import { splitStateKey } from '../render/registry.js';
import type { LiveMonitor } from './live.js';

export type Facing = LiveMonitor['facing'];

/** A block-state lookup: the canonical state key at a position, or undefined for air/unknown. */
export type StateAt = (x: number, y: number, z: number) => string | undefined;

export interface Panel {
  /** top-left block as seen from the front */
  x: number;
  y: number;
  z: number;
  facing: Facing;
  width: number;
  height: number;
}

/** The viewer's right when looking AT a screen of this facing (see monitor-screens.ts FRAME). */
const RIGHT: Record<Facing, [number, number, number]> = {
  south: [1, 0, 0],
  north: [-1, 0, 0],
  east: [0, 0, -1],
  west: [0, 0, 1],
};
const FACINGS = new Set<string>(['north', 'south', 'east', 'west']);
const NEIGHBOURS: ReadonlyArray<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

interface MonitorBlock {
  facing: Facing;
  /** CC:T edge letters, e.g. `lrud`, `rd`, or `none` */
  state: string;
}

/**
 * Whether a state is a monitor block, by shape: a `facing` plus a `state` made only of the
 * edge letters (or `none`). No block name is checked — any mod's monitor that describes
 * itself this way qualifies.
 */
export function monitorAt(key: string | undefined): MonitorBlock | null {
  if (!key) return null;
  const { props } = splitStateKey(key);
  const facing = props.facing;
  const state = props.state;
  if (!facing || !FACINGS.has(facing) || state === undefined) return null;
  if (state !== 'none' && !/^[lrud]{1,4}$/.test(state)) return null;
  return { facing: facing as Facing, state };
}

/** The panel that includes the monitor block at (x, y, z), or null if there is none. */
export function panelAt(at: StateAt, x: number, y: number, z: number): Panel | null {
  const m = monitorAt(at(x, y, z));
  if (!m) return null;
  const r = RIGHT[m.facing];
  const same = (px: number, py: number, pz: number): MonitorBlock | null => {
    const n = monitorAt(at(px, py, pz));
    return n && n.facing === m.facing ? n : null;
  };
  // To the top-left: left while the block says it has a left neighbour, then up likewise.
  const left = walk(same, [x, y, z], [-r[0], 0, -r[2]], 'l');
  const top = walk(same, left, [0, 1, 0], 'u');
  if (!same(top[0], top[1], top[2])) return null;
  // Then the extent: right along the viewer's right, down along -y, following the letters.
  const width = 1 + steps(walk(same, top, [r[0], 0, r[2]], 'r'), top);
  const height = 1 + steps(walk(same, top, [0, -1, 0], 'd'), top);
  return { x: top[0], y: top[1], z: top[2], facing: m.facing, width, height };
}

type P3 = [number, number, number];

/** Follow `letter` from `from` one block at a time along `dir` while the blocks claim a neighbour there. */
function walk(same: (x: number, y: number, z: number) => MonitorBlock | null, from: P3, dir: P3, letter: string): P3 {
  let [x, y, z] = from;
  for (let i = 0; i < 64; i++) {
    const b = same(x, y, z);
    if (!b || !b.state.includes(letter)) break;
    const next: P3 = [x + dir[0], y + dir[1], z + dir[2]];
    if (!same(next[0], next[1], next[2])) break;
    [x, y, z] = next;
  }
  return [x, y, z];
}

function steps(a: P3, b: P3): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** The panel touching a computer's block (any of its six faces), or null. */
export function panelForComputer(at: StateAt, x: number, y: number, z: number): Panel | null {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const p = panelAt(at, x + dx, y + dy, z + dz);
    if (p) return p;
  }
  return null;
}
