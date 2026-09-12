/**
 * The source toggle, and the entity-row mapping behind the spacetime path.
 *
 * The toggle's precedence is the thing most worth pinning down: `bridge` must stay the
 * default, and a bad value must not silently become `spacetime` on a deployment that has no
 * bot running. Both directions are asserted here rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource, parseKind, describeSource, DEFAULT_SOURCE } from './world-source.js';
import { toSample, SpacetimeEntities, type Connection, type EntityRow } from './spacetime-entities.js';

// ---------------------------------------------------------------------------
// Precedence.

test('with nothing configured the source is the BRIDGE — the existing behaviour', () => {
  const c = resolveSource('', null);
  assert.equal(c.kind, 'bridge');
  assert.equal(c.origin, 'default');
});

test('the served config selects spacetime, and carries its address', () => {
  const c = resolveSource('', { source: 'spacetime', stdbUri: 'http://db.pow', database: 'mc' });
  assert.equal(c.kind, 'spacetime');
  assert.equal(c.origin, 'config');
  assert.equal(c.stdbUri, 'http://db.pow');
  assert.equal(c.database, 'mc');
});

test('the URL beats the served config, in BOTH directions', () => {
  // One tab can try the new path on a bridge deployment...
  const on = resolveSource('?source=spacetime', { source: 'bridge' });
  assert.equal(on.kind, 'spacetime');
  assert.equal(on.origin, 'url');
  // ...and, just as importantly, fall back on a spacetime deployment whose bot is down.
  const off = resolveSource('?source=bridge', { source: 'spacetime' });
  assert.equal(off.kind, 'bridge');
  assert.equal(off.origin, 'url');
});

test('a value that is neither known kind is IGNORED, not guessed at', () => {
  assert.equal(parseKind('spacetimedb'), null);
  assert.equal(parseKind(''), null);
  assert.equal(parseKind(undefined), null);
  // A typo in the deployment env must not move anyone off the working default.
  assert.equal(resolveSource('?source=spacetim', { source: 'brigde' }).kind, 'bridge');
});

test('addresses survive even when the kind does not change', () => {
  const c = resolveSource('', { stdbUri: 'http://elsewhere.pow' });
  assert.equal(c.kind, 'bridge');
  assert.equal(c.stdbUri, 'http://elsewhere.pow');
  assert.equal(c.database, DEFAULT_SOURCE.database);
});

test('a malformed config body does not throw the page away', () => {
  for (const bad of [null, undefined, 42, 'nonsense', []]) {
    assert.equal(resolveSource('', bad).kind, 'bridge');
  }
});

test('the HUD line names the source and where the choice came from', () => {
  assert.match(describeSource(resolveSource('', null)), /bridge/);
  const s = describeSource(resolveSource('?source=spacetime', null));
  assert.match(s, /spacetime/);
  assert.match(s, /url/, 'the origin must be visible — a silent toggle is how a toggle confuses people');
});

// ---------------------------------------------------------------------------
// Row -> sample.

function row(over: Partial<EntityRow> = {}): EntityRow {
  return {
    id: 7, uuid: 'u-1', typeName: 'minecraft:cow',
    x: 1.5, y: 64, z: -2.5, yaw: 90, customName: null, ...over,
  };
}

test('a live entity row becomes the same EntitySample shape the save-file path produces', () => {
  const s = toSample(row());
  assert.ok(s);
  assert.equal(s.uuid, 'u-1');
  assert.equal(s.type, 'minecraft:cow');
  assert.deepEqual(s.pos, [1.5, 64, -2.5]);
  assert.equal(s.yawDeg, 90);
  assert.equal(s.name, null);
});

test('identity is the UUID, never the numeric entity id', () => {
  // The server reuses entity ids after a despawn. Keying tracks on the id would let a new
  // mob inherit a dead one's track and appear to teleport across the world.
  const a = toSample(row({ id: 7, uuid: 'first' }));
  const b = toSample(row({ id: 7, uuid: 'second' }));
  assert.notEqual(a!.uuid, b!.uuid);
});

test('a non-finite position is REFUSED, because three.js drops a NaN mesh silently', () => {
  assert.equal(toSample(row({ x: NaN })), null);
  assert.equal(toSample(row({ y: Infinity })), null);
  assert.equal(toSample(row({ z: undefined as unknown as number })), null);
});

test('a row with no type or no uuid is refused rather than drawn as something', () => {
  assert.equal(toSample(row({ typeName: '' })), null);
  assert.equal(toSample(row({ uuid: '' })), null);
});

test('a custom name comes through; an empty one is null, not an empty label', () => {
  assert.equal(toSample(row({ customName: 'Bessie' }))!.name, 'Bessie');
  assert.equal(toSample(row({ customName: '' }))!.name, null);
});

// ---------------------------------------------------------------------------
// The feed.

/** A stub connection whose row set and callbacks the test drives directly. */
function stubConn(rows: EntityRow[]): Connection & { fire: () => void; applied: () => void } {
  const inserts: Array<() => void> = [];
  let onApplied = () => {};
  return {
    db: {
      entity: {
        onInsert: (cb) => inserts.push(() => cb(null, rows[0])),
        onUpdate: (cb) => inserts.push(() => cb(null, rows[0], rows[0])),
        onDelete: (cb) => inserts.push(() => cb(null, rows[0])),
        iter: () => rows,
      },
    },
    subscriptionBuilder: () => ({
      onApplied: (cb: () => void) => { onApplied = cb; return { subscribe: () => null }; },
    }),
    disconnect: () => {},
    fire: () => inserts.forEach((f) => f()),
    applied: () => onApplied(),
  };
}

test('the feed pushes the whole roster, and only after something changed', async () => {
  const pushes: number[] = [];
  const feed = new SpacetimeEntities({ onRoster: (r) => pushes.push(r.length), status: () => {} });
  const conn = stubConn([row({ uuid: 'a' }), row({ uuid: 'b' })]);
  feed.attach(conn);
  conn.applied();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(pushes.length >= 1, 'nothing was pushed after the subscription applied');
  assert.equal(pushes[0], 2, 'the push must carry the full roster, not a delta');
  const after = pushes.length;
  // Nothing changed since: the coalescing timer must not re-push the same roster forever.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(pushes.length, after, 'an unchanged roster was pushed again');
  feed.stop();
});

test('rows that cannot be drawn are dropped from the roster, not passed on as NaN', async () => {
  let last: number | null = null;
  const feed = new SpacetimeEntities({ onRoster: (r) => { last = r.length; }, status: () => {} });
  const conn = stubConn([row({ uuid: 'ok' }), row({ uuid: 'bad', x: NaN })]);
  feed.attach(conn);
  conn.applied();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(last, 1, 'the NaN row reached the renderer');
  feed.stop();
});

test('stopping the feed stops the timer and releases the connection', async () => {
  let disconnected = false;
  const feed = new SpacetimeEntities({ onRoster: () => {}, status: () => {} });
  const conn = stubConn([row()]);
  conn.disconnect = () => { disconnected = true; };
  feed.attach(conn);
  feed.stop();
  assert.equal(disconnected, true);
  assert.match(feed.hudLine(), /not connected/);
});
