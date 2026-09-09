/**
 * screen.json -> a monitor record on the panel the writing computer touches; the poller
 * asks for the file of every known computer and reports only those that have one.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ScreenFiles, screenToMonitor } from './screen-files.js';
import type { StateAt } from './monitor-panels.js';

const PANEL = { x: 58, y: 70, z: 25, facing: 'south' as const, width: 3, height: 4 };

test('a file becomes a monitor record on its panel, with defaults for what it omits', () => {
  const m = screenToMonitor({ label: 'MainFrame', lines: ['a', 2, null], updated: 5 }, PANEL);
  assert.deepEqual(m, {
    ...PANEL, label: 'MainFrame', lines: ['a', '2', ''], bg: '#111111', fg: '#f0f0f0', updated: 5,
  });
  assert.equal(screenToMonitor({ label: 'x' }, PANEL), null, 'no lines, no screen');
  assert.equal(screenToMonitor(null, PANEL), null);
  assert.equal(screenToMonitor({ lines: [] }, null), null, 'no panel, nowhere to paint');
});

test('the poller reads each driving computer once per tick and skips those with no file', async () => {
  const blocks = new Map<string, string>([
    ['58,70,25', 'm:monitor[facing=south,state=rd]'],
    ['58,69,25', 'm:computer[facing=south,state=on]'],
  ]);
  const at: StateAt = (x, y, z) => blocks.get(`${x},${y},${z}`);
  const asked: string[] = [];
  let reported: unknown[] = [];
  const files = new ScreenFiles({
    computers: () => [{ id: 7, pos: [58, 69, 25] }, { id: 9, pos: [100, 60, 100] }],
    stateAt: at,
    onMonitors: (l) => { reported = l; },
    fetchJson: async (url) => { asked.push(url); return url.includes('/7/') ? { lines: ['hi'] } : null; },
  });
  const out = await files.tick();
  assert.deepEqual(asked, ['/dev/computercraft/computer/7/screen.json'], 'only the computer touching a panel is read');
  assert.equal(out.length, 1);
  assert.equal(out[0].lines[0], 'hi');
  assert.deepEqual(out[0].width, 1);
  assert.equal(reported, out);
});

test('a computer whose file is missing is not asked again every tick', async () => {
  const at: StateAt = (x, y, z) => (x === 0 && y === 1 && z === 0 ? 'm:monitor[facing=north,state=none]' : undefined);
  let asks = 0;
  const files = new ScreenFiles({
    computers: () => [{ id: 3, pos: [0, 0, 0] }],
    stateAt: at,
    onMonitors: () => {},
    fetchJson: async () => { asks++; return null; },
  });
  await files.tick();
  await files.tick();
  assert.equal(asks, 1);
});
