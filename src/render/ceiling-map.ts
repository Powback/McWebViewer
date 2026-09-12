/**
 * Where the ceiling is, per column, around the character.
 *
 * THE PROBLEM THIS SOLVES. The isometric cutaway removes what is between the camera and
 * the character. From a camera looking down that means removing things above them, and
 * every rule tried for "how high" traded one complaint for the other:
 *
 *   depth only          the cut is a plane tilted 55 degrees, a ceiling is flat, so they
 *                       meet in a straight line and the roof comes away in exactly half
 *                       ("I can see half the roof above me and all the floor above that")
 *   a fixed height      cuts THROUGH things, so a pillar or a monitor loses its top and
 *                       leaves a gap ("its cutting off the top of blocks which should be
 *                       visible... air between their tops and the roof")
 *
 * No single height works, and that is not a tuning failure — it was measured. Sampling the
 * 81 columns within 8 blocks of the reference world's spawn: the first solid above head
 * height sits at +2, +3 or +9 depending on the column, and its thickness is 1 or 30. A
 * monitor top and a ceiling are at the SAME height in the same room. One number cannot
 * separate them.
 *
 * WHAT DOES SEPARATE THEM IS SHAPE, NOT HEIGHT. A ceiling block has open space directly
 * beneath it — that is the room you are standing in. The top of a pillar, a monitor or a
 * machine has more of itself underneath. So the question is asked per column: scanning up
 * from above the character's head, the first solid block WITH AIR UNDER IT is the ceiling,
 * and everything from there up is a lid rather than an object. A column that is solid all
 * the way up from the floor never produces one, so a pillar keeps its top.
 *
 * The same sample confirms the discriminator is real here rather than assumed: of those
 * columns, some first-solids have air below them and some do not.
 *
 * HOW IT REACHES THE GPU. One byte per column of a 32x32 patch centred on the character,
 * as a `DataTexture` — "cut from this many blocks above the character's feet upward", or
 * 255 for "this column has no ceiling, never cut it". The fragment shader reads one texel.
 * There is no extra pass, no geometry and no flood fill; the patch is rebuilt only when the
 * character changes block, and covers more than the widest the cutaway ever reaches.
 *
 * WHAT IT GETS WRONG, on purpose. A shelf, a beam or a hanging lamp is one block with air
 * under it, so it reads as a ceiling and is cut along with everything above it. That is the
 * same answer a person would give if asked "is this between me and the sky" and it is the
 * price of having no semantics beyond block occupancy — there is nothing in the data that
 * says "lamp" rather than "roof".
 */

/** Whether a cell is open — air, or something with no more substance than air. */
export type OpenTest = (x: number, y: number, z: number) => boolean;

/**
 * Columns across the patch.
 *
 * 32 covers +/-16 blocks around the character, comfortably past the cutaway's widest reach
 * (`REVEAL_OUTER_BLOCKS`), so the patch never runs out underneath the hole and the shader
 * needs no special case at its edge — outside it the answer is simply "no ceiling".
 */
export const CEIL_SIZE = 32;
const HALF = CEIL_SIZE / 2;

/** Byte meaning "this column has no ceiling": nothing in it is ever cut by height. */
export const NO_CEILING = 255;

/**
 * Byte meaning "this column IS open space around the character, but has nothing overhead".
 *
 * The distinction 255 cannot make, and the one that stops the cutaway showing you the void.
 * THE MESHER NEVER BUILDS FACES BETWEEN TWO SOLID BLOCKS — correctly; they can never be seen.
 * So cutting away the outer shell of anything thicker than one block exposes an interior that
 * has no geometry at all, and you look straight through the world. No plane position fixes
 * that, which is exactly how the user described it: "there's some faces missing when I go into
 * iso mode... unrelated to the clipping plane" (2026-09-11).
 *
 * The fix is to cut only where cutting reveals something: the open space the character is
 * actually standing in. So a column is one of three things, and one byte says which —
 *
 *   255  not open space around the character. NEVER cut; there is nothing behind it.
 *   254  open space, no lid. Cut by depth if the mode wants to, never by height.
 *   0..  open space with a lid this many blocks up. Cut by height from there.
 *
 * Outdoors that leaves the depth cut working exactly as before (open ground floods, so those
 * columns are 254) while a hill stays put — which is the trade the user asked for: see the
 * room, do not see through the world.
 */
