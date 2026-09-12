/**
 * Monitor screens from SpacetimeDB.
 *
 * The design question was whether to widen `LiveMonitor` to carry per-character colour or
 * flatten the grid to one pair. Measured on the live server: a real
 * `computercraft/computer/<id>/screen.json` has keys `['id','lines','updated','label']` —
 * **no colour data at all**. The grid is therefore the entire difference between the two
 * sources for monitors, and flattening it would make this path exactly equal to the one it
 * improves on. Widened.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  cellColourUsage, paletteAt, toMonitor, toMonitors, type MonitorRow,
} from './spacetime-monitors.js';
import { cellColours } from './monitor-screens.js';

const PALETTE = [
  '#f0f0f0', '#f2b233', '#e57fd8', '#99b2f2', '#dede6c', '#7fcc19', '#f2b2cc', '#4c4c4c',
  '#999999', '#4c99b2', '#b266e5', '#3366cc', '#7f664c', '#57a64e', '#cc4c4c', '#111111',
];

function row(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    x: 10, y: 64, z: -20, facing: 'north',
    blockWidth: 3, blockHeight: 2, termWidth: 4, termHeight: 2,
    hasScreen: true,
    lines: ['abcd', 'efgh'],
    fg: ['0000', '0000'],
    bg: ['ffff', 'ffff'],
    palette: PALETTE,
    updatedAt: 1234,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The two traps already paid for on the proxy side

// Reversing a second time turns a white-on-black screen into black-on-white, which reads as
// a deliberate theme rather than as a bug.
test('the palette is indexed directly, NOT reversed', () => {
  assert.equal(paletteAt(PALETTE, '0'), '#f0f0f0', 'digit 0 is white');
  assert.equal(paletteAt(PALETTE, 'f'), '#111111', 'digit f is black');
  assert.notEqual(paletteAt(PALETTE, '0'), PALETTE[15], 'a reversed read would give black');
});

test('a panel whose size is not yet known is skipped, not drawn at zero size', () => {
  assert.equal(toMonitor(row({ blockWidth: 0 })), null);
  assert.equal(toMonitor(row({ blockHeight: 0 })), null);
  assert.ok(toMonitor(row({ blockWidth: 1, blockHeight: 1 })), 'a 1x1 panel is fine');
});

// ---------------------------------------------------------------------------
// Turning a row into a panel

test('a row becomes a panel at its origin block, with its own size', () => {
  const m = toMonitor(row())!;
  // y is lifted from the row's bottom-origin to LiveMonitor's top-origin: 64 + 2 - 1.
  assert.deepEqual([m.x, m.y, m.z], [10, 65, -20]);
  assert.equal(m.facing, 'north');
  assert.equal(m.width, 3);
  assert.equal(m.height, 2);
  assert.deepEqual(m.lines, ['abcd', 'efgh']);
});

test('the screen colours come from the top-left cell, which is what CC clears to', () => {
  const m = toMonitor(row())!;
  assert.equal(m.fg, '#f0f0f0', 'fg digit 0');
  assert.equal(m.bg, '#111111', 'bg digit f');
});

test('a blank or unusable row yields no panel rather than a broken one', () => {
  assert.equal(toMonitor(row({ hasScreen: false })), null);
  assert.equal(toMonitor(row({ facing: 'up' })), null, 'a monitor cannot face up');
  assert.equal(toMonitor(row({ facing: '' })), null);
  assert.equal(toMonitor(row({ x: Number.NaN })), null);
});

test('a missing or short palette degrades to plain colours rather than throwing', () => {
  const m = toMonitor(row({ palette: [] }))!;
  assert.equal(m.bg, '#000000');
  assert.equal(m.fg, '#ffffff');
  assert.equal(m.palette, undefined, 'and no per-cell lookup is offered');
});

test('panels come back in a stable order regardless of row order', () => {
  const a = row({ x: 5 });
  const b = row({ x: 1 });
  assert.deepEqual(toMonitors([a, b]).map((m) => m.x), [1, 5]);
  assert.deepEqual(toMonitors([b, a]).map((m) => m.x), [1, 5]);
});

// ---------------------------------------------------------------------------
// Per-cell colour reaching the painter

test('the per-cell grids survive onto the panel', () => {
  const m = toMonitor(row({ fg: ['0100', '0004'], bg: ['ffff', 'f9ff'] }))!;
  assert.deepEqual([...m.fgCells!], ['0100', '0004']);
  assert.deepEqual([...m.bgCells!], ['ffff', 'f9ff']);
  assert.equal(m.palette?.length, 16);
});

test('the painter resolves a highlighted cell to its palette colour', () => {
  const m = toMonitor(row({ fg: ['0100', '0004'], bg: ['ffff', 'f9ff'] }))!;
  const c = cellColours(m)!;
  assert.equal(c.fg(0, 0), '#f0f0f0', 'body text');
  assert.equal(c.fg(0, 1), '#f2b233', 'digit 1 is the orange MapServer highlights in');
  assert.equal(c.fg(1, 3), '#dede6c');
  assert.equal(c.bg(1, 1), '#4c99b2', 'digit 9 is the cyan StorageMan uses');
});

test('a source with no grid offers no per-cell lookup, and the bridge path is unchanged', () => {
  const bridgeShaped = {
    x: 0, y: 0, z: 0, facing: 'north' as const, width: 1, height: 1, label: null,
    lines: ['hi'], bg: '#000000', fg: '#ffffff', updated: 0,
  };
  assert.equal(cellColours(bridgeShaped), null);
});

test('a digit outside the palette falls back rather than picking an arbitrary entry', () => {
  const m = toMonitor(row({ fg: ['zzzz', '0000'] }))!;
  const c = cellColours(m)!;
  assert.equal(c.fg(0, 0), null, 'unparseable');
  assert.equal(c.fg(5, 0), null, 'row past the end');
  assert.equal(c.fg(0, 99), null, 'column past the end');
});

// ---------------------------------------------------------------------------
// The measurement that could not be taken here

test('cell colour usage is computable, so the number can be had when a live mirror is', () => {
  // Two rows of four, with two foreground cells and one background cell off the default.
  const u = cellColourUsage([row({ fg: ['0100', '0004'], bg: ['ffff', 'f9ff'] })]);
  assert.equal(u.cells, 8);
  assert.equal(u.fgDiffering, 2);
  assert.equal(u.bgDiffering, 1);
});

test('a wholly monochrome screen reports zero differing, which is the flatten case', () => {
  const u = cellColourUsage([row()]);
  assert.equal(u.cells, 8);
  assert.equal(u.fgDiffering, 0);
  assert.equal(u.bgDiffering, 0);
});

// ---------------------------------------------------------------------------
// The clear colour — an assumption that did NOT survive contact with real data.
//
// The first version took cell (0,0) as the screen's own pair, on the reasoning that CC
// clears to the current colours so the corner is the background wherever nothing was
// written. The live MapServer panel disproves it: its top-left cell is digit `4`, because
// the first thing written is a yellow title. That made the whole-screen fallback yellow and
// skewed the usage measurement from 0.19% to 99.6% — a wrong number that looked plausible.
//
// The modal digit is right instead: on a scrolling log the body colour wins by construction.

test('the screen colour is the most common digit, not the corner', () => {
  // MapServer's real shape: a yellow title over a white body on black.
  const title = '4444444444444' + '0'.repeat(43);
  const body = '0'.repeat(56);
  const m = toMonitor(row({
    lines: [' '.repeat(56), ' '.repeat(56), ' '.repeat(56)],
    fg: [title, body, body],
    bg: ['f'.repeat(56), 'f'.repeat(56), 'f'.repeat(56)],
    termWidth: 56, termHeight: 3,
  }))!;
  assert.equal(m.fg, PALETTE[0], 'white body, not the yellow title');
  assert.notEqual(m.fg, PALETTE[4], 'taking the corner would have given yellow');
  assert.equal(m.bg, PALETTE[15]);
});

test('the title still renders yellow — it is a cell override, not the screen colour', () => {
  const title = '4444444444444' + '0'.repeat(43);
  const body = '0'.repeat(56);
  const m = toMonitor(row({
    lines: ['MapServer  #7' + ' '.repeat(43), ' '.repeat(56)],
    fg: [title, body], bg: ['f'.repeat(56), 'f'.repeat(56)],
    termWidth: 56, termHeight: 2,
  }))!;
  const c = cellColours(m)!;
  assert.equal(c.fg(0, 0), PALETTE[4], 'the title is yellow');
  assert.equal(c.fg(1, 0), PALETTE[0], 'the body is white');
});

test('usage is measured against the modal digit, so a title is not the whole screen', () => {
  const title = '4444444444444' + '0'.repeat(43);
  const body = '0'.repeat(56);
  const u = cellColourUsage([row({
    lines: [' '.repeat(56), ' '.repeat(56)], fg: [title, body],
    bg: ['f'.repeat(56), 'f'.repeat(56)], termWidth: 56, termHeight: 2,
  })]);
  assert.equal(u.cells, 112);
  assert.equal(u.fgDiffering, 13, 'thirteen title cells, not ninety-nine of them');
});

test('a blank screen has one digit everywhere, and the mode is simply it', () => {
  const m = toMonitor(row({ fg: ['0000', '0000'], bg: ['ffff', 'ffff'] }))!;
  assert.equal(m.fg, PALETTE[0]);
  assert.equal(m.bg, PALETTE[15]);
});

// ---------------------------------------------------------------------------
// The panel origin — a second assumption that did not survive contact.
//
// The row's `y` is the BOTTOM of the panel; `LiveMonitor.y` is the TOP. Proven from the live
// data rather than from a screenshot: three panels share the wall at x=71, z=33, at y 67
// (3x1), 68 (1x1) and 69 (3x2). Read as top-origin the 3x2 occupies y 68..69 and collides
// with the 1x1, which real blocks cannot do; read as bottom-origin they stack exactly.

test('the row origin is the bottom of the panel and is lifted to the top', () => {
  const m = toMonitor(row({ y: 67, blockHeight: 4 }))!;
  assert.equal(m.y, 70, 'a 4-tall panel whose bottom is 67 has its top at 70');
});

test('a one-block panel needs no lift', () => {
  assert.equal(toMonitor(row({ y: 68, blockHeight: 1 }))!.y, 68);
});

test('the live stack at x=71,z=33 does not overlap once translated', () => {
  const stack = [
    toMonitor(row({ x: 71, z: 33, y: 67, blockWidth: 3, blockHeight: 1 }))!,
    toMonitor(row({ x: 71, z: 33, y: 68, blockWidth: 1, blockHeight: 1 }))!,
    toMonitor(row({ x: 71, z: 33, y: 69, blockWidth: 3, blockHeight: 2 }))!,
  ];
  // Each panel spans [top - height + 1, top]; no two may share a row.
  const rowsUsed = new Set<number>();
  for (const m of stack) {
    for (let y = m.y - m.height + 1; y <= m.y; y++) {
      assert.ok(!rowsUsed.has(y), `y=${y} is claimed by two panels`);
      rowsUsed.add(y);
    }
  }
  assert.equal(rowsUsed.size, 4, 'one, one and two blocks of wall');
});

test('the terminal size is taken from the protocol when it reports one', () => {
  const m = toMonitor(row({ termWidth: 57, termHeight: 52 }))!;
  assert.equal(m.cols, 57);
  assert.equal(m.rows, 52);
  const unknown = toMonitor(row({ termWidth: 0, termHeight: 0 }))!;
  assert.equal(unknown.cols, undefined, 'and left to the painter to derive when it does not');
});
