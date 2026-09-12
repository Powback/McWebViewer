/**
 * A BODY DOES NOT WALK THROUGH WALLS.
 *
 * Movement is local-simulation plus `tp`, and A TELEPORT IGNORES SERVER COLLISION — so this
 * simulation is the only thing standing between the character and the inside of a wall. There is
 * no second line of defence to catch a mistake here.
 *
 * Written after "theres nothing preventing me from walking through walls in 1p" (the user,
 * 2026-09-11), which turned out to be a question about WHICH DRIVER was on rather than about the
 * physics: with neither driver bound, main.ts falls through to the free-fly camera, which has no
 * collision by design. The HUD says so now. These pin the half that was never in doubt so that it
 * cannot quietly become the half that is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PredictedBody } from './predict.js';
import { blockShapes } from './block-shapes.js';
import { navWorld } from './nav-world.js';

const FLOOR = 64;

/** A world with a floor below FLOOR, and solid wherever `wall` says so. */
function worldWith(wall: (x: number, y: number, z: number) => boolean) {
  const world = {
    palette: ['minecraft:air', 'minecraft:cobblestone'],
    minY: -64,
    maxY: 320,
    getState: (x: number, y: number, z: number) => (y < FLOOR || wall(x, y, z) ? 1 : 0),
    getChunk: () => ({}),
  } as never;
  return blockShapes(world, navWorld(world), null);
}

/** Hold one intent for `frames` at 60 Hz and report where the body ends up. */
function walk(
  shapes: ReturnType<typeof worldWith>,
  from: [number, number, number],
  intent: Partial<Record<'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint', boolean>>,
  yaw: number,
  frames = 240,
): [number, number, number] {
  const body = new PredictedBody(shapes);
  body.reset(from);
  const full = {
    forward: false, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false, ...intent,
  } as never;
  for (let i = 0; i < frames; i++) body.step(1 / 60, full, yaw);
  return body.position;
}

/** yaw looking east (+X): forward = (-sin, -cos), so -pi/2 gives (1, 0). */
const EAST = -Math.PI / 2;

test('WALKING INTO A WALL STOPS AT ITS FACE, not somewhere inside it', () => {
  const shapes = worldWith((x, y) => x >= 66 && y < FLOOR + 6);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true }, EAST);
  // The body is 0.6 wide, so its centre stops 0.3 short of the wall at x=66.
  assert.ok(Math.abs(end[0] - 65.7) < 0.01, `stopped at ${end[0].toFixed(3)}, wanted 65.700`);
  assert.ok(end[0] < 66, 'and never reached the wall itself');
});

test('SPRINTING DOES NOT PUNCH THROUGH — speed must not defeat the resolver', () => {
  // The sweep is a bisection, and a bisection only finds a collision the END of the move is
  // inside. Faster moves are the ones that can step clean over a wall, so they get their own case.
  const shapes = worldWith((x, y) => x >= 66 && y < FLOOR + 6);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true, sprint: true }, EAST);
  assert.ok(end[0] < 66, `sprinted to ${end[0].toFixed(3)}, which is inside the wall`);
});

test('A ONE-BLOCK WALL IS NOT A STEP: a full block must be jumped, not walked up', () => {
  // Step height is 0.6, so a full block stops the body. Getting this wrong would let the
  // character climb every wall in the settlement as if it were a kerb.
  const shapes = worldWith((x, y) => x >= 66 && y === FLOOR);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true }, EAST);
  assert.ok(end[0] < 66, `walked up a full block to ${end[0].toFixed(3)}`);
  assert.ok(Math.abs(end[1] - FLOOR) < 0.01, 'and stayed at floor level');
});

test('A THIN WALL IS STILL A WALL, even one block thick with open air behind it', () => {
  // The case a swept resolver is most likely to miss: nothing on the far side to stop it.
  const shapes = worldWith((x, y) => x === 66 && y < FLOOR + 6);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true, sprint: true }, EAST);
  assert.ok(end[0] < 66, `passed through a 1-thick wall to ${end[0].toFixed(3)}`);
});

