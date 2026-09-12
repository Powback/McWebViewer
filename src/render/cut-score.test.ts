/**
 * Tests for the cut-plane search.
 *
 * These run the scorer against hand-built worlds whose right answer is known by construction, so
 * "put the plane in the air gap" is checked rather than asserted. The shape under test is the one
 * the user found by hand: a plane the cast put at 9 leaves floaters, and one at ~6 does not, and
 * nothing about the wall distance alone says which is which.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestCandidate, cutScore, shouldAdopt, type OpenTest, type Ray } from './cut-score.js';

/** One ray straight along +X, which is all the geometry below varies in. */
const EAST: Ray[] = [{ dx: 1, dz: 0 }];
const FROM: [number, number, number] = [0.5, 64, 0.5];

/** Solid where `solid(x)` says so, for every y and z: a world that only varies along X. */
const along = (solid: (x: number) => boolean): OpenTest => (x) => !solid(x);

test('a plane landing in AIR scores zero — you are looking into a room', () => {
  // Wall at x=10..11, open room beyond. A plane at 5 is in open air.
  const w = along((x) => x >= 10 && x <= 11);
  assert.equal(cutScore(w, FROM, EAST, 5), 0);
});

test('a plane landing on a wall face whose outside is AIR scores zero', () => {
  // The plane lands on x=10; the cut removed x=11 -- but x=11 is air, so the face at 10 is one the
  // mesher actually built. This is a clean cut, not a floater.
  const w = along((x) => x === 10);
  assert.equal(cutScore(w, FROM, EAST, 10), 0);
});

test('A PLANE BURIED INSIDE SOLID SCORES ONE — this is the floater', () => {
  // A three-thick wall, plane in the middle of it. The face you would see at x=10 sits between two
  // solid blocks, so it was never meshed: void.
  const w = along((x) => x >= 9 && x <= 11);
  assert.equal(cutScore(w, FROM, EAST, 10), 1);
});

test('THE USER\'S CASE: the cast\'s answer scores worse than the one they tuned by hand', () => {
  // A room from x=0..7, its near wall 8..11 (four thick, as this settlement builds), open beyond.
  // The cast stops at the wall's near face and adds its bias, landing inside the wall at ~9.
  // Moving the plane back into the room lands it in air.
  const w = along((x) => x >= 8 && x <= 11);
  assert.equal(cutScore(w, FROM, EAST, 9), 1, 'buried in the wall: floaters');
  assert.equal(cutScore(w, FROM, EAST, 6.3), 0, 'in the room: clean');
  const best = bestCandidate([
    { bias: 9, score: cutScore(w, FROM, EAST, 9) },
    { bias: 6.3, score: cutScore(w, FROM, EAST, 6.3) },
  ]);
  assert.equal(best?.bias, 6.3, 'the search picks what the user picked by hand');
});

test('every ray counts, so one gap does not excuse a wall', () => {
  // Three rays, two into a thick wall and one through a doorway. The doorway ray is clean; the
  // other two are not, and the score says 2 rather than being rescued by the good one.
  const rays: Ray[] = [{ dx: 1, dz: 0 }, { dx: 1, dz: 0 }, { dx: 1, dz: 0 }];
  const w: OpenTest = (x, _y, z) => (z === 5 ? true : !(x >= 9 && x <= 11));
  const from: [number, number, number] = [0.5, 64, 0.5];
  assert.equal(cutScore(w, from, rays, 10), 3, 'all three rays are at z=0 here');
  // Move one ray into the doorway by giving it a z component that lands on z=5.
  assert.equal(cutScore(w, [0.5, 64, 5.5], rays, 10), 0, 'the doorway column is clean');
});

test('among equally clean planes the search takes the one that reveals MORE', () => {
  // A bigger bias pulls the plane towards the camera and spares more, so a tie must go to the
  // smaller one -- otherwise the search would pick a plane so near the camera it cuts nothing
  // and scores a perfect zero for doing nothing at all.
  const best = bestCandidate([{ bias: 2, score: 0 }, { bias: 7, score: 0 }, { bias: 12, score: 0 }]);
  assert.equal(best?.bias, 2);
});

test('but a clean plane always beats a dirty nearer one', () => {
  const best = bestCandidate([{ bias: 2, score: 3 }, { bias: 7, score: 0 }]);
  assert.equal(best?.bias, 7);
});

test('nothing to choose from is null, not a made-up number', () => {
  assert.equal(bestCandidate([]), null);
});

test('HYSTERESIS: a one-ray improvement does not move the plane', () => {
  // The objective is a step function and neighbouring candidates are often one ray apart. Without
  // a margin the plane flips between them as the camera turns, which is the twitch the whole
  // mechanism exists to remove.
  const current = { bias: 6, score: 2 };
  assert.equal(shouldAdopt(current, { bias: 7, score: 1 }), false, 'one ray better is noise');
  assert.equal(shouldAdopt(current, { bias: 7, score: 0 }), true, 'two rays better is signal');
});

test('an equally good plane that reveals materially more is still taken', () => {
  // Otherwise the plane sticks wherever it first landed and never creeps in as the room opens up.
  const current = { bias: 9, score: 0 };
  assert.equal(shouldAdopt(current, { bias: 6, score: 0 }), true);
  assert.equal(shouldAdopt(current, { bias: 8.8, score: 0 }), false, 'but not for 0.2 of a block');
});

test('with nothing in use yet, the first answer is adopted', () => {
  assert.equal(shouldAdopt(null, { bias: 5, score: 4 }), true);
});
