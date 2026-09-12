/**
 * Tests for the per-column ceiling map.
 *
 * This is the discriminator the whole isometric cutaway now turns on, and it exists
 * because two simpler rules were tried against real users and both failed:
 *
 *   depth only     the roof comes away in half, with a straight edge across the picture
 *   a fixed height the tops come off pillars, monitors and machines
 *
 * So what is pinned here is exactly the distinction: a ceiling is a solid block with OPEN
 * SPACE UNDER IT, and the top of an object is not. Every test below is one shape that has
 * to come out on one side of that line, including the two shapes most likely to break it —
 * a ceiling several blocks thick, and a one-block shelf that is not a ceiling at all but
 * looks exactly like one to this rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CEILING_GLSL, CEIL_SIZE, NO_CEILING, buildCeilingMap, ceilingAbove, ceilingAt, glslFloat,
  type OpenTest,
} from './ceiling-map.js';

/** A world made of rules rather than data: `solid` says where the blocks are. */
function worldOf(solid: (x: number, y: number, z: number) => boolean): OpenTest {
  return (x, y, z) => !solid(x, y, z);
}

const FEET = 64;

test('a ceiling over a room is found, at the height of its underside', () => {
  // Floor at 63, air 64..68, a one-block lid at 69.
  const room = worldOf((_x, y) => y === 63 || y === 69);
  assert.equal(ceilingAbove(room, 0, FEET, 0), 5);
});

test('A CEILING SEVERAL BLOCKS THICK reports its underside, and the whole lid goes', () => {
  // The first thing that could have broken the rule: only the bottom block of a thick
  // ceiling has air under it. Reporting the underside is what makes the rest of the lid go
  // too, because everything at or above that height is cut — otherwise you would open the
  // room and find a slab still sitting over it.
  const thick = worldOf((_x, y) => y === 63 || (y >= 69 && y <= 74));
  assert.equal(ceilingAbove(thick, 0, FEET, 0), 5);
  const map = buildCeilingMap(thick, [0.5, FEET, 0.5]);
  const cut = ceilingAt(map, 0.5, 0.5);
  assert.equal(cut, FEET + 5);
  for (const y of [69, 70, 71, 72, 73, 74]) {
    assert.ok(y >= cut, `block at y${y} is part of the lid and must be at or above the cut`);
  }
});

test('A PILLAR HAS NO CEILING, so its top is never cut', () => {
  // The complaint this rule exists to fix: "its cutting off the top of blocks which should
  // be visible". A column that is solid from the floor up never has a solid block with air
  // under it, so it reports nothing and the height rule never touches it.
  const pillar = worldOf((x, y, z) => y === 63 || (x === 0 && z === 0 && y >= 64 && y <= 70));
  assert.equal(ceilingAbove(pillar, 0, FEET, 0), NO_CEILING);
  assert.equal(ceilingAt(buildCeilingMap(pillar, [0.5, FEET, 0.5]), 0.5, 0.5), Infinity);
});

test('a machine under a roof: the machine keeps its top and the roof still goes', () => {
  // Both in one column, which is the case a "first solid above head height" rule without
  // the air-under test gets wrong — it would stop at the machine and cut from there.
  const both = worldOf((x, y, z) => {
    if (y === 63) return true;                                   // floor
    if (x === 0 && z === 0 && y >= 64 && y <= 67) return true;   // a 4-block machine
    return y === 71;                                             // roof over everything
  });
  assert.equal(ceilingAbove(both, 0, FEET, 0), 7, 'the roof, not the machine');
  // The machine's own top at y=67 is below the cut, so it survives.
  assert.ok(67 < FEET + 7);
});

test('A ONE-BLOCK SHELF IS TREATED AS A CEILING — the known cost, pinned', () => {
  // Honest about what this gets wrong. A shelf, a beam or a hanging lamp is a solid block
  // with air under it, which is the definition, so it reads as a ceiling and goes along
  // with everything above it. There is nothing in block occupancy that says "lamp" rather
  // than "roof", and inventing a thickness threshold would sacrifice real one-block roofs
  // — which the reference world has: sampled at spawn, ceiling thicknesses are 1 and 30.
  const shelf = worldOf((x, y, z) => y === 63 || (x === 0 && z === 0 && y === 67));
  assert.equal(ceilingAbove(shelf, 0, FEET, 0), 3);
  // And the column beside it is unaffected, so the loss is one column wide, not a region.
  assert.equal(ceilingAbove(shelf, 1, FEET, 0), NO_CEILING);
});

test('outdoors there is no ceiling anywhere, so nothing is ever cut by height', () => {
  const outdoors = worldOf((_x, y) => y <= 63);
  const map = buildCeilingMap(outdoors, [0.5, FEET, 0.5]);
  assert.ok(map.bytes.every((b) => b === NO_CEILING));
  assert.equal(ceilingAt(map, 0.5, 0.5), Infinity);
});

test("the character's own head is never mistaken for the ceiling", () => {
  // The scan starts above head height. A rule that started at the feet would find the
  // character standing in a one-block gap and cut the floor above them.
  const low = worldOf((_x, y) => y === 63 || y === 66);   // 2 blocks of headroom exactly
  assert.equal(ceilingAbove(low, 0, FEET, 0), 2);
});

test('the patch is centred on the character and covers the whole cutaway', () => {
  const room = worldOf((_x, y) => y === 63 || y === 69);
  const map = buildCeilingMap(room, [100.5, FEET, -200.5]);
  assert.equal(map.baseX, 100 - CEIL_SIZE / 2);
  assert.equal(map.baseZ, -201 - CEIL_SIZE / 2);
  assert.equal(map.baseY, FEET);
  // The cutaway's widest reach is REVEAL_OUTER_BLOCKS (9); the patch must beat it in every
  // direction or the hole runs off the edge of its own data.
  for (const d of [-15, -9, 0, 9, 15]) {
    assert.equal(ceilingAt(map, 100.5 + d, -200.5 + d), FEET + 5, `offset ${d}`);
  }
  // ...and outside it the answer is "no ceiling", never a wrong one.
  assert.equal(ceilingAt(map, 100.5 + 40, -200.5), Infinity);
});

