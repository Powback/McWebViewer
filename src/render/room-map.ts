/**
 * THE ROOM YOU ARE STANDING IN — an alternative to the cutaway, with no camera clipping at all.
 *
 * THE PROBLEM WITH CUTTING BY DEPTH. The isometric cutaway hides whatever is nearer to the camera
 * than the character, inside a disc around them. That is a screen-space rule, and screen space has
 * no idea what a building is: the plane goes through the near wall, and it keeps going. Past the
 * wall there is often nothing — so the hole meant to show you the room shows you the void behind
 * the world instead. "we really shouldnt be able to see through walls and shit... i mean yes to
 * like see the room, but not so that I can see through the world" (the user, 2026-09-11).
 *
 * Every attempt to fix that by tuning the plane hit the same wall, literally. A plane short enough
 * to keep the far side of the room intact does not reach the near wall, so the character stays
 * hidden; a plane far enough to clear the near wall is already past the room.
 *
 * WHAT THIS DOES INSTEAD — the Project Zomboid answer. Find the room by its SHAPE, once, on the
 * CPU, and hide exactly that room's lid and near walls. Nothing else in the world is touched, ever.
 * There is no depth test, no disc and no clip plane, so there is nothing that can cut through into
 * the void: a wall two rooms over is not part of this room, so it simply stays.
 *
 * HOW THE ROOM IS FOUND. A flood fill through open cells from the character's feet, bounded by the
 * patch and by a cell budget. Solid blocks stop it, which is what makes it a room rather than a
 * radius — a wall is a wall whatever its distance, and a doorway lets the fill through into the next
 * room, which is correct: you can see through an open door.
 *
 * WHAT EACH COLUMN GETS, in the same one-byte-per-column texture the cutaway already uses, so the
 * shader path is unchanged:
 *
 *   in the room      the height of its ceiling — the lid comes off, the walls stay
 *   a NEAR wall      0, so the whole column above the floor goes: this is the wall between you
 *                    and the camera, and hiding it is the only reason the mode needs the camera
 *                    at all. Which walls are "near" is one dot product against the view direction.
 *   anything else    NO_CEILING. Never cut. This is the line that makes seeing through the world
 *                    impossible rather than unlikely.
 *
 * WHAT IT GETS WRONG, on purpose. Outdoors there is no room to find, so the fill runs to its budget
 * and stops; the columns it reached have no ceiling anyway, so nothing is cut and the mode degrades
 * to "no cutaway at all" rather than to something wrong. A room with a hole in its roof leaks the
 * fill to the sky and out over the roof, which is also right: that roof is not between you and the
 * camera any more.
 */

import {
  CEIL_SIZE, IN_ROOM_NO_LID, NO_CEILING, ceilingAbove, type CeilingMap, type OpenTest,
} from './ceiling-map.js';

const HALF = CEIL_SIZE / 2;

/**
 * How many open cells the fill will visit before giving up.
 *
 * A cap rather than a guarantee: this runs whenever the character changes block, on the main
 * thread, and a character who steps outdoors would otherwise flood the whole patch every time. The
 * patch is 32x32 columns and a room is a few blocks tall, so 6000 covers any real interior while
 * staying a fraction of the 32x32x(ROOM_UP+ROOM_DOWN) worst case.
 */
const CELL_BUDGET = 6000;

/**
 * How far up and down the fill may travel from the character's feet.
 *
 * Up far enough to reach a high ceiling and out through a stairwell; down only one, so the fill
 * cannot pour off a balcony and claim the floor below as part of this room. A room is the thing you
 * are standing IN, and the storey below is a different one.
 */
const ROOM_UP = 12;
const ROOM_DOWN = 1;

/**
 * How far from the character's own level a cell has to be before reaching it stops meaning the
 * COLUMN is open space.
 *
 * A column is one byte and occupancy is three-dimensional, and that gap is a real bug rather than
 * a rounding error: the fill climbs over a hill and comes down the far side, so every column of
 * the hill gets reached — six blocks above the solid rock that fills it. Marking those as open
 * space put the depth cut straight back into the hillside, which is the void this exists to stop.
 *
 * So exploring and MARKING are separated. The fill still travels up to `ROOM_UP` — it has to, or
 * it could not cross a raised walkway or find a tall room's lid — but a column only counts as open
 * space if the fill stood in it at roughly the character's own height. Feet to head plus a step
 * up: what you could walk into, which is also what you need to see.
 */
const BAND_UP = 3;
const BAND_DOWN = 1;

/** The four horizontal neighbours, as [dx, dz]. */
const SIDES: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Fill the room around `feet` and turn it into the cut-height map the shader reads.
 *
 * `toCamera` is the horizontal direction from the character towards the camera; it decides which of
 * a room's walls are between you and the view. It need not be normalised — only the sign of the dot
 * product is used.
 *
 * `bytes` is reused between calls so a character walking does not allocate 1 KB a block.
 */
