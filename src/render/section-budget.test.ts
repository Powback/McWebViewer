/**
 * The section budget: what gets meshed, what gets kept, and what a full budget throws out.
 *
 * THE REGRESSION THIS PINS. The viewer held every section within 256 blocks in every
 * direction and freed nothing until it was 640 blocks away — which, standing still at the
 * world spawn, is never. Measured on the deployed page: 6032 resident sections, 883 MB of
 * attribute arrays, 1040 MB JS heap, in under a minute without touching the controls, and
 * then the tab died and reloaded. Three quarters of it was behind the camera.
 *
 * So the two claims here are:
 *
 *   1. a section far away and behind you is not kept (and by the same function, not meshed)
 *   2. the resident bytes never exceed the ceiling, whatever the view contains
 *
 * (2) is the one that matters, because (1) is an angle and an angle has no idea how much
 * geometry a given cone holds — a mined-out settlement is many times the quads of the same
 * volume of hillside.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  KEEP_NEAR, MESH_CONE_DEG, KEEP_CONE_DEG, SECTION_HALF_DIAGONAL,
  DEFAULT_KEEP, DEFAULT_MESH, inViewCone, planRetention, sectionDistance, shouldKeep,
  shouldRecycle, worstScoreOf,
  type SectionRecord, type ViewPoint,
} from './section-budget.js';

/** Looking down -Z from the origin, which is three.js's default camera orientation. */
const north: ViewPoint = { eye: [0, 64, 0], forward: [0, 0, -1] };

const MB = 1024 * 1024;

function section(key: string, centre: [number, number, number], mb: number): SectionRecord {
  return { key, centre, bytes: mb * MB };
}

test('RETENTION IS BOUNDED BY THE CONE, because a sphere of `far` is unaffordable', () => {
  // The mistake this pins, because it was made deliberately and had to be undone within the hour.
  // Dropping the cone from retention to stop rotation re-meshing looks right and is ruinous: every
  // section within `far` in EVERY direction is a 640-block sphere, ~100x the sections a cone holds,
  // so the byte ceiling bites every frame and the viewer churns instead of settling. The anti-thrash
  // fix belongs in WHEN a section may be dropped (a grace period), not in which ones qualify.
  const behind: [number, number, number] = [0, 64, 300];
  const ahead: [number, number, number] = [0, 64, -300];
  assert.equal(shouldKeep(ahead, north, DEFAULT_MESH), true, 'ahead and in range: mesh it');
  assert.equal(shouldKeep(behind, north, DEFAULT_MESH), false, 'behind: not worth meshing yet');
  assert.equal(shouldKeep(ahead, north, DEFAULT_KEEP), true);
  assert.equal(shouldKeep(behind, north, DEFAULT_KEEP), false, 'and far behind is not kept either');
});

test('beyond `far` nothing is kept, whichever way it lies', () => {
  const wayOff: [number, number, number] = [0, 64, -5000];
  assert.equal(shouldKeep(wayOff, north, DEFAULT_KEEP), false);
});

test('everything within KEEP_NEAR survives whatever direction the camera faces', () => {
  // Straight up, straight down and directly behind, all inside the near radius. Spinning on
  // the spot must not dispose the room you are standing in: that is the one place a
  // re-mesh is guaranteed to be seen.
  for (const c of [[0, 64, 40], [0, 150, 0], [40, 64, 20], [-60, 64, 60]] as const) {
    assert.equal(sectionDistance(c, north.eye) <= KEEP_NEAR, true, `${c} should be near`);
    assert.equal(shouldKeep(c, north, DEFAULT_KEEP), true, `${c} should be kept`);
  }
});

test('the mesh cone is inside the keep cone, so nothing is built only to be dropped', () => {
  assert.ok(MESH_CONE_DEG < KEEP_CONE_DEG);
  // Walk the boundary: every direction the mesher will build is one the keeper will hold.
  for (let deg = 0; deg <= 180; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const d = 300;
    const c: [number, number, number] = [Math.sin(a) * d, 64, -Math.cos(a) * d];
    if (shouldKeep(c, north, DEFAULT_MESH)) {
      assert.equal(shouldKeep(c, north, DEFAULT_KEEP), true, `${deg} deg meshed but not kept`);
    }
  }
});

test('a section is judged by its corners, not its centre: the cone widens with the sphere', () => {
  // A centre just outside the cone whose near corner is inside it still counts, or the
  // corner pops in and out as the camera turns.
  const d = 200;
  const edge = (KEEP_CONE_DEG * Math.PI) / 180;
  const justOutside = edge + Math.asin(SECTION_HALF_DIAGONAL / d) * 0.5;
  const c: [number, number, number] = [Math.sin(justOutside) * d, 64, -Math.cos(justOutside) * d];
  assert.equal(inViewCone(c, north, KEEP_CONE_DEG), true);
  // ...and well past the widening it does not.
  const wayOut = edge + Math.asin(SECTION_HALF_DIAGONAL / d) * 4;
  const far: [number, number, number] = [Math.sin(wayOut) * d, 64, -Math.cos(wayOut) * d];
  assert.equal(inViewCone(far, north, KEEP_CONE_DEG), false);
});