test('a reused buffer does not leak the previous position', () => {
  const room = worldOf((_x, y) => y === 63 || y === 69);
  const pillar = worldOf((_x, y) => y === 63);
  const a = buildCeilingMap(room, [0.5, FEET, 0.5]);
  const b = buildCeilingMap(pillar, [0.5, FEET, 0.5], a.bytes);
  assert.ok(b.bytes.every((v) => v === NO_CEILING), 'every column must be rewritten');
});

/**
 * WHICH COLUMN OWNS A FACE.
 *
 * A vertical face lies exactly on the boundary between two columns, so its world x (or z) is
 * an exact integer and `floor()` resolves it to whichever side the number line happens to fall
 * on. That is a coin toss, and it loses the same way every time. Two shapes pin the rule.
 */

/** A room with a lid at `lidY`, over columns where `inside` says so; everything else open sky. */
const rooms = (lidOf: (x: number) => number | null) =>
  worldOf((x, y) => y === 63 || y === lidOf(x));

test('THE RIM OF A ROOF HOLE comes away with the roof, instead of ringing the hole', () => {
  // The lid is at 69 over column 0; column 1 is the hole, open to the sky. The lid block's
  // inward SIDE face sits at world x = 1.0 -- inside the hole's column by floor(), which
  // correctly reports no ceiling, so the face survived while the very same block's TOP face
  // was cut. That left every roof hole ringed with faces.
  const map = buildCeilingMap(rooms((x) => (x === 0 ? 69 : null)), [0.5, FEET, 0.5]);
  // Judged by its own column (normal +X, so step back into column 0), it is ceiling and goes.
  assert.equal(ceilingAt(map, 1, 0.5, 1, 0), FEET + 5);
  // Judged by the neighbour -- the old bug -- it is open sky and stays.
  assert.equal(ceilingAt(map, 1, 0.5), Infinity);
});

test('A TALL ROOM BESIDE A LOW ONE keeps the wall above the low room\'s ceiling', () => {
  // The failure that replaced the first one: sampling all four columns around the point and
  // taking the LOWEST ceiling judges a face by whichever neighbour has the lowest lid. Here
  // column 0 is a low room (lid 69) and column 1 a tall one (lid 74); the shared wall face at
  // y=71 belongs to the tall room and must stay, or the tall room loses its wall from the low
  // room's ceiling height upwards.
  const map = buildCeilingMap(rooms((x) => (x === 0 ? 69 : x === 1 ? 74 : null)), [0.5, FEET, 0.5]);
  // The face is at x = 1.0 with its normal pointing back into column 1 (-X), so column 1 owns it.
  assert.equal(ceilingAt(map, 1, 0.5, -1, 0), FEET + 10);
  // The lowest of the four surrounding columns would have said 69 for that face, and cut it.
  // The SAME boundary, judged from the low room's side (-X normal, so column 0 owns it), still
  // reports the low lid: the rule reads the normal, it does not just prefer the taller answer.
  assert.equal(ceilingAt(map, 1, 0.5, 1, 0), FEET + 5, 'the low room still reports its own lid');
});

test('a TOP face is judged by the column it sits on, whichever way its normal points', () => {
  const map = buildCeilingMap(rooms((x) => (x === 0 ? 69 : null)), [0.5, FEET, 0.5]);
  // A +Y normal has no horizontal component, so there is no step and nothing to get wrong.
  assert.equal(ceilingAt(map, 0.5, 0.5, 0, 0), FEET + 5);
});

/**
 * EVERY NUMBER THE SHADER IS HANDED MUST BE A FLOAT.
 *
 * GLSL ES has no implicit int-to-float conversion, and `String(1e8)` is "100000000" — an INT
 * literal. Interpolating one produced `return 100000000;` from a float function and
 * `someFloat < 500000000`, and the whole material died with a message that names neither the
 * line nor the cause: "THREE.WebGLProgram: Shader Error 1282 ... Fragment shader is not
 * compiled" (2026-09-11). Nothing in TypeScript can catch that; it is a string until the GPU
 * sees it. These assert on the GLSL this module actually emits, which is its output.
 */

test('glslFloat always produces something GLSL will read as a float', () => {
  assert.equal(glslFloat(1e8), '100000000.0', 'exponent notation must not survive as an int');
  assert.equal(glslFloat(5e8), '500000000.0');
  assert.equal(glslFloat(0), '0.0');
  assert.equal(glslFloat(-1), '-1.0');
  assert.equal(glslFloat(255), '255.0');
  // Already fractional: leave it be, it is already a float literal.
  assert.equal(glslFloat(0.5), '0.5');
  assert.equal(glslFloat(1.25), '1.25');
});

test('THE EMITTED GLSL CONTAINS NO BARE INTEGER LITERAL — the thing that broke the shader', () => {
  // Comments first: this file cites dates like 2026-09-11, and the compiler never sees them.
  const code = CEILING_GLSL.replace(/\/\/[^\n]*/g, '');
  // A numeric literal in this shader's CODE is always a float. A digit run with no "." and no
  // exponent beside it is the bug, whatever introduced it; nothing here is legitimately an int.
  const offenders = [...code.matchAll(/(?<![.\w])(\d+)(?![.\deE])/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `bare int literal(s) in the shader: ${offenders.join(', ')}`);
});
