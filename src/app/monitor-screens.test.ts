/**
 * Where a panel's text goes and how much of it fits — the pure part of monitor-screens.ts.
 * The 3x4 advanced panel on the reference base is the worked example: top-left block at
 * the panel's top-left as seen from the front, facing south, 21 columns by 20 rows.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fitLines, gridOf, panelKey, placement, SCREEN_LIFT, SCREEN_MARGIN } from './monitor-screens.js';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('a south-facing 3x4 panel centres its text plane on the panel, just in front of the face', () => {
  const p = placement({ x: 10, y: 20, z: 30, facing: 'south', width: 3, height: 4 });
  // blocks x 10..12: centre x = 11.5; y 17..20 (top-left is the TOP): centre y = 19
  assert.ok(close(p.centre[0], 11.5) && close(p.centre[1], 19), `centre ${p.centre}`);
  // the front of a south-facing block at z=30 is z=31
  assert.ok(close(p.centre[2], 31 + SCREEN_LIFT), `z ${p.centre[2]}`);
  assert.deepEqual(p.normal, [0, 0, 1]);
  assert.deepEqual(p.right, [1, 0, 0], 'a viewer facing north has east on the right');
  assert.ok(close(p.w, 3 - 2 * SCREEN_MARGIN) && close(p.h, 4 - 2 * SCREEN_MARGIN));
});

test('an east-facing panel runs north from its top-left block and faces +X', () => {
  const p = placement({ x: 71, y: 70, z: 27, facing: 'west', width: 3, height: 4 });
  // west-facing: front at x=71, viewer looks east, right is +Z: blocks z 27..29
  assert.ok(close(p.centre[0], 71 - SCREEN_LIFT), `x ${p.centre[0]}`);
  assert.ok(close(p.centre[2], 28.5), `z ${p.centre[2]}`); // block centres 27.5..29.5
  assert.deepEqual(p.normal, [-1, 0, 0]);
  const e = placement({ x: 57, y: 70, z: 30, facing: 'east', width: 3, height: 4 });
  assert.deepEqual(e.right, [0, 0, -1], 'a viewer looking west has north on the right');
  assert.ok(close(e.centre[2], 29.5)); // blocks z 30,29,28
});

test('grid and clipping: 7x5 characters per block, longer lines cut, extra rows dropped', () => {
  assert.deepEqual(gridOf({ width: 3, height: 4 }), { cols: 21, rows: 20 });
  const lines = fitLines(['x'.repeat(30), 'short'], 21, 3);
  assert.deepEqual(lines, ['x'.repeat(21), 'short', '']);
});

test('the panel key is its position and facing', () => {
  assert.equal(panelKey({ x: 1, y: 2, z: 3, facing: 'north' }), '1,2,3,north');
});
