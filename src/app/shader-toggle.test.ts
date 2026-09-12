/**
 * Tests for the shaderpack selector's rules.
 *
 * The DOM half is glue; what is worth pinning is the URL arithmetic and the rotation, because
 * both have a failure mode that looks like nothing at all went wrong:
 *
 *   losing a query parameter    the page reloads onto a different WORLD SOURCE, silently
 *   disagreeing about `?shaders`  the button reads "off" while a pack is plainly rendering
 *   offering a pack that 404s   the view reloads into "shaderpack not served" and stays there
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPacks, nextPack, shaderLabel, shadersFromUrl, urlForShaders, type ShaderPackInfo,
} from './shader-toggle.js';

const PACKS: ShaderPackInfo[] = [{ id: 'sildurs-lite', name: "Sildur's Lite" }];
const TWO: ShaderPackInfo[] = [...PACKS, { id: 'bsl' }];

test('choosing a pack keeps every other parameter — the source most of all', () => {
  const href = 'http://mcwebviewer.pow/?source=spacetime&auto=1';
  const out = new URL(urlForShaders(href, 'sildurs-lite'));
  assert.equal(out.searchParams.get('shaders'), 'sildurs-lite');
  assert.equal(out.searchParams.get('source'), 'spacetime', 'the world source must survive');
  assert.equal(out.searchParams.get('auto'), '1');
});

test('turning shaders off removes the parameter rather than emptying it', () => {
  // `?shaders=` with no value is NOT off — startShaders reads that as the default pack. An
  // "off" that left the key behind would turn shaders on.
  const out = new URL(urlForShaders('http://mcwebviewer.pow/?shaders=bsl&source=bridge', null));
  assert.equal(out.searchParams.has('shaders'), false);
  assert.equal(out.searchParams.get('source'), 'bridge');
});

test('A BARE ?shaders MEANS THE DEFAULT PACK, exactly as startShaders reads it', () => {
  assert.equal(shadersFromUrl('http://x/?shaders', 'sildurs-lite'), 'sildurs-lite');
  assert.equal(shadersFromUrl('http://x/?shaders=', 'sildurs-lite'), 'sildurs-lite');
  assert.equal(shadersFromUrl('http://x/?shaders=bsl', 'sildurs-lite'), 'bsl');
  assert.equal(shadersFromUrl('http://x/', 'sildurs-lite'), null, 'no parameter is off');
});

test('the rotation goes off -> each pack -> off, and comes back round', () => {
  assert.equal(nextPack(TWO, null), 'sildurs-lite');
  assert.equal(nextPack(TWO, 'sildurs-lite'), 'bsl');
  assert.equal(nextPack(TWO, 'bsl'), null, 'the last pack rotates back to off');
  assert.equal(nextPack(PACKS, 'sildurs-lite'), null, 'one pack is a plain on/off');
});

test('a pack id nobody is serving rotates to OFF, not to something unrelated', () => {
  // Typed into the URL by hand, or left over from a pack that has since been deleted. The
  // view is already showing "not served"; the next press has to be able to escape that.
  assert.equal(nextPack(PACKS, 'a-pack-that-was-deleted'), null);
});

test('with nothing built the control says so and cannot be pressed', () => {
  const v = shaderLabel([], null);
  assert.equal(v.disabled, true);
  assert.match(v.label, /none built/);
  assert.match(v.title, /build-shaderpack/, 'and says how to get one');
});

test('while the index is still loading the control is disabled, not wrong', () => {
  assert.equal(shaderLabel(null, null).disabled, true);
});

test('the label names the pack, and the tooltip names what pressing it will do', () => {
  assert.match(shaderLabel(PACKS, null).label, /off/);
  assert.match(shaderLabel(PACKS, null).title, /Sildur's Lite/);
  assert.match(shaderLabel(PACKS, 'sildurs-lite').label, /Sildur's Lite/);
  assert.match(shaderLabel(PACKS, 'sildurs-lite').title, /off/);
});

/** A fetch that answers one url and 404s everything else. */
const serving = (url: string, body: unknown): typeof fetch =>
  (async (u: string) => (u === url
    ? { ok: true, json: async () => body }
    : { ok: false, json: async () => null })) as unknown as typeof fetch;

test('the pack index is read from production OR the dev mount', async () => {
  const body = { packs: [{ id: 'sildurs-lite', name: "Sildur's Lite" }] };
  assert.deepEqual(await fetchPacks(serving('/shaderpacks/index.json', body)), body.packs);
  assert.deepEqual(await fetchPacks(serving('/dev/shaderpack/index.json', body)), body.packs);
});

test('a bare array of ids is accepted too, so the index format can stay simple', async () => {
  const got = await fetchPacks(serving('/shaderpacks/index.json', ['bsl', 'sildurs-lite']));
  assert.deepEqual(got, [{ id: 'bsl' }, { id: 'sildurs-lite' }]);
});

test('NO INDEX, BAD JSON OR A THROWN FETCH IS "no packs", never an exception', async () => {
  // The selector is an enhancement sitting on the boot path. It must not be able to take the
  // viewer down with it, which is the same rule startShaders follows for the pipeline itself.
  const missing = (async () => ({ ok: false, json: async () => null })) as unknown as typeof fetch;
  const throws = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  const junk = serving('/shaderpacks/index.json', { nope: true });
  assert.deepEqual(await fetchPacks(missing), []);
  assert.deepEqual(await fetchPacks(throws), []);
  assert.deepEqual(await fetchPacks(junk), []);
});

test('entries without a usable id are dropped rather than offered as blank buttons', async () => {
  const got = await fetchPacks(serving('/shaderpacks/index.json', { packs: [{ id: '' }, 42, { id: 'bsl' }] }));
  assert.deepEqual(got, [{ id: 'bsl' }]);
});
