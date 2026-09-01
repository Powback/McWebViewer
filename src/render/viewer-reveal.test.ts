/**
 * The subject reveal: hide what is in the way of the character, and NOTHING else.
 *
 * THE REGRESSION THESE PIN. The first version of this cut the world off at a global height
 * of `playerY + 3`. It made the character visible — measured, 0 of its pixels reached the
 * screen before and 2601 after — and that measurement is exactly why the bug shipped: it
 * only ever asked whether the character came back, never whether anything else went away.
 * Both of the things the user then reported fall straight out of cutting by height:
 *
 *   "i see straight through walls"   a height removes every block above it ANYWHERE, so
 *                                    walls nowhere near the sightline lost their tops and
 *                                    the world read as roofless
 *   "walls jump up and down with me" the height tracked the player's Y, so one step up
 *                                    moved the cut for the entire scene at once
 *
 * Neither is fixable by picking a better height. A height does not know where the camera
 * is, and "is this in the way" is a question about the camera. So the test that matters
 * here is not "is the character visible" — it is "is the wall beside it still there".
 *
 * `revealCoverage` is the predicate the fragment shader runs, in TypeScript: 1 means the
 * fragment is untouched, 0 means it is gone. The shader adds only the dither that turns a
 * fraction into a per-pixel decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { revealCoverage, subjectReveal } from './viewer.js';

const W = 800;
const H = 600;

/** The isometric framing, near enough: above and behind, pitched down at the subject. */
function isoCamera(subject: readonly [number, number, number], dist = 44) {
  const camera = new PerspectiveCamera(26, W / H, 0.1, 2000);
  const pitch = -0.6155;
  const yaw = Math.PI / 4;
  const cp = Math.cos(pitch);
  const dir = new Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  const focus = new Vector3(subject[0], subject[1] + 1, subject[2]);
  camera.position.copy(focus).addScaledVector(dir, -dist);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** Where a world point lands on screen, and how deep it is — the shader's two inputs. */
function fragment(camera: PerspectiveCamera, p: readonly [number, number, number]) {
  const v = new Vector3(p[0], p[1], p[2]);
  const viewZ = -v.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const ndc = v.project(camera);
  return { x: (ndc.x * 0.5 + 0.5) * W, y: (ndc.y * 0.5 + 0.5) * H, viewZ };
}

/** A point `blocks` along the ray from the subject towards the camera — a real occluder. */
function onSightline(
  camera: PerspectiveCamera,
  subject: readonly [number, number, number],
  blocks: number,
) {
  const body = new Vector3(subject[0], subject[1] + 1, subject[2]);
  const toCam = camera.position.clone().sub(body).normalize();
  const p = body.addScaledVector(toCam, blocks);
  return [p.x, p.y, p.z] as [number, number, number];
}

const SUBJECT: [number, number, number] = [100, 64, 200];

// ---------------------------------------------------------------------------
// It hides what is in the way.

test('a block on the line between camera and character is removed', () => {
  const camera = isoCamera(SUBJECT);
  const reveal = subjectReveal(camera, SUBJECT, W, H)!;

  for (const blocks of [2, 5, 10, 20]) {
    const f = fragment(camera, onSightline(camera, SUBJECT, blocks));
    assert.equal(
      revealCoverage(reveal, f.x, f.y, f.viewZ), 0,
      `a block ${blocks} away on the sightline must not survive`,
    );
  }
});

test('the character itself survives its own reveal', () => {
  const camera = isoCamera(SUBJECT);
  const reveal = subjectReveal(camera, SUBJECT, W, H)!;

  // Front of the model, half a body-depth nearer the camera than its centre. It is drawn
  // with the same materials as the terrain, so a bias that is too small erases the very
  // thing this exists to show.
  for (const blocks of [0, 0.3, 0.5]) {
    const f = fragment(camera, onSightline(camera, SUBJECT, blocks));
    assert.equal(
      revealCoverage(reveal, f.x, f.y, f.viewZ), 1,
      `the model's own surface at ${blocks} blocks must be drawn`,
    );
  }
});

// ---------------------------------------------------------------------------
// It leaves everything else alone. This is the half the height cutaway got wrong.

test('a wall beside the character is untouched, however tall it is', () => {
  const camera = isoCamera(SUBJECT);
  const reveal = subjectReveal(camera, SUBJECT, W, H)!;

  // A wall 10 blocks to the side, rising 12 blocks — far above the old cut height of
  // playerY + 3, which would have sliced three quarters of it off.
  for (let y = SUBJECT[1]; y <= SUBJECT[1] + 12; y++) {
    const f = fragment(camera, [SUBJECT[0] + 10, y, SUBJECT[2] - 10]);
    assert.equal(
      revealCoverage(reveal, f.x, f.y, f.viewZ), 1,
      `a wall block at y=${y} that is not on the sightline must stay drawn`,
    );
  }
});

test('a ceiling far from the character keeps its roof', () => {
  const camera = isoCamera(SUBJECT);
  const reveal = subjectReveal(camera, SUBJECT, W, H)!;

  for (const [dx, dz] of [[20, 0], [-20, 0], [0, 20], [0, -20], [30, 30]]) {
    const f = fragment(camera, [SUBJECT[0] + dx, SUBJECT[1] + 6, SUBJECT[2] + dz]);
    assert.equal(
      revealCoverage(reveal, f.x, f.y, f.viewZ), 1,
      `a roof 6 blocks up and ${dx},${dz} away is nobody's occluder`,
    );
  }
});

test('the floor the character stands on is not punched through', () => {
  const camera = isoCamera(SUBJECT);
  const reveal = subjectReveal(camera, SUBJECT, W, H)!;

  // Directly underfoot, and the two blocks in front of the feet. A hole centred on the
  // subject's screen position with no depth test would take all of these.
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const f = fragment(camera, [SUBJECT[0] + dx, SUBJECT[1] - 0.5, SUBJECT[2] + dz]);
    assert.equal(
      revealCoverage(reveal, f.x, f.y, f.viewZ), 1,
      `the ground at ${dx},${dz} is behind the character, not in front of it`,
    );
  }
});

