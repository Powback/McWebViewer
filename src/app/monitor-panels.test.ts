/**
 * Finding the panel a computer drives from the region data alone: the edge letters in each
 * monitor block's `state` say where its neighbours are, so the top-left, width and height
 * follow without a coordinate being configured anywhere.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { monitorAt, panelAt, panelForComputer, type StateAt } from './monitor-panels.js';

/** A 3x4 south-facing panel with x0..x0+2 by y0-3..y0, plus a computer under its middle. */
function world(x0: number, y0: number, z: number): StateAt {
  const blocks = new Map<string, string>();
  const letters = (col: number, row: number) => {
    let s = '';
    if (col > 0) s += 'l';
    if (col < 2) s += 'r';
    if (row > 0) s += 'u';
    if (row < 3) s += 'd';
    return s;
  };
  for (let col = 0; col < 3; col++) for (let row = 0; row < 4; row++) {
    blocks.set(`${x0 + col},${y0 - row},${z}`,
      `somemod:monitor_advanced[facing=south,orientation=north,state=${letters(col, row)}]`);
  }
  blocks.set(`${x0 + 1},${y0 - 4},${z}`, 'somemod:computer_normal[facing=south,state=on]');
  blocks.set(`${x0 + 1},${y0 - 4},${z + 1}`, 'minecraft:stone');
  return (x, y, z2) => blocks.get(`${x},${y},${z2}`);
}

test('a monitor block is recognised by shape, not by name', () => {
  assert.ok(monitorAt('anymod:screen[facing=west,state=lrud]'));
  assert.ok(monitorAt('anymod:screen[facing=east,state=none]'));
  assert.equal(monitorAt('minecraft:furnace[facing=west,lit=false]'), null);
  assert.equal(monitorAt('minecraft:stone'), null);
  assert.equal(monitorAt(undefined), null);
});

test('from any block of a 3x4 panel, the panel resolves to its top-left, width and height', () => {
  const at = world(58, 70, 25);
  for (const [x, y] of [[58, 70], [60, 67], [59, 68]]) {
    assert.deepEqual(panelAt(at, x, y, 25), { x: 58, y: 70, z: 25, facing: 'south', width: 3, height: 4 });
  }
});

test('the computer under the panel drives it; one elsewhere drives nothing', () => {
  const at = world(58, 70, 25);
  assert.deepEqual(panelForComputer(at, 59, 66, 25), { x: 58, y: 70, z: 25, facing: 'south', width: 3, height: 4 });
  assert.equal(panelForComputer(at, 59, 60, 25), null);
});
