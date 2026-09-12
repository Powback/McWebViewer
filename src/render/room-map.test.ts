/**
 * Tests for the room reveal — the mode with no camera clipping.
 *
 * The requirement that drove it is a negative one, and negatives are exactly what a screenshot
 * cannot show: "we really shouldnt be able to see through walls and shit... i mean yes to like see
 * the room, but not so that I can see through the world" (the user, 2026-09-11). So the first thing
 * pinned here is what is NOT cut, and it is pinned on the shape that used to fail — a wall standing
 * between the camera and the character, but belonging to a different room.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CEIL_SIZE, IN_ROOM_NO_LID, NO_CEILING, NO_LID_HEIGHT, ceilingAt, insideRoom, type OpenTest,
} from './ceiling-map.js';
import { buildRoomMap } from './room-map.js';

/** A world made of rules rather than data: `solid` says where the blocks are. */
function worldOf(solid: (x: number, y: number, z: number) => boolean): OpenTest {
  return (x, y, z) => !solid(x, y, z);
}

const FEET = 64;
/** The camera is up and to the +X/+Z side, as an isometric camera at 45 degrees is. */
const TO_CAMERA: [number, number] = [1, 1];

/**
 * One room: floor at 63, air 64..68, lid at 69, walls at the given x/z bounds.
 * Outside the walls is open sky — which is what the void looked like through the old clip plane.
 */
const roomWorld = (x0: number, x1: number, z0: number, z1: number) => worldOf((x, y, z) => {
  const inX = x >= x0 && x <= x1;
  const inZ = z >= z0 && z <= z1;
  if (y === 63) return inX && inZ;                    // floor
  if (y === 69) return inX && inZ;                    // lid
  if (y > 63 && y < 69) return (inX && inZ) && (x === x0 || x === x1 || z === z0 || z === z1);
  return false;
});

test('THE ROOM YOU ARE IN LOSES ITS LID, at the height of its underside', () => {
  const map = buildRoomMap(roomWorld(-4, 4, -4, 4), [0.5, FEET, 0.5], TO_CAMERA);
  // A column in the middle of the room: cut from the lid up.
  assert.equal(ceilingAt(map, 0.5, 0.5), FEET + 5);
});

test('A WALL THAT IS NOT THIS ROOM IS NEVER CUT, however squarely it stands in the way', () => {
  // THE FAILURE THIS MODE EXISTS TO FIX. The depth plane hid everything nearer than the character
  // inside a disc, which meant the next room's wall, and then the world behind it. Here the fill
  // stops at this room's wall, so the far room is simply not in the map at all.
  const two = worldOf((x, y, z) => {
    const inZ = z >= -4 && z <= 4;
    const inX = x >= -4 && x <= 14;
    if (y === 63 || y === 69) return inX && inZ;
    if (y > 63 && y < 69) return inX && inZ && (x === -4 || x === 14 || z === -4 || z === 4 || x === 5);
    return false;
  });
  const map = buildRoomMap(two, [0.5, FEET, 0.5], TO_CAMERA);
  // The dividing wall at x=5 is the near wall of THIS room, so it goes...
  assert.equal(ceilingAt(map, 5.5, 0.5), FEET, 'the near wall of the room you are in comes away');
  // ...and everything beyond it does not. This is the assertion that stops the void.
  for (const x of [6.5, 8.5, 10.5, 13.5]) {
    assert.equal(ceilingAt(map, x, 0.5), Infinity, `x=${x} is the next room and must stay`);
  }
});

test('the FAR walls stay standing, or the room would be a hole in the world', () => {
  const map = buildRoomMap(roomWorld(-4, 4, -4, 4), [0.5, FEET, 0.5], TO_CAMERA);
  // Camera is towards +X/+Z, so the walls at x=-4 and z=-4 are the far side in both axes. Sample
  // INSIDE those columns (-3.5 floors to -4); -4.5 would floor to -5, which is open sky and would
  // pass for the wrong reason.
  assert.equal(ceilingAt(map, -3.5, 0.5), Infinity, 'the far -X wall is not in the way');
  assert.equal(ceilingAt(map, 0.5, -3.5), Infinity, 'nor the far -Z wall');
});

test('THE NEAR WALLS COME AWAY, which is the only thing the camera direction decides', () => {
  const world = roomWorld(-4, 4, -4, 4);
  const near = buildRoomMap(world, [0.5, FEET, 0.5], [1, 1]);
  assert.equal(ceilingAt(near, 4.5, 0.5), FEET, '+X is towards the camera, so that wall goes');
  assert.equal(ceilingAt(near, 0.5, 4.5), FEET, 'and +Z with it');

  // Turn the camera to the opposite corner and the OTHER two walls are the ones in the way.
  const far = buildRoomMap(world, [0.5, FEET, 0.5], [-1, -1]);
  assert.equal(ceilingAt(far, -3.5, 0.5), FEET, "now -X is the near wall");
  assert.equal(ceilingAt(far, 4.5, 0.5), Infinity, 'and +X is the one that stays');
});

test('the floor is never cut — 0 means "from the feet up", and the floor is below them', () => {
  const map = buildRoomMap(roomWorld(-4, 4, -4, 4), [0.5, FEET, 0.5], TO_CAMERA);
  // The near wall's column cuts from FEET upward; the floor block at 63 is under that.
  assert.ok(ceilingAt(map, 4.5, 0.5) > 63, 'the cut starts above the floor block');
});