test('the byte ceiling is never exceeded, however much geometry the view holds', () => {
  // 400 sections in a line straight ahead, 4 MB each: 1.6 GB of geometry all of it inside
  // the cone, so the cone alone cannot save this. Only the ceiling can.
  const records: SectionRecord[] = [];
  for (let i = 1; i <= 400; i++) records.push(section(`0,4,${-i}`, [0, 64, -i * 16], 4));
  const cap = 100 * MB;
  const plan = planRetention(records, north, DEFAULT_KEEP, cap);
  assert.ok(plan.keptBytes <= cap, `kept ${plan.keptBytes} > cap ${cap}`);
  assert.ok(plan.overBudget > 0, 'the ceiling should have been what bit');

  // And what survived is the NEAR end of the line, not an arbitrary slice of it.
  const dropped = new Set(plan.drop);
  const kept = records.filter((r) => !dropped.has(r.key));
  const worstKept = Math.max(...kept.map((r) => sectionDistance(r.centre, north.eye)));
  const bestDropped = Math.min(...records.filter((r) => dropped.has(r.key))
    .map((r) => sectionDistance(r.centre, north.eye)));
  assert.ok(worstKept <= bestDropped, 'kept a farther section than one it dropped');
});

test('the ceiling eats the periphery before it eats the view', () => {
  // Same distance, one ahead and one out to the side but still inside the keep cone. With
  // room for only one, the one in front of the camera is the one that stays.
  const ahead = section('ahead', [0, 64, -200], 60);
  const angle = ((KEEP_CONE_DEG - 5) * Math.PI) / 180;
  const side = section('side', [Math.sin(angle) * 200, 64, -Math.cos(angle) * 200], 60);
  assert.equal(shouldKeep(side.centre, north, DEFAULT_KEEP), true, 'fixture must be in cone');
  const plan = planRetention([ahead, side], north, DEFAULT_KEEP, 60 * MB);
  assert.deepEqual(plan.drop, ['side']);
});

test('a stable view drops nothing, so a standing camera does not thrash', () => {
  const records: SectionRecord[] = [];
  for (let i = 1; i <= 12; i++) records.push(section(`0,4,${-i}`, [0, 64, -i * 16], 1));
  const first = planRetention(records, north, DEFAULT_KEEP);
  assert.deepEqual(first.drop, []);
  const again = planRetention(records, north, DEFAULT_KEEP);
  assert.deepEqual(again.drop, []);
});

test('A FULL BUDGET CAN STILL BE RECYCLED: a better section buys out a worse one', () => {
  // THE DEADLOCK. The mesher stops at the ceiling and `planRetention` trims only what is
  // OVER it, so with the budget full of whatever the camera first looked at, a new
  // direction can never be paid for. Measured while spinning before `shouldRecycle`
  // existed: 2328 sections resident, zero disposed, 3322 queued, and the picture down to
  // 236k triangles at the angles that were never built.
  const stale = section('stale', [0, 64, 600], 100);        // 600 blocks behind
  const wanted: [number, number, number] = [0, 64, -200];   // 200 blocks straight ahead
  const worst = worstScoreOf([stale], north, DEFAULT_KEEP);
  assert.equal(shouldRecycle(wanted, north, DEFAULT_KEEP, worst), true);

  // ...and the trade actually happens once the cap is lowered by a frame's worth.
  const plan = planRetention([stale], north, DEFAULT_KEEP, 100 * MB - 12 * MB);
  assert.deepEqual(plan.drop, ['stale']);
});

test('nothing waiting is worth the trade at rest, so the budget is left alone', () => {
  // The resting state, and the one the user cares about: "the culling shouldnt completely
  // unload the chunks you are killing my fps man reloading these things all the fucking
  // time". A candidate no better than what is already there must NOT start a trade.
  const resident = [
    section('near', [0, 64, -100], 50),
    section('mid', [0, 64, -200], 50),
  ];
  const worst = worstScoreOf(resident, north, DEFAULT_KEEP);
  // Another section at the same distance as the worst: no better, so no trade.
  assert.equal(shouldRecycle([0, 64, -200], north, DEFAULT_KEEP, worst), false);
  // And one only marginally better is refused too, or two near-equal sections take turns
  // evicting each other every frame for ever.
  assert.equal(shouldRecycle([0, 64, -190], north, DEFAULT_KEEP, worst), false);
});

test('recycling converges: each trade lowers the worst score it must beat next time', () => {
  // Simulate the loop. Start with a budget full of geometry behind the camera, then queue
  // the same number of sections in front of it, one trade per round, and check it settles
  // rather than oscillating.
  const resident = new Map<string, SectionRecord>();
  for (let i = 1; i <= 20; i++) resident.set(`back${i}`, section(`back${i}`, [0, 64, i * 16], 10));
  const queue: Array<[number, number, number]> = [];
  for (let i = 1; i <= 20; i++) queue.push([0, 64, -i * 16]);
  const cap = 200 * MB;

  let trades = 0;
  for (let round = 0; round < 200 && queue.length; round++) {
    const worst = worstScoreOf(resident.values(), north, DEFAULT_KEEP);
    const want = queue[0];
    if (!shouldRecycle(want, north, DEFAULT_KEEP, worst)) break;
    const plan = planRetention(resident.values(), north, DEFAULT_KEEP, cap - 10 * MB);
    for (const key of plan.drop) resident.delete(key);
    resident.set(`front${round}`, section(`front${round}`, want, 10));
    queue.shift();
    trades++;
  }
  assert.ok(trades > 0, 'the loop never traded, so the deadlock is still there');
  // It stops on its own: once the queue holds nothing better than what is resident, the
  // rule says no and the loop rests. It must not have run to the 200-round guard.
  assert.ok(trades < 200, 'recycling never settled');
  // And the near-camera sections it built are the ones that survived.
  assert.ok([...resident.keys()].some((k) => k.startsWith('front')), 'nothing was ever built');
});