export const IN_ROOM_NO_LID = 254;

/** What `ceilingAt` returns for a column that is open space with nothing overhead. */
export const NO_LID_HEIGHT = 1e8;
/** Below this, a column is open space around the character; above it, it must never be cut. */
export const IN_ROOM_LIMIT = 5e8;

/**
 * How far above the character's feet the scan starts and stops.
 *
 * It starts at +2 so the character's own head is never mistaken for a ceiling, and stops at
 * +28 because a "ceiling" 28 blocks up is the sky with a cloud in front of it — and because
 * the byte has to fit.
 */
const SCAN_FROM = 2;
const SCAN_TO = 28;

export interface CeilingMap {
  /** one byte per column, row-major `[z][x]`, in blocks above `baseY`; 255 = no ceiling */
  bytes: Uint8Array<ArrayBuffer>;
  /** world coordinates of column (0, 0) */
  baseX: number;
  baseZ: number;
  /** the height the bytes are measured from: the character's feet */
  baseY: number;
}

/**
 * Scan one column for the first solid block above head height that has air under it.
 *
 * Returns the height above `feetY`, or `NO_CEILING`. The "air under it" test is the whole
 * point: a column that is solid from the floor up (a pillar, a machine, a stack of chests)
 * hits solid blocks on the way but never one with a gap beneath, so it reports no ceiling
 * and nothing in it is ever cut by height.
 */
export function ceilingAbove(
  isOpen: OpenTest,
  x: number,
  feetY: number,
  z: number,
): number {
  for (let d = SCAN_FROM; d <= SCAN_TO; d++) {
    const y = feetY + d;
    if (isOpen(x, y, z)) continue;
    if (isOpen(x, y - 1, z)) return d;
    // Solid, but solid underneath too: this is the body of something standing on the
    // floor, not a lid over the room. Keep going — a machine can have a roof above it.
  }
  return NO_CEILING;
}

/**
 * Fill a patch of ceiling heights centred on the character.
 *
 * `bytes` is reused between calls so a character walking does not allocate 1 KB a block.
 */
export function buildCeilingMap(
  isOpen: OpenTest,
  feet: readonly [number, number, number],
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array(CEIL_SIZE * CEIL_SIZE),
): CeilingMap {
  const baseX = Math.floor(feet[0]) - HALF;
  const baseZ = Math.floor(feet[2]) - HALF;
  const baseY = Math.floor(feet[1]);
  for (let iz = 0; iz < CEIL_SIZE; iz++) {
    for (let ix = 0; ix < CEIL_SIZE; ix++) {
      bytes[iz * CEIL_SIZE + ix] = ceilingAbove(isOpen, baseX + ix, baseY, baseZ + iz);
    }
  }
  return { bytes, baseX, baseZ, baseY };
}

/**
 * The shader's lookup, in TypeScript, so the rule is testable without a GL context.
 *
 * Same contract `revealCoverage` has: everything that decides the answer lives here, and
 * the shader adds only the texture fetch that supplies the byte.
 */
export function ceilingAt(
  map: CeilingMap | null,
  worldX: number,
  worldZ: number,
  normalX = 0,
  normalZ = 0,
): number {
  if (!map) return Infinity;
  // STEP BACK INTO THE BLOCK THAT OWNS THE FACE. A vertical face lies exactly on the boundary
  // between two columns, so its world x (or z) is a whole number and `floor` hands it to whichever
  // side the number line falls on -- the far one, for a face whose normal points the positive way.
  // A quarter block against the normal is always inside the owning column, and for a TOP face the
  // horizontal normal is zero, so the step is zero and the column is its own.
  const ix = Math.floor(worldX - normalX * 0.25) - map.baseX;
  const iz = Math.floor(worldZ - normalZ * 0.25) - map.baseZ;
  if (ix < 0 || iz < 0 || ix >= CEIL_SIZE || iz >= CEIL_SIZE) return Infinity;
  const b = map.bytes[iz * CEIL_SIZE + ix]!;
  if (b >= NO_CEILING) return Infinity;
  if (b === IN_ROOM_NO_LID) return NO_LID_HEIGHT;
  return map.baseY + b;
}