test('OUTDOORS NOTHING IS CUT BY HEIGHT, but the ground still counts as open space', () => {
  // Two different answers that one byte has to keep apart, and getting them confused either
  // switches the cutaway off the moment you step outside or lets it eat into a hillside.
  //
  // Open ground the fill reached is OPEN SPACE WITH NO LID: nothing overhead to remove, but the
  // depth cut may still work there, because behind those surfaces is air the mesher has given
  // faces to. A column the fill never reached — the inside of a hill — is neither, and must
  // never be cut at all: there is no geometry behind it to reveal.
  const map = buildRoomMap(worldOf((_x, y) => y < FEET), [0.5, FEET, 0.5], TO_CAMERA);
  assert.ok(map.bytes.some((v) => v === IN_ROOM_NO_LID), 'the ground around you is open space');
  assert.ok(!map.bytes.some((v) => v < IN_ROOM_NO_LID), 'and nothing outdoors has a lid to cut');
  assert.equal(ceilingAt(map, 0.5, 0.5), NO_LID_HEIGHT, 'so no height ever cuts it');
  assert.equal(insideRoom(ceilingAt(map, 0.5, 0.5)), true, 'but the depth cut may still apply');
});

test('THE INSIDE OF A HILL IS NEVER CUT — this is what stops you seeing through the world', () => {
  // The failure this encodes: the mesher builds no faces between two solid blocks, so cutting the
  // outer shell of a hill exposes an interior with no geometry in it at all. The fill cannot reach
  // those columns, so they keep NO_CEILING and the shader's `insideRoom` gate refuses to cut them.
  const hill = worldOf((x, y, z) => y < FEET || (x >= 8 && x <= 12 && z >= -2 && z <= 2 && y < FEET + 6));
  const map = buildRoomMap(hill, [0.5, FEET, 0.5], TO_CAMERA);
  // Deep inside the hill, well past the one-column-thick near-wall rim.
  assert.equal(insideRoom(ceilingAt(map, 10.5, 0.5)), false, 'the middle of the hill is not open space');
  assert.equal(ceilingAt(map, 10.5, 0.5), Infinity, 'so nothing there is ever removed');
});

test('a room next door that shares no air is not this room, even one block away', () => {
  // Two sealed rooms with a double wall between them. The fill cannot cross, so the far room keeps
  // its lid: you see into the room you are in, and no further.
  const sealed = worldOf((x, y, z) => {
    const inZ = z >= -4 && z <= 4;
    const inX = x >= -4 && x <= 14;
    if (y === 63 || y === 69) return inX && inZ;
    if (y > 63 && y < 69) {
      return inX && inZ && (x === -4 || x === 14 || z === -4 || z === 4 || x === 5 || x === 6);
    }
    return false;
  });
  const map = buildRoomMap(sealed, [0.5, FEET, 0.5], TO_CAMERA);
  assert.equal(ceilingAt(map, 10.5, 0.5), Infinity, "the sealed room next door keeps its lid");
});

test('AN OPEN DOOR LETS THE ROOM THROUGH, because you really can see in', () => {
  const withDoor = worldOf((x, y, z) => {
    const inZ = z >= -4 && z <= 4;
    const inX = x >= -4 && x <= 14;
    if (y === 63 || y === 69) return inX && inZ;
    if (y > 63 && y < 69) {
      // A gap in the dividing wall at z=0, two blocks tall.
      if (x === 5) return !(z === 0 && y < 66);
      return inX && inZ && (x === -4 || x === 14 || z === -4 || z === 4);
    }
    return false;
  });
  const map = buildRoomMap(withDoor, [0.5, FEET, 0.5], TO_CAMERA);
  assert.equal(ceilingAt(map, 10.5, 0.5), FEET + 5, 'through the doorway is the same room to look at');
});

test('a character standing inside a block still gets a room, rather than none', () => {
  // A body being pushed out of geometry must not make the mode blink off for a frame.
  const odd: OpenTest = (x, y, z) => {
    if (x === 0 && y === FEET && z === 0) return false;   // the cell the feet are in is solid
    return !(y === 63 || y === 69 || (y > 63 && y < 69 && (x === -4 || x === 4 || z === -4 || z === 4)));
  };
  const map = buildRoomMap(odd, [0.5, FEET, 0.5], TO_CAMERA);
  assert.equal(ceilingAt(map, 1.5, 0.5), FEET + 5, 'the fill restarted at head height');
});

test('the patch is centred on the character and every byte is written each time', () => {
  const world = roomWorld(-4, 4, -4, 4);
  const a = buildRoomMap(world, [0.5, FEET, 0.5], TO_CAMERA);
  assert.equal(a.baseX, 0 - CEIL_SIZE / 2);
  assert.equal(a.baseY, FEET);
  // Reusing the buffer must not leave a previous room's answers behind: the indoor room's lid
  // heights must not survive into an outdoor patch, where nothing has a lid.
  assert.ok(a.bytes.some((v) => v < IN_ROOM_NO_LID), 'the indoor patch has lid heights in it');
  const b = buildRoomMap(worldOf((_x, y) => y < FEET), [0.5, FEET, 0.5], TO_CAMERA, a.bytes);
  assert.ok(!b.bytes.some((v) => v < IN_ROOM_NO_LID), 'and none of them survive the rebuild');
  assert.ok(b.bytes.every((v) => v === NO_CEILING || v === IN_ROOM_NO_LID), 'only outdoor answers');
});
