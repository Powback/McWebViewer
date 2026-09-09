import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorsPoller, parseMonitor, parseMonitors } from './monitors.mjs';

const GOOD = {
  x: 62, y: 70, z: 25, facing: 'south', width: 3, height: 4, label: 'MainFrame',
  lines: ['HiveMind', 'drones: 19'], bg: '#111111', fg: '#f0f0f0', updated: 1700000000000,
};

test('a well-formed monitor record passes through with its fields', () => {
  assert.deepEqual(parseMonitor(GOOD), GOOD);
});

test('records the viewer cannot place are dropped, not thrown on', () => {
  assert.equal(parseMonitor(null), null);
  assert.equal(parseMonitor({ ...GOOD, facing: 'up' }), null);
  assert.equal(parseMonitor({ ...GOOD, x: 1.5 }), null);
  assert.equal(parseMonitor({ ...GOOD, width: 0 }), null);
  assert.equal(parseMonitor({ ...GOOD, width: 999 }), null);
});

test('defaults fill missing colours, lines and label; lines are strings', () => {
  const m = parseMonitor({ x: 1, y: 2, z: 3, facing: 'west', width: 1, height: 1, lines: [42, null] });
  assert.equal(m.bg, '#111111');
  assert.equal(m.fg, '#f0f0f0');
  assert.equal(m.label, null);
  assert.deepEqual(m.lines, ['42', '']);
  assert.equal(m.updated, 0);
});

test('the payload envelope may be {monitors} or {data:{monitors}}; anything else is empty', () => {
  assert.equal(parseMonitors({ monitors: [GOOD] }).length, 1);
  assert.equal(parseMonitors({ data: { monitors: [GOOD, { bad: true }] } }).length, 1);
  assert.deepEqual(parseMonitors('nope'), []);
  assert.deepEqual(parseMonitors(null), []);
});

test('a 404 or refused feed is a logged miss: nothing emitted, last list kept, never a throw', async () => {
  const emitted = [];
  const logs = [];
  let status = 200;
  const poller = new MonitorsPoller({
    url: 'http://hq:4400/monitors',
    emit: (m) => emitted.push(m),
    log: (m) => logs.push(m),
    fetch: async () => ({ ok: status === 200, status, json: async () => ({ monitors: [GOOD] }) }),
  });
  await poller.once();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].t, 'monitors');
  assert.equal(emitted[0].list.length, 1);
  assert.equal(poller.available, true);

  status = 404;
  await poller.once();
  assert.equal(emitted.length, 1, 'a miss emits nothing');
  assert.equal(poller.list.length, 1, 'the last good list is kept');
  assert.equal(poller.failures, 1);
  assert.match(logs.join('\n'), /HTTP 404/);
});

test('no URL means disabled: the loop returns at once and status says so', async () => {
  const poller = new MonitorsPoller({ url: '', emit: () => {} });
  assert.equal(poller.enabled, false);
  assert.equal(poller.status().available, false);
  await poller.loop(() => true); // must not spin
});
