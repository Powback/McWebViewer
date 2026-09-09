/**
 * The view-distance cap: which section meshes are drawn, which are dropped. Pure geometry,
 * so it is tested without a GL context; the Viewer applies it to `mesh.visible`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RENDER_DISTANCE, UNLOAD_DISTANCE, sectionCentre, sectionWithin } from './viewer.js';

test('section keys map to world centres; entity mesh keys are not sections', () => {
  assert.deepEqual(sectionCentre('4,4,2'), [72, 72, 40]);
  assert.deepEqual(sectionCentre('-1,-4,0'), [-8, -56, 8]);
  assert.equal(sectionCentre('turtle:12'), null);
  assert.equal(sectionCentre('entity:abc'), null);
});

test('a section just inside the cap is drawn, one well beyond it is not', () => {
  const eye: [number, number, number] = [64, 69, 36];
  assert.equal(sectionWithin([64 + RENDER_DISTANCE, 69, 36], eye, RENDER_DISTANCE), true);
  assert.equal(sectionWithin([64 + RENDER_DISTANCE + 20, 69, 36], eye, RENDER_DISTANCE), false);
  // a partly-visible section (its centre a few blocks past the cap) still counts
  assert.equal(sectionWithin([64 + RENDER_DISTANCE + 10, 69, 36], eye, RENDER_DISTANCE), true);
});

test('the unload radius is wider than the draw radius, so nothing is dropped while visible', () => {
  assert.ok(UNLOAD_DISTANCE > RENDER_DISTANCE);
});