/**
 * THE "WALLS JUMP UP AND DOWN WITH ME" TEST.
 *
 * The old cut was `playerY + 3`, one number governing the whole scene, so every step up or
 * down redrew distant geometry. Here the same off-sightline wall is measured with the
 * character at three different heights and must not move at all.
 */
test('the character changing height does not change distant geometry', () => {
  const wall: Array<[number, number, number]> = [];
  for (let y = 64; y <= 76; y++) wall.push([120, y, 180]);

  const verdicts = [62, 64, 68].map((feet) => {
    const subject: [number, number, number] = [100, feet, 200];
    const camera = isoCamera(subject);
    const reveal = subjectReveal(camera, subject, W, H)!;
    return wall.map((p) => {
      const f = fragment(camera, p);
      return revealCoverage(reveal, f.x, f.y, f.viewZ);
    });
  });

  for (const v of verdicts) {
    assert.deepEqual(v, wall.map(() => 1), 'a wall 28 blocks away is not on anyone sightline');
  }
  assert.deepEqual(verdicts[0], verdicts[1]);
  assert.deepEqual(verdicts[1], verdicts[2]);
});

// ---------------------------------------------------------------------------
// The hole itself

test('the hole is the size of the character at every zoom level', () => {
  const near = subjectReveal(isoCamera(SUBJECT, 12), SUBJECT, W, H)!;
  const far = subjectReveal(isoCamera(SUBJECT, 120), SUBJECT, W, H)!;

  // Ten times the distance is a tenth of the pixels, because the radius is specified in
  // blocks at the subject's own depth. A fixed pixel radius would swallow the map zoomed
  // out and miss the character's shoulders zoomed in.
  assert.ok(near.inner / far.inner > 9, `expected ~10x, got ${near.inner / far.inner}`);
  assert.ok(near.outer > near.inner, 'there has to be a ring to fade across');
});

test('the fade is gradual, not a hard edge', () => {
  const camera = isoCamera(SUBJECT);
  const r = subjectReveal(camera, SUBJECT, W, H)!;
  const behind = r.cutViewZ - 1;

  const mid = revealCoverage(r, r.x + (r.inner + r.outer) / 2, r.y, behind);
  assert.ok(mid > 0 && mid < 1, `the ring must be partial, got ${mid}`);
  assert.equal(revealCoverage(r, r.x + r.outer + 1, r.y, behind), 1);
  assert.equal(revealCoverage(r, r.x, r.y, behind), 0);
});

test('nothing is revealed when the subject is behind the camera', () => {
  const camera = isoCamera(SUBJECT);
  // Ten blocks PAST the camera, on the far side of it from the subject.
  const behind = onSightline(camera, SUBJECT, camera.position.distanceTo(
    new Vector3(SUBJECT[0], SUBJECT[1] + 1, SUBJECT[2]),
  ) + 10);
  assert.equal(subjectReveal(camera, behind, W, H), null);
  // ...and with nothing to reveal, every fragment is drawn.
  assert.equal(revealCoverage(null, 400, 300, 1), 1);
});