export function buildRoomMap(
  isOpen: OpenTest,
  feet: readonly [number, number, number],
  toCamera: readonly [number, number],
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array(CEIL_SIZE * CEIL_SIZE),
): CeilingMap {
  const baseX = Math.floor(feet[0]) - HALF;
  const baseZ = Math.floor(feet[2]) - HALF;
  const baseY = Math.floor(feet[1]);
  bytes.fill(NO_CEILING);

  const inside = fillRoom(isOpen, [Math.floor(feet[0]), baseY, Math.floor(feet[2])], baseX, baseZ);

  // The room's own columns: their lid comes off, and only their lid. A column the fill reached but
  // which has no ceiling (standing under open sky through a hole in the roof) stays NO_CEILING.
  for (const col of inside) {
    const ix = col % CEIL_SIZE;
    const iz = (col - ix) / CEIL_SIZE;
    const lid = ceilingAbove(isOpen, baseX + ix, baseY, baseZ + iz);
    // A column the fill REACHED but which has nothing overhead is still open space, and saying
    // so is what keeps the depth cut working outdoors. 255 would mean "never cut", which would
    // switch the cutaway off the moment you stepped outside. See IN_ROOM_NO_LID.
    bytes[col] = lid >= NO_CEILING ? IN_ROOM_NO_LID : lid;
  }

  markNearWalls(isOpen, inside, toCamera, bytes, baseX, baseZ, baseY);
  return { bytes, baseX, baseZ, baseY };
}

/**
 * Every column the room reaches, as indices into the patch.
 *
 * The fill starts at the character's feet and, if that is somehow solid, at their head — a
 * character standing in a block they are being pushed out of must still get a room, or the mode
 * blinks off for a frame at exactly the moment something interesting is happening.
 */
function fillRoom(
  isOpen: OpenTest,
  start: readonly [number, number, number],
  baseX: number,
  baseZ: number,
): Set<number> {
  const cols = new Set<number>();
  const seen = new Set<string>();
  const queue: Array<[number, number, number]> = [];
  const push = (x: number, y: number, z: number) => {
    const ix = x - baseX;
    const iz = z - baseZ;
    if (ix < 0 || iz < 0 || ix >= CEIL_SIZE || iz >= CEIL_SIZE) return;
    if (y > start[1] + ROOM_UP || y < start[1] - ROOM_DOWN) return;
    const key = `${x}:${y}:${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!isOpen(x, y, z)) return;
    // Explored either way; marked only at the character's own level. See BAND_UP.
    if (y <= start[1] + BAND_UP && y >= start[1] - BAND_DOWN) cols.add(iz * CEIL_SIZE + ix);
    queue.push([x, y, z]);
  };

  push(start[0], start[1], start[2]);
  if (queue.length === 0) push(start[0], start[1] + 1, start[2]);

  for (let head = 0; head < queue.length && seen.size < CELL_BUDGET; head++) {
    const [x, y, z] = queue[head]!;
    for (const [dx, dz] of SIDES) push(x + dx, y, z + dz);
    push(x, y + 1, z);
    push(x, y - 1, z);
  }
  return cols;
}

/**
 * Hide the walls that stand between the room and the camera.
 *
 * A wall column is one the fill did NOT reach that touches one it did. Whether it is in the way is
 * one dot product: the offset from the room cell to the wall, against the direction to the camera.
 * Positive means the wall is on the camera's side of that cell, so you are looking through it.
 *
 * The far walls are deliberately left standing. They are what stops the room being a hole in the
 * world — with every wall hidden this mode would show the void just as the clip plane did, which is
 * the entire failure it exists to avoid.
 */
function markNearWalls(
  isOpen: OpenTest,
  inside: ReadonlySet<number>,
  toCamera: readonly [number, number],
  bytes: Uint8Array,
  baseX: number,
  baseZ: number,
  baseY: number,
): void {
  for (const col of inside) {
    const ix = col % CEIL_SIZE;
    const iz = (col - ix) / CEIL_SIZE;
    for (const [dx, dz] of SIDES) {
      if (dx * toCamera[0] + dz * toCamera[1] <= 0) continue;
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= CEIL_SIZE || nz >= CEIL_SIZE) continue;
      const n = nz * CEIL_SIZE + nx;
      if (inside.has(n)) continue;
      // NOT IN THE ROOM IS NOT THE SAME AS SOLID. The fill stops at CELL_BUDGET, and outdoors it
      // stops long before the patch edge — so "the fill did not reach it" describes open ground as
      // readily as a wall. Marking those hid a ring of empty columns around wherever the budget ran
      // out, which outdoors is a wall of nothing following the character around.
      if (isOpen(baseX + nx, baseY, baseZ + nz)) continue;
      // 0 = "cut this column from the character's feet upward". The floor is below the feet, so it
      // survives; the wall standing on it does not.
      bytes[n] = 0;
    }
  }
}