/**
 * Is this column open space around the character — the only place cutting reveals anything?
 *
 * See `IN_ROOM_NO_LID`. Outside it the mesher has built no interior faces, so a cut there is a
 * hole into the void rather than a view of a room.
 */
export function insideRoom(height: number): boolean {
  return height < IN_ROOM_LIMIT;
}

/**
 * A number as a GLSL **float** literal.
 *
 * GLSL ES HAS NO IMPLICIT INT TO FLOAT CONVERSION, and template interpolation hands it whatever
 * `String(n)` produces. `1e8` becomes "100000000", which is an INT literal, so `return 1e8;` from a
 * float function and `someFloat < 5e8` are both compile errors — and a shader that fails to compile
 * takes the whole material down with a message that names neither the line nor the cause:
 * "THREE.WebGLProgram: Shader Error 1282 ... Fragment shader is not compiled" (2026-09-11).
 *
 * The rest of this file had been appending ".0" and ".5" by hand for exactly this reason. This makes
 * the rule a function instead, so the next constant cannot forget.
 */
export function glslFloat(n: number): string {
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n);
}

/** The GLSL half, kept next to the TypeScript one so the two cannot drift apart. */
export const CEILING_GLSL = /* glsl */`
  uniform sampler2D mcwvCeilMap;
  uniform vec4 mcwvCeilBase;   // baseX, baseZ, baseY, enabled

  float mcwvCeilOne(vec2 worldXZ) {
    if (mcwvCeilBase.w < 0.5) return 1e9;
    vec2 c = floor(worldXZ) - mcwvCeilBase.xy;
    if (c.x < 0.0 || c.y < 0.0 || c.x > ${CEIL_SIZE - 1}.0 || c.y > ${CEIL_SIZE - 1}.0) return 1e9;
    float b = texture2D(mcwvCeilMap, (c + 0.5) / ${CEIL_SIZE}.0).r * 255.0;
    // The three cases of the byte, in the same order as the TypeScript: not open space around
    // the character (never cut), open space with nothing overhead, open space under a lid.
    if (b > ${NO_CEILING - 1}.5) return 1e9;
    if (b > ${IN_ROOM_NO_LID - 1}.5) return ${glslFloat(NO_LID_HEIGHT)};
    return mcwvCeilBase.z + b;
  }

  // A VERTICAL FACE SITS EXACTLY ON THE BOUNDARY BETWEEN TWO COLUMNS.
  //
  // The roof has a hole in its centre. The blocks lining that hole had their TOP faces cut and their
  // inward-facing SIDE faces left behind, so the hole was ringed with visible faces. The cause is
  // this lookup, not the map: a side face's world x (or z) is an exact integer, so floor() resolved
  // it to the column on the far side -- the hole, which correctly reports no ceiling -- while the top
  // face of the very same block sampled its own column and was cut.
  //
  // THE NORMAL SAYS WHICH COLUMN OWNS THE FACE, so step a quarter block back along it. The first fix
  // for this sampled all four surrounding columns and took the LOWEST ceiling, on the reasoning that
  // it could not over-cut -- which is wrong wherever two columns have different ceilings. A tall room
  // next to a low one lost its wall from the low room's ceiling height upwards, everywhere the two
  // met ("some weird face disappearing issues in isometric" -- the user, 2026-09-11).
  float mcwvCeilingAt(vec2 worldXZ, vec2 normalXZ) {
    return mcwvCeilOne(worldXZ - normalXZ * 0.25);
  }
`;