test('the floor holds the body up rather than letting it sink', () => {
  const shapes = worldWith(() => false);
  const end = walk(shapes, [64.5, FLOOR + 3, 0.5], {}, EAST);
  assert.ok(Math.abs(end[1] - FLOOR) < 0.01, `fell to ${end[1].toFixed(3)}, wanted ${FLOOR}`);
});

test('and open air is still walkable, so this is not just "nothing ever moves"', () => {
  // The assertion that keeps the others honest: a resolver that blocked everything would pass
  // every test above.
  const shapes = worldWith(() => false);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true }, EAST, 60);
  assert.ok(end[0] > 66, `walked only to ${end[0].toFixed(3)} across open ground`);
});

/**
 * UNLOADED TERRAIN IS NOT A DOORWAY.
 *
 * `boxesAt` returns nothing for a chunk the viewer has not streamed in, so before this the body
 * walked through whatever an unloaded chunk contained — measured at 63.5 to 79.70 in four seconds
 * straight through a wall at x=66 whose chunk was missing, and at full speed across an entirely
 * empty world. Downward motion had been guarded against exactly this ("the player sinks through
 * the floor"); horizontal motion had not ("theres nothing preventing me from walking through walls
 * in 1p"). Both reports, 2026-09-11, and only one half was fixed at the time.
 */

/** A world whose chunks are present only where `loaded` says so. */
function partlyStreamed(
  solid: (x: number, y: number, z: number) => boolean,
  loaded: (cx: number, cz: number) => boolean,
) {
  const world = {
    palette: ['minecraft:air', 'minecraft:cobblestone'],
    minY: -64,
    maxY: 320,
    getState: (x: number, y: number, z: number) => (y < FLOOR || solid(x, y, z) ? 1 : 0),
    getChunk: (cx: number, cz: number) => (loaded(cx, cz) ? ({} as never) : undefined),
  } as never;
  return blockShapes(world, navWorld(world), null);
}

test('A WALL IN AN UNLOADED CHUNK STILL STOPS THE BODY', () => {
  // The wall is at x=66, in chunk 4, which has not arrived. Without the guard the body sailed
  // through it because an unloaded cell reports no collision box at all.
  const shapes = partlyStreamed((x, y) => x >= 66 && y < FLOOR + 6, (cx) => cx !== 4);
  const end = walk(shapes, [63.5, FLOOR, 0.5], { forward: true }, EAST);
  assert.ok(end[0] < 64, `walked into the unloaded chunk to ${end[0].toFixed(2)}`);
});

test('AN EMPTY WORLD IS NOT AN OPEN FIELD: the body waits rather than running off', () => {
  // What the page looks like in the window after a reload, before any chunk is back.
  const shapes = partlyStreamed(() => false, () => false);
  const end = walk(shapes, [64.5, FLOOR, 0.5], { forward: true }, EAST);
  assert.ok(Math.abs(end[0] - 64.5) < 0.01, `ran to ${end[0].toFixed(2)} across nothing`);
  // And it must not fall either -- the vertical guard, which was already there.
  assert.ok(Math.abs(end[1] - FLOOR) < 0.01, `sank to ${end[1].toFixed(2)}`);
});

test('but a LOADED world still walks normally, so this is not a freeze', () => {
  // The assertion that keeps the two above honest: a guard that refused everything would pass
  // both, and would be the "frozen against thin air" failure the planner's rule exists to avoid.
  const shapes = partlyStreamed((x, y) => x >= 66 && y < FLOOR + 6, () => true);
  const end = walk(shapes, [63.5, FLOOR, 0.5], { forward: true }, EAST);
  assert.ok(Math.abs(end[0] - 65.7) < 0.01, `stopped at ${end[0].toFixed(2)}, wanted 65.70`);
});

test('walking AWAY from an unloaded chunk is allowed, not just into it', () => {
  // Standing on the boundary must not refuse every move, including the one that escapes.
  const shapes = partlyStreamed(() => false, (cx) => cx <= 3);
  const end = walk(shapes, [63.5, FLOOR, 0.5], { forward: true }, -EAST, 60);
  assert.ok(end[0] < 63.4, `could not walk back west, ended at ${end[0].toFixed(2)}`);
});
