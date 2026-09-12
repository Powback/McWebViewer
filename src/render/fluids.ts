/**
 * Fluid geometry: water and lava, generated rather than modelled.
 *
 * Every fluid state in the game carries `quads: []` — a fluid's model JSON has no
 * `elements`, because vanilla draws fluids in `LiquidBlockRenderer` from code. The viewer
 * honoured the empty model literally, so oceans, rivers and lava lakes rendered as holes.
 *
 * THE HEIGHTS ARE MEASURED, NOT REMEMBERED. `FluidState.getOwnHeight()` was read out of the
 * real game for all 9,246 states that carry a fluid, and the rule below reproduces every one
 * of the 32 pure water/lava states exactly (0 mismatches):
 *
 *     amount = level < 8 ? 8 - level : 8        height = amount / 9
 *
 * That measurement corrected something worth stating: `level` 8..15 is **falling** fluid,
 * which stands at FULL height — not, as the numbering suggests, progressively lower than
 * level 7. Writing the obvious formula from the property name would have made every
 * waterfall a thin sliver.
 *
 * WHY THE CORNERS ARE AVERAGED. A fluid cell's top is not flat: each corner is the mean of
 * the fluid heights of the four cells meeting at it. That is what makes a shoreline slope
 * away instead of terracing into steps, and it is the single most visible difference
 * between "there is water here" and water that looks right.
 */

import type { BakedQuad, Direction } from '../assets/model.js';

export type FluidKind = 'water' | 'lava';

export interface FluidCell {
  kind: FluidKind;
  /** 0..1, the fluid's own surface height in this cell */
  height: number;
  /** falling fluid stands full height and pours down every side */
  falling: boolean;
}

/**
 * Does this state hold a fluid at all? The mesher's cheap gate — most blocks answer no in a
 * couple of string compares, and only the ones that answer yes pay for a neighbour walk.
 */
export function holdsFluid(name: string, props: Record<string, string>): boolean {
  return fluidKind(name) !== null || props.waterlogged === 'true' || ALWAYS_FLOODED.has(name);
}

/** Vanilla divides the cell into ninths; a source stands 8 of them tall. */
const NINTH = 1 / 9;

/**
 * The fluid a block state carries, or null.
 *
 * Reads the state's own `level`, so it works for `water`, `flowing_water`, `lava` and
 * `flowing_lava` alike — and for a WATERLOGGED block, which carries full-height water
 * inside a solid model. 9,182 of the game's states are waterlogged ones; treating only the
 * five pure fluid blocks as fluid leaves every flooded stair and fence dry.
 */
export function fluidOf(name: string, props: Record<string, string>): FluidCell | null {
  const kind = fluidKind(name);
  if (kind) {
    const level = Number(props.level ?? '0');
    const falling = Number.isFinite(level) && level >= 8;
    const amount = !Number.isFinite(level) || level >= 8 ? 8 : 8 - level;
    return { kind, height: amount * NINTH, falling };
  }
  if (props.waterlogged === 'true') {
    return { kind: 'water', height: 8 * NINTH, falling: false };
  }
  const always = ALWAYS_FLOODED.get(name);
  if (always) return { kind: always, height: 8 * NINTH, falling: false };
  return null;
}

/**
 * Blocks that hold a fluid with NEITHER a `level` nor a `waterlogged` property.
 *
 * Kelp and seagrass are the cases that matter: they are always in water, they say so
 * nowhere in their block state, and without this every kelp forest is a column of holes
 * punched through the ocean.
 *
 * DERIVED, NOT GUESSED. This is exactly the set of blocks in `physics.json` that carry a
 * fluid and are neither a fluid block nor waterlogged — read off the real game's
 * `BlockState.getFluidState()` for all 26,684 states. `fluids.test.ts` re-derives it from
 * that file on every run, so adding a mod with such a block fails the test rather than
 * quietly rendering a hole. Measured on this 130-mod pack: every fluid in the game is
 * vanilla water or lava; no mod adds a placeable fluid block.
 */
const ALWAYS_FLOODED = new Map<string, FluidKind>([
  ['minecraft:seagrass', 'water'],
  ['minecraft:tall_seagrass', 'water'],
  ['minecraft:kelp', 'water'],
  ['minecraft:kelp_plant', 'water'],
]);

function fluidKind(name: string): FluidKind | null {
  if (name === 'minecraft:water' || name === 'minecraft:flowing_water') return 'water';
  if (name === 'minecraft:lava' || name === 'minecraft:flowing_lava') return 'lava';
  // A bubble column is water with an effect on top of it; it must still draw as water or
  // the ocean has a hole where every column is.
  if (name === 'minecraft:bubble_column') return 'water';
  return null;
}

/** What the mesher must tell us about the eight cells around this one. */
export interface FluidNeighbours {
  /** the same fluid directly above, which makes the top flat and full */
  above: boolean;
  /**
   * Fluid height of each of the 8 surrounding cells, or null where there is no fluid of
   * the same kind. Indexed by (dx+1)*3 + (dz+1), centre included and ignored.
   */
  around: Array<number | null>;
}

/**
 * The four corner heights of the top face, in the order (-x,-z) (-x,+z) (+x,+z) (+x,-z).
 *
 * Each corner averages the cells that touch it. A cell with the same fluid ABOVE is full
 * height everywhere — a column of water has a flat top, not a dimpled one.
 */
