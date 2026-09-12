/**
 * Behavioural tests for the movement predictor.
 *
 * These RUN the predictor against a stub world and assert what it does. The one claim that
 * matters most is the first test: that the very first frame after a keypress has already
 * moved. Everything else exists to make that safe rather than to make it true.
 *
 * The shapes here are the REAL ones — a slab really is [0,0,0,1,0.5,1] — because the whole
 * point of the physics extraction is that the controller no longer pretends every block is
 * a cube. `predict-physics.test.ts` checks the extracted table itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictedBody, NO_INTENT, axes, SEED_SPEED, type PredictIntent } from './predict.js';
import { FULL_CUBE, type BlockShapes } from './block-shapes.js';
import { FALLBACK_MOTION, type Box, type MotionConstants } from './physics.js';

/** The constants the extraction actually produced, so the tests exercise the real ones. */
const REAL: MotionConstants = {
  gravity: 0.08 * 400,
  jumpSpeed: 0.42 * 20,
  stepHeight: 0.6,
  halfWidth: 0.3,
  height: 1.8,
  eyeHeight: 1.62,
  sneakMultiplier: 0.3,
  sprintMultiplier: 1.3,
  reach: 4.5,
  measured: true,
};

const SLAB: readonly Box[] = [[0, 0, 0, 1, 0.5, 1]];

/**
 * Solid below y=64, plus whatever extra cells are named. `cells` maps "x,y,z" to a shape,
 * so a test can put a slab or a fence post exactly where it wants one.
 */
