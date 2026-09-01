/**
 * Voxel raycast (Amanatides & Woo), shared by every path that has to ask "which block is
 * under this direction".
 *
 * Extracted because there are now two callers with genuinely different origins and they
 * must agree: the first-person crosshair casts from the eye along the look angles, and the
 * isometric view casts from a camera 40 blocks up along whatever direction a tap
 * unprojected to. Two copies of a DDA is two chances to be off by one block, and "dig
 * targeted the wrong block" is exactly the class of bug this project keeps paying for.
 */

/** Just enough of `World` to walk it — so tests need a map, not a world. */
export interface VoxelSource {
  getState(x: number, y: number, z: number): number;
}

export interface VoxelHit {
  /** integer block coordinates of the first non-air cell */
  block: [number, number, number];
  /** unit normal of the face the ray entered through, for placing against it */
  face: [number, number, number];
}

/**
 * March until a non-air block or `maxDist` blocks, whichever comes first.
 *
 * `face` is the face the ray ENTERED the hit cell through, which is the previous step's
 * axis — not the current one. It seeds to +Y so that a ray starting inside a solid block
 * (standing in gravel) reports a face that can still be placed against.
 */
export function voxelCast(
  world: VoxelSource,
  origin: { x: number; y: number; z: number },
  dir: readonly [number, number, number],
  maxDist = 5,
): VoxelHit | null {
  const cell = [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)];
  const step = dir.map(Math.sign);
  const tDelta = dir.map((d) => Math.abs(1 / d));
  const tMax = [
    boundary(origin.x, dir[0]),
    boundary(origin.y, dir[1]),
    boundary(origin.z, dir[2]),
  ];
  let face: [number, number, number] = [0, 1, 0];

  // A DDA crosses at most three cell boundaries per block travelled, so this bound is
  // reached only by a ray that is exactly axis-aligned and never terminates.
  for (let i = 0; i < maxDist * 4; i++) {
    if (world.getState(cell[0], cell[1], cell[2]) !== 0) {
      return { block: [cell[0], cell[1], cell[2]], face };
    }
    const axis = tMax[0] < tMax[1] && tMax[0] < tMax[2] ? 0 : tMax[1] < tMax[2] ? 1 : 2;
    cell[axis] += step[axis];
    tMax[axis] += tDelta[axis];
    face = [0, 0, 0];
    face[axis] = -step[axis];
    if (Math.min(tMax[0], tMax[1], tMax[2]) > maxDist) break;
  }
  return null;
}

/** Distance along the ray to the first cell boundary on this axis. */
function boundary(pos: number, dir: number): number {
  if (dir === 0) return Infinity;
  const f = pos - Math.floor(pos);
  return (dir > 0 ? 1 - f : f) / Math.abs(dir);
}