export function cornerHeights(cell: FluidCell, n: FluidNeighbours): [number, number, number, number] {
  if (n.above || cell.falling) return [1, 1, 1, 1];
  const at = (dx: number, dz: number): number | null => n.around[(dx + 1) * 3 + (dz + 1)];
  const corner = (dx: number, dz: number): number => {
    let sum = cell.height;
    let count = 1;
    for (const [ox, oz] of [[dx, 0], [0, dz], [dx, dz]] as const) {
      const h = at(ox, oz);
      if (h === null || h === undefined) continue;
      // A neighbour that is a SOURCE (full) pulls the corner all the way up, as vanilla does.
      if (h >= 1) return 1;
      sum += h;
      count++;
    }
    return sum / count;
  };
  return [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
}

export interface FluidSprites {
  /** `minecraft:block/water_still` etc. — the animated surface */
  still: string;
  /** `minecraft:block/water_flow` — used on the sides */
  flow: string;
}

export function spritesFor(kind: FluidKind): FluidSprites {
  return kind === 'water'
    ? { still: 'minecraft:block/water_still', flow: 'minecraft:block/water_flow' }
    : { still: 'minecraft:block/lava_still', flow: 'minecraft:block/lava_flow' };
}

/** Which faces to draw. The mesher decides these from the neighbours it can see. */
export interface FluidFaces {
  up: boolean;
  down: boolean;
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
}

const SIDE_DIRS: Array<{ dir: Direction; dx: number; dz: number }> = [
  { dir: 'north', dx: 0, dz: -1 },
  { dir: 'south', dx: 0, dz: 1 },
  { dir: 'west', dx: -1, dz: 0 },
  { dir: 'east', dx: 1, dz: 0 },
];

/**
 * Build the quads for one fluid cell, in BLOCK-LOCAL space (0..1).
 *
 * Positions are emitted in the same corner order the block mesher uses, and the winding is
 * fixed downstream by the geometry-derived rule — the same one that serves terrain,
 * contraptions and turtle lids — so there is no separate winding convention to get wrong
 * here.
 *
 * `tintindex` is 0 on water so the existing biome-tint path colours it, and -1 on lava,
 * which vanilla never tints. Lava is also emitted fullbright: it is its own light source
 * and shading it like stone makes a lava lake look like grey rock.
 */
export function fluidQuads(
  cell: FluidCell,
  corners: readonly [number, number, number, number],
  faces: FluidFaces,
  sprites: FluidSprites = spritesFor(cell.kind),
): BakedQuad[] {
  const out: BakedQuad[] = [];
  const [hnn, hnp, hpp, hpn] = corners;
  const tint = cell.kind === 'water' ? 0 : -1;
  const shade = cell.kind === 'lava' ? false : true;

  if (faces.up) {
    out.push(quad(
      [0, hnn, 0, 0, hnp, 1, 1, hpp, 1, 1, hpn, 0],
      [0, 0, 0, 16, 16, 16, 16, 0],
      sprites.still, 'up', tint, shade, 'up',
    ));
  }
  if (faces.down) {
    out.push(quad(
      [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1],
      [0, 0, 0, 16, 16, 16, 16, 0],
      sprites.still, 'down', tint, shade, 'down',
    ));
  }

  for (const s of SIDE_DIRS) {
    if (!faces[s.dir as keyof FluidFaces]) continue;
    // The two corners of this face, and the heights that belong to them.
    const [ax, az, bx, bz, ha, hb] = faceEdge(s.dx, s.dz, corners);
    // v is measured DOWN from the top of the block, so a lower corner has a taller quad.
    const va = (1 - ha) * 16;
    const vb = (1 - hb) * 16;
    out.push(quad(
      [ax, ha, az, ax, 0, az, bx, 0, bz, bx, hb, bz],
      [0, va, 0, 16, 16, 16, 16, vb],
      sprites.flow, s.dir, tint, shade, s.dir,
    ));
  }
  return out;
}

/** The two horizontal corners of a side face, with the corner heights that go with them. */
function faceEdge(
  dx: number, dz: number, c: readonly [number, number, number, number],
): [number, number, number, number, number, number] {
  const [hnn, hnp, hpp, hpn] = c;
  if (dz === -1) return [1, 0, 0, 0, hpn, hnn]; // north: +x -> -x along z=0
  if (dz === 1) return [0, 1, 1, 1, hnp, hpp]; // south
  if (dx === -1) return [0, 0, 0, 1, hnn, hnp]; // west
  return [1, 1, 1, 0, hpp, hpn]; // east
}

function quad(
  positions: number[],
  uvs: number[],
  texture: string,
  facing: Direction,
  tintIndex: number,
  shade: boolean,
  cullface: Direction | null,
): BakedQuad {
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs.map((v) => v / 16)),
    normal: NORMALS[facing],
    texture,
    facing,
    cullface,
    tintIndex,
    shade,
  };
}

const NORMALS: Record<Direction, [number, number, number]> = {
  up: [0, 1, 0], down: [0, -1, 0],
  north: [0, 0, -1], south: [0, 0, 1],
  west: [-1, 0, 0], east: [1, 0, 0],
};
