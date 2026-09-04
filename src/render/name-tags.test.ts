/**
 * Name tags: the two properties that decide whether they are useful.
 *
 * Both are about SIZE, and neither can be checked from a screenshot at one distance —
 * which is exactly how a label that is unreadable at a hundred blocks ships. A plain
 * world-space sprite has an apparent size proportional to 1/distance, so a tag legible
 * standing next to someone is two pixels tall from across a base, and that is where you
 * actually need it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameColor, tagScale } from './name-tags.js';

/**
 * What the eye sees. With `sizeAttenuation`, a sprite's height on screen is proportional
 * to its world scale divided by its distance from the camera.
 */
const apparent = (d: number) => tagScale(d) / d;

test('a tag is anchored to the world up close, so it grows as you walk up to it', () => {
  // Inside the full-size distance the scale is constant, i.e. it behaves like the player it
  // names: it belongs to the world, not to the screen.
  assert.equal(tagScale(4), tagScale(20));
  assert.ok(apparent(4) > apparent(20) * 4, 'and therefore looks bigger from closer');
});

test('a tag never gets smaller on screen than it is at its full-size distance', () => {
  const floor = apparent(24);
  for (const d of [30, 60, 120, 400, 2000]) {
    assert.ok(
      Math.abs(apparent(d) - floor) < 1e-9,
      `at ${d} blocks the tag is ${apparent(d) / floor} times its readable size`,
    );
  }
});

test('a tag has a size at zero distance rather than a division by zero', () => {
  assert.ok(Number.isFinite(tagScale(0)) && tagScale(0) > 0);
});

/**
 * The colour is derived from the NAME, not from a position in the roster. Roster order
 * changes every time somebody logs in, so an index-derived colour would repaint the whole
 * fleet whenever one drone reconnected — and a marker whose colour moves between players is
 * worse than no colour at all, because it invites you to trust it.
 */
test('a player keeps their colour whoever else is online', () => {
  assert.equal(nameColor('drone_07'), nameColor('drone_07'));
  assert.notEqual(nameColor('drone_07'), nameColor('drone_08'));
  assert.match(nameColor('drone_07'), /^hsl\(\d+, 85%, 62%\)$/);
});

test('colours are spread rather than clustered', () => {
  const names = Array.from({ length: 24 }, (_, i) => `drone_${String(i).padStart(2, '0')}`);
  const hues = new Set(names.map((n) => nameColor(n)));
  assert.ok(hues.size >= 20, `only ${hues.size} distinct colours across ${names.length} names`);
});