function worldOf(cells: Record<string, readonly Box[]> = {}): BlockShapes {
  return {
    boxesAt(x, y, z) {
      const own = cells[`${x},${y},${z}`];
      const local = own ?? (y < 64 ? FULL_CUBE : undefined);
      if (!local) return [];
      return local.map((b) => [b[0] + x, b[1] + y, b[2] + z, b[3] + x, b[4] + y, b[5] + z] as Box);
    },
    hardnessAt: () => null,
    known: () => true,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
}

function intent(over: Partial<PredictIntent>): PredictIntent {
  return { ...NO_INTENT, ...over };
}

/** Standing on the ground at the origin, settled. */
function standing(shapes: BlockShapes = worldOf()): PredictedBody {
  const body = new PredictedBody(shapes, REAL);
  body.reset([0.5, 64, 0.5]);
  for (let i = 0; i < 10; i++) body.step(1 / 60, NO_INTENT, 0);
  return body;
}

// ---------------------------------------------------------------------------
// The whole point.

test('the FIRST frame after a keypress has already moved — this is the feature', () => {
  const body = standing();
  const before = body.position;
  // yaw 0 in three.js faces -Z, which is the direction the raycast uses too.
  body.step(1 / 60, intent({ forward: true }), 0);
  const after = body.position;
  const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
  assert.ok(moved > 0.05, `first frame moved only ${moved} blocks — there is still input delay`);
  assert.ok(after[2] < before[2], 'forward at yaw 0 must go towards -Z, as the raycast does');
});

test('a second of walking covers about a second of walking', () => {
  const body = standing();
  const before = body.position;
  for (let i = 0; i < 60; i++) body.step(1 / 60, intent({ forward: true }), 0);
  const covered = Math.abs(body.position[2] - before[2]);
  assert.ok(covered > SEED_SPEED * 0.8 && covered < SEED_SPEED * 1.2,
    `covered ${covered} blocks in a second at a seed speed of ${SEED_SPEED}`);
});

test('sprint and sneak scale the speed by the extracted multipliers', () => {
  const run = (over: Partial<PredictIntent>) => {
    const body = standing();
    const before = body.position;
    for (let i = 0; i < 60; i++) body.step(1 / 60, intent({ forward: true, ...over }), 0);
    return Math.abs(body.position[2] - before[2]);
  };
  const walk = run({});
  assert.ok(Math.abs(run({ sprint: true }) / walk - REAL.sprintMultiplier) < 0.02, 'sprint is not x1.3');
  assert.ok(Math.abs(run({ sneak: true }) / walk - REAL.sneakMultiplier) < 0.02, 'sneak is not x0.3');
});

// ---------------------------------------------------------------------------
// Collision against REAL shapes.

test('a wall stops the body instead of being walked through', () => {
  const body = standing(worldOf({ '0,64,-1': FULL_CUBE, '0,65,-1': FULL_CUBE }));
  for (let i = 0; i < 120; i++) body.step(1 / 60, intent({ forward: true }), 0);
  const z = body.position[2];
  assert.ok(z > -1 + 0.3 - 1e-3, `walked into the wall cell: z=${z}`);
  assert.ok(z < 0.5, 'did not move towards the wall at all');
});

test('a blocked axis still slides along the other one', () => {
  const body = standing(worldOf({ '0,64,-1': FULL_CUBE, '0,65,-1': FULL_CUBE }));
  const before = body.position;
  for (let i = 0; i < 30; i++) body.step(1 / 60, intent({ forward: true, right: true }), 0);
  assert.ok(Math.abs(body.position[0] - before[0]) > 0.5,
    'a diagonal into a wall stuck completely instead of sliding');
});

test('a SLAB is stepped onto, because its real shape is half a block', () => {
  // This is the test the old whole-cube model could not pass: it is exactly the case where
  // pretending every block is a cube turns a step into a wall. A RUN of slabs, not one, so
  // the body is still standing on them at the end rather than having walked off the far
  // side onto the ordinary ground.
  const slabs: Record<string, readonly Box[]> = {};
  for (let z = -1; z >= -8; z--) slabs[`0,64,${z}`] = SLAB;
  const body = standing(worldOf(slabs));
  for (let i = 0; i < 60; i++) body.step(1 / 60, intent({ forward: true }), 0);
  assert.ok(body.position[2] < -1, `stopped at z=${body.position[2]} instead of walking onto the slab`);
  assert.ok(body.position[2] > -8, 'walked off the far end of the slabs; the test is not measuring a step');
  assert.ok(Math.abs(body.position[1] - 64.5) < 0.02,
    `ended at y=${body.position[1]}, expected to be standing on the slab top at 64.5`);
});

test('a full block is NOT stepped onto — that still needs a jump', () => {
  const body = standing(worldOf({ '0,64,-1': FULL_CUBE }));
  for (let i = 0; i < 90; i++) body.step(1 / 60, intent({ forward: true }), 0);
  assert.ok(Math.abs(body.position[1] - 64) < 0.02,
    `climbed a full block to y=${body.position[1]} without jumping`);
});

test('gravity lands the body on the ground and leaves it there', () => {
  const body = new PredictedBody(worldOf(), REAL);
  body.reset([0.5, 70, 0.5]);
  for (let i = 0; i < 300; i++) body.step(1 / 60, NO_INTENT, 0);
  assert.ok(Math.abs(body.position[1] - 64) < 0.02,
    `settled at y=${body.position[1]}, expected the surface at 64`);
  assert.equal(body.stats().onGround, true);
});

test('the jump peaks where the real jump strength says it should', () => {
  const body = standing();
  body.step(1 / 60, intent({ jump: true }), 0);
  assert.equal(body.stats().onGround, false, 'still grounded on the frame the jump was pressed');
  let peak = 64;
  for (let i = 0; i < 120; i++) {
    body.step(1 / 60, NO_INTENT, 0);
    peak = Math.max(peak, body.position[1]);
  }
  // v^2 / 2g with the extracted numbers: 8.4^2 / (2*32) = 1.1025 blocks.
  const expected = (REAL.jumpSpeed * REAL.jumpSpeed) / (2 * REAL.gravity);
  assert.ok(Math.abs((peak - 64) - expected) < 0.08,
    `jump peaked at ${peak - 64}, the extracted constants say ${expected}`);
  assert.ok(Math.abs(body.position[1] - 64) < 0.02, 'did not come back down to the ground');
});

/**
 * THE STREAMING EDGE, WHICH HAS TO BE GOT RIGHT IN BOTH DIRECTIONS AT ONCE.
 *
 * A chunk that has not arrived yet is not a wall — guessing "wall" freezes the player
 * against thin air with nothing on screen to explain it. And it is not a hole either, which
 * is the half that was missing: `World.getState` answers AIR outside the loaded chunks, so
 * `boxesAt` returned nothing there, so the body fell straight through the floor of every
 * chunk it out-ran, kept accelerating (nothing below was loaded either), and the teleport
 * that drives the server's bot followed it into the void. Reported from the live server as
 * "it keeps falling into holes and getting stuck" — and the "stuck" is the same event, since
 * once the body is under the world there is nothing to land on and the server's position is
 * only ever what we last teleported it to.
 *
 * So: passable, and not fallen through. One test, because fixing either one alone is how
 * this got broken.
 */
test('AN UNKNOWN CELL IS NOT A HOLE, AND NOT A DOORWAY EITHER', () => {
  // This test used to assert the opposite of its horizontal half, and the change is a genuine
  // reversal worth recording rather than a correction.
  //
  // The original reasoning: guessing "wall" at the streaming edge freezes the player against thin
  // air with nothing on screen to explain it, so unknown was made passable horizontally while
  // downward motion waited for the ground. That is sound in the abstract and was wrong in practice
  // -- it is the whole of "theres nothing preventing me from walking through walls in 1p" (the
  // user, 2026-09-11). Measured: 63.5 to 79.70 in four seconds, straight through a wall at x=66
  // whose chunk had not arrived, and full-speed travel across an entirely empty world.
  //
  // What tips it is HOW FAR AWAY the streaming edge normally is: chunks are unloaded at 24 chunks,
  // 384 blocks, so in a healthy viewer this guard never fires at all. It only bites when data is
  // missing next to the player, which is precisely the state in which walking on is wrong. The
  // freeze it risks is bounded by how fast a chunk arrives; the alternative is unbounded.
  //
  // The PLANNER keeps the old rule -- see nav-world.ts. There the cost is reversed: a route that
  // detours around an unseen wall still arrives, and one planned into a wall does not.
  const unloaded: BlockShapes = {
    boxesAt: () => [],
    hardnessAt: () => null,
    known: () => false,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
  const body = new PredictedBody(unloaded, REAL);
  body.reset([0.5, 64, 0.5]);
  const before = body.position;

  for (let i = 0; i < 120; i++) body.step(1 / 60, intent({ forward: true }), 0);

  assert.ok(Math.abs(body.position[2] - before[2]) < 0.01,
    `it walked ${Math.abs(body.position[2] - before[2]).toFixed(2)} blocks into terrain nobody has loaded`);
  assert.equal(body.position[1], before[1],
    `it fell to y=${body.position[1].toFixed(2)} through ground nobody has loaded yet`);
  assert.equal(body.stats().onGround, true, 'and it is standing, not falling');
});

test('once the chunk arrives, the body falls again like anything else', () => {
  // The hover is a WAIT, not a new way to stand in mid-air: the moment the world can answer
  // the question, ordinary gravity resumes. Without this the fix would be a player who
  // floats over any hole the viewer happens not to have meshed.
  let loaded = false;
  const streaming: BlockShapes = {
    boxesAt: () => [],
    hardnessAt: () => null,
    known: () => loaded,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
  const body = new PredictedBody(streaming, REAL);
  body.reset([0.5, 64, 0.5]);
  for (let i = 0; i < 60; i++) body.step(1 / 60, NO_INTENT, 0);
  assert.equal(body.position[1], 64, 'it waited');

  loaded = true;
  for (let i = 0; i < 60; i++) body.step(1 / 60, NO_INTENT, 0);
  assert.ok(body.position[1] < 63, `it has to fall once the world says there is nothing there,`
    + ` got y=${body.position[1].toFixed(2)}`);
});

/**
 * THE CHARACTER FELL OUT OF THE WORLD, and one slow frame was all it took.
 *
 * Collision is resolved by BISECTION: move the whole way, ask whether that is blocked, halve
 * back if it is. A bisection can only find a collision the END of the move is inside — land
 * past a floor, in the open air underneath it, and the floor was never there. Falling is the
 * only motion fast enough for that to matter: terminal speed is 60 blocks/s and `step`
 * clamps dt at 0.1, so one hitched frame asks for six blocks of travel in a single check,
 * through a one-block floor with a 1.8-block body.
 *
 * It was not a cosmetic glitch. Nothing below the floor is solid either, so the body kept
 * going, and `LiveView.pushPosition` teleported the SERVER's bot down after it into the
 * void — where there is nothing to land on and nothing to bring it back. Reported from the
 * live server as "it keeps falling into holes and getting stuck".
 *
 * Measured across the phase of the fall, because whether a given step straddles the floor
 * is luck: a single drop passing proves nothing, which is why this runs a hundred of them.
 */
test('a slow frame does not drop the body through a solid floor', () => {
  const floor: BlockShapes = {
    boxesAt: (x, y, z) => (y === 63 ? [[x, y, z, x + 1, y + 1, z + 1] as Box] : []),
    hardnessAt: () => null,
    known: () => true,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
  // 17 ms is a healthy frame and 100 ms is the clamp — a viewer meshing a batch of chunks
  // sits between them, which is exactly where this used to fail (5/100 at 50 ms, 32/100 at
  // 67 ms) and exactly where a test that only ran at 60 fps would never have looked.
  for (const dt of [1 / 60, 1 / 30, 1 / 20, 1 / 15, 0.1]) {
    let through = 0;
    for (let k = 0; k < 100; k++) {
      const body = new PredictedBody(floor, REAL);
      // Started high enough to be at terminal velocity on arrival, and nudged by a fraction
      // of a block each time so the sweep lands at a different phase of the floor.
      body.reset([0.5, 200 + k * 0.037, 0.5]);
      for (let i = 0; i < 600; i++) body.step(dt, NO_INTENT, 0);
      if (body.position[1] < 60) through++;
    }
    assert.equal(through, 0,
      `at a ${(dt * 1000).toFixed(0)} ms frame the body fell through the floor ${through}/100 times`);
  }
});

/**
 * A BODY INSIDE A BLOCK HAS TO BE ABLE TO GET OUT, and before this it never could.
 *
 * The collision resolver moves and then halves back until it is clear. Start it already
 * overlapping geometry and every candidate position is blocked, the bisection collapses to
 * zero, and the character is frozen permanently — it cannot walk out, jump out or fall out.
 *
 * It gets there for real: a resync or a teleport snaps the position outright, and the world
 * it collides against is streamed, so the body can be put inside a block without ever having
 * walked into one. Observed on the live server: the bot standing still with its intent
 * reading forward+jump, hopping on the spot for eight seconds, travelling zero blocks, and
 * the walk reporting "stuck".
 */
test('a body that ends up inside a block can walk out of it', () => {
  // Solid everywhere below y=64 AND a pillar filling the cell the body is standing in.
  const buried: BlockShapes = {
    boxesAt: (x, y, z) => ((y < 64 || (x === 0 && z === 0 && y < 66))
      ? [[x, y, z, x + 1, y + 1, z + 1] as Box] : []),
    hardnessAt: () => null,
    known: () => true,
    coverage: () => ({ extracted: 0, model: 0, heuristic: 0 }),
  };
  const body = new PredictedBody(buried, REAL);
  body.reset([0.5, 64, 0.5]);          // inside the pillar

  for (let i = 0; i < 120; i++) body.step(1 / 60, intent({ forward: true }), 0);

  assert.ok(body.position[2] < -0.5,
    `the body never escaped the block it was inside: z=${body.position[2].toFixed(2)}`);
  // ...and once out, collision is ordinary again: it is standing on the floor, not sunk
  // through it, and it has not walked back into the pillar.
  assert.ok(Math.abs(body.position[1] - 64) < 0.05,
    `it should be standing on the floor, got y=${body.position[1].toFixed(2)}`);
});

test('the eye sits at the extracted eye height above the feet', () => {
  const body = standing();
  assert.ok(Math.abs(body.eye[1] - (body.position[1] + REAL.eyeHeight)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Reconciliation.

test('a small disagreement is absorbed smoothly, never snapped', () => {
  const body = standing();
  const start = body.position;
  const target: [number, number, number] = [start[0] + 0.4, start[1], start[2]];
  body.reconcile(target, 1 / 60);
  const step = body.position[0] - start[0];
  assert.ok(step > 0 && step < 0.1, `one frame of reconciliation moved ${step} blocks — that is a snap`);
  assert.equal(body.stats().resyncs, 0);
  for (let i = 0; i < 180; i++) body.reconcile(target, 1 / 60);
  assert.ok(body.stats().drift < 0.02, 'a persistent offset was never worked off');
});

test('a teleport-sized disagreement snaps and is counted', () => {
  const body = standing();
  body.reconcile([500, 64, -500], 1 / 60);
  assert.deepEqual(body.position.map(Math.round), [500, 64, -500]);
  assert.equal(body.stats().resyncs, 1, 'a hard resync must be counted, not silent');
});

test('reconciliation does not erase the lead during the round trip', () => {
  // The server has not started moving yet; we have. One round trip of pull must leave most
  // of the predicted lead intact, or the prediction is pointless.
  const body = standing();
  const serverPos = body.position;
  for (let i = 0; i < 9; i++) {
    body.step(1 / 60, intent({ forward: true }), 0);
    body.reconcile(serverPos, 1 / 60);
  }
  const lead = Math.abs(body.position[2] - serverPos[2]);
  assert.ok(lead > 0.3, `only ${lead} blocks of lead survived 150 ms — the pull is too strong`);
});

// ---------------------------------------------------------------------------
// Speed calibration: measured from the server, never asserted.

test('speed is learned from the server rather than trusted from a constant', () => {
  const body = standing();
  assert.equal(body.stats().calibrations, 0, 'starts uncalibrated');
  // A server that walks at 6 blocks/s (soul speed, a mod, a potion — it does not matter).
  const real = 6;
  let z = 0;
  let at = 1000;
  const walking = intent({ forward: true });
  for (let i = 0; i < 40; i++) {
    body.observe([0, 64, z], at, walking);
    z -= real * 0.1;
    at += 100;
  }
  const learned = body.stats().speed;
  assert.ok(Math.abs(learned - real) < 0.3, `learned ${learned}, the server actually does ${real}`);
});

test('samples that cannot be a clean walk are ignored, not averaged in', () => {
  const body = standing();
  const both = intent({ forward: true, left: true });
  let at = 1000;
  for (let i = 0; i < 20; i++) {
    body.observe([0, 64, -i * 0.6], at, both);
    at += 100;
  }
  assert.equal(body.stats().calibrations, 0, 'a two-key diagonal was used as a speed measurement');
  assert.equal(body.stats().speed, SEED_SPEED);
});

test('a teleport between samples does not poison the measured speed', () => {
  const body = standing();
  const walking = intent({ forward: true });
  body.observe([0, 64, 0], 1000, walking);
  body.observe([0, 64, -900], 1100, walking);
  assert.equal(body.stats().calibrations, 0, 'a 900-block jump was taken as a speed sample');
});

// ---------------------------------------------------------------------------
// Honesty about where the constants came from.

test('a body with no physics table says its constants are NOT measured', () => {
  const body = new PredictedBody(worldOf(), FALLBACK_MOTION);
  body.reset([0.5, 64, 0.5]);
  assert.equal(body.stats().measured, false, 'fallback constants must not claim to be the game\'s');
  assert.equal(standing().stats().measured, true);
});

// ---------------------------------------------------------------------------
// The direction convention, which this project has been bitten by before.

test('axes agree with the raycast forward vector at every quarter turn', () => {
  const fwd = intent({ forward: true });
  const cases: Array<[number, [number, number]]> = [
    [0, [0, -1]],
    [Math.PI / 2, [-1, 0]],
    [Math.PI, [0, 1]],
    [-Math.PI / 2, [1, 0]],
  ];
  for (const [yaw, want] of cases) {
    const [x, z] = axes(fwd, yaw);
    assert.ok(Math.abs(x - want[0]) < 1e-9 && Math.abs(z - want[1]) < 1e-9,
      `yaw ${yaw}: got [${x}, ${z}], the raycast would use [${want[0]}, ${want[1]}]`);
  }
});

test('strafing is perpendicular to forward and normalised', () => {
  const [fx, fz] = axes(intent({ forward: true }), 0.7);
  const [rx, rz] = axes(intent({ right: true }), 0.7);
  assert.ok(Math.abs(fx * rx + fz * rz) < 1e-9, 'right is not perpendicular to forward');
  assert.ok(Math.abs(Math.hypot(rx, rz) - 1) < 1e-9, 'right is not a unit vector');
  const [dx, dz] = axes(intent({ forward: true, right: true }), 0.7);
  assert.ok(Math.abs(Math.hypot(dx, dz) - 1) < 1e-9,
    'a diagonal is faster than a straight line — the classic un-normalised bug');
});

test('no keys is no movement', () => {
  assert.deepEqual(axes(NO_INTENT, 1.23), [0, 0]);
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE TEST: walking speed in blocks per REAL second.
//
// The bug this guards against: movement was issued as a stateful command the server applied
// PER TICK, so displacement per real second scaled with the tick rate. This world targets
// 200 ticks/s and actually manages about 145, against vanilla's 20 — so the player walked
// roughly seven times too fast, and wobbled with server load.
//
// Local simulation integrates real seconds, so the speed must come out the same whatever
// the server is doing. These drive a server that is correct, 7x too fast, struggling and
// fluctuating, and measure blocks per real second each time.

/** Walk for `seconds` of real time with a server moving at `serverFactor` x real speed. */
function walkWithServer(serverFactor: number, seconds: number, jitter = 0): number {
  const body = new PredictedBody(worldOf(), REAL);
  const start: [number, number, number] = [0.5, 64, 0.5];
  body.reset(start);
  const dt = 1 / 60;
  const held = intent({ forward: true });
  // The server's own idea of where the player is, advancing at its (wrong) rate.
  const server: [number, number, number] = [...start];
  let now = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    now += dt * 1000;
    body.step(dt, held, 0);
    const wobble = jitter ? 1 + ((i * 7919) % 100) / 100 * jitter - jitter / 2 : 1;
    server[2] -= SEED_SPEED * serverFactor * wobble * dt;
    body.reconcile(server, dt, now);
  }
  return Math.abs(body.position[2] - start[2]) / seconds;
}

test('ACCEPTANCE: walking speed is the same whatever the server tick rate', () => {
  const correct = walkWithServer(1, 3);
  const fast = walkWithServer(7.25, 3);       // this world: ~145 tps against vanilla's 20
  const slow = walkWithServer(0.4, 3);        // a server falling behind
  const struggling = walkWithServer(7.25, 3, 0.6); // fast AND fluctuating under load

  for (const [name, got] of [['correct', correct], ['fast', fast], ['slow', slow], ['struggling', struggling]] as const) {
    assert.ok(Math.abs(got - SEED_SPEED) < 0.4,
      `${name} server: ${got.toFixed(2)} blocks/s, expected about ${SEED_SPEED}`);
  }
  // And they must agree with EACH OTHER, which is the actual requirement.
  const spread = Math.max(correct, fast, slow, struggling) - Math.min(correct, fast, slow, struggling);
  assert.ok(spread < 0.3,
    `walking speed varied by ${spread.toFixed(2)} blocks/s across tick rates (${correct.toFixed(2)}/${fast.toFixed(2)}/${slow.toFixed(2)}/${struggling.toFixed(2)})`);
});

test('a 7x-too-fast server is judged IMPLAUSIBLE and stops dragging the camera', () => {
  const body = new PredictedBody(worldOf(), REAL);
  body.reset([0.5, 64, 0.5]);
  const server: [number, number, number] = [0.5, 64, 0.5];
  let now = 0;
  for (let i = 0; i < 120; i++) {
    now += (1 / 60) * 1000;
    body.step(1 / 60, intent({ forward: true }), 0);
    server[2] -= SEED_SPEED * 7.25 * (1 / 60);
    body.reconcile(server, 1 / 60, now);
  }
  const s = body.stats();
  assert.equal(s.serverPlausible, false, 'a 7x server must be reported as implausible');
  assert.ok(s.serverSpeed > SEED_SPEED * 4, `serverSpeed ${s.serverSpeed} should reflect the real rate`);
  assert.equal(s.resyncs, 0, 'an implausible server must not be allowed to snap the camera');
});

test('a NORMAL server is still plausible and still reconciles', () => {
  // The fix must not throw away reconciliation on a healthy server.
  const body = new PredictedBody(worldOf(), REAL);
  body.reset([0.5, 64, 0.5]);
  const server: [number, number, number] = [0.5, 64, 0.5];
  let now = 0;
  for (let i = 0; i < 120; i++) {
    now += (1 / 60) * 1000;
    body.step(1 / 60, intent({ forward: true }), 0);
    server[2] -= SEED_SPEED * (1 / 60);
    body.reconcile(server, 1 / 60, now);
  }
  assert.equal(body.stats().serverPlausible, true);
  assert.ok(body.stats().drift < 0.6, `drift ${body.stats().drift} on a healthy server`);
});

test('a real TELEPORT is still honoured even while the server is implausible', () => {
  // The one correction that must survive: the player really is somewhere else.
  const body = new PredictedBody(worldOf(), REAL);
  body.reset([0.5, 64, 0.5]);
  const server: [number, number, number] = [0.5, 64, 0.5];
  let now = 0;
  for (let i = 0; i < 60; i++) {
    now += (1 / 60) * 1000;
    body.step(1 / 60, intent({ forward: true }), 0);
    server[2] -= SEED_SPEED * 7.25 * (1 / 60);
    body.reconcile(server, 1 / 60, now);
  }
  assert.equal(body.stats().serverPlausible, false);
  now += 100;
  body.reconcile([2000, 64, 2000], 1 / 60, now);
  assert.ok(Math.abs(body.position[0] - 2000) < 1, 'a teleport was ignored');
});
