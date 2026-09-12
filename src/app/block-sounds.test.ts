/**
 * Block sounds: the right sound, for the right block, at the right moment.
 *
 * The yardstick here is not "a buffer decoded" — it is that breaking stone plays STONE's
 * break sound and not air's, that walking plays the sound of what you are standing on, and
 * that standing still is silent. Most of these run against the REAL extracted `physics.json`
 * and the REAL fetched sound index, so a broken extraction or a missing fetch fails loudly
 * instead of going quiet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { soundFor, changeKind, eventForChange, Footsteps, STEP_DISTANCE } from './block-sounds.js';
import { pickVariant, jitterPitch, type SoundIndex } from '../render/sound.js';
import type { PhysicsData } from './physics.js';

const PHYSICS_PATH = 'public/physics.json';
const INDEX_PATH = '.cache/sounds/index.json';
const havePhysics = existsSync(PHYSICS_PATH);
const haveSounds = existsSync(INDEX_PATH);

const physics: PhysicsData | null = havePhysics
  ? (JSON.parse(readFileSync(PHYSICS_PATH, 'utf8')) as PhysicsData)
  : null;
const soundIndex: SoundIndex | null = haveSounds
  ? (JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as SoundIndex)
  : null;

const needPhysics = { skip: havePhysics ? false : 'run harness/run.sh' };
const needSounds = { skip: haveSounds ? false : 'run npm run fetch-sounds' };

// ---------------------------------------------------------------------------
// The lookup, against real extracted data.

test('a block resolves to the sound the GAME says it makes', needPhysics, () => {
  const stone = soundFor(physics, 'minecraft:stone');
  assert.ok(stone, 'stone has no SoundType — the extraction is broken');
  assert.equal(stone.breakSound, 'minecraft:block.stone.break');
  assert.equal(stone.stepSound, 'minecraft:block.stone.step');

  const wool = soundFor(physics, 'minecraft:white_wool');
  assert.equal(wool?.breakSound, 'minecraft:block.wool.break');
  assert.notEqual(wool?.breakSound, stone.breakSound, 'wool and stone must not sound alike');
});

test('a MODDED block resolves too — this is why the SoundType was extracted', needPhysics, () => {
  // Mods overwhelmingly reuse vanilla SoundTypes, which is exactly what makes extracting
  // the type (rather than listing block names) generic.
  const table = physics as unknown as { blocks: Record<string, { snd?: number }> };
  const modded = Object.keys(table.blocks).filter((k) => !k.startsWith('minecraft:'));
  const withSound = modded.filter((k) => soundFor(physics, k) !== null);
  assert.ok(modded.length === 0 || withSound.length > 0,
    'no modded block resolved a sound; the extraction only covered vanilla');
});

test('a state key with properties falls back to the plain block row', needPhysics, () => {
  const a = soundFor(physics, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  assert.ok(a, 'a stateful block did not resolve its sound');
});

// ---------------------------------------------------------------------------
// Which side of the change owns the sound.

test('breaking a block plays THAT BLOCK, not the air that replaced it', needPhysics, () => {
  const ev = eventForChange(physics, 'minecraft:stone', 'minecraft:air');
  assert.ok(ev);
  assert.equal(ev.event, 'minecraft:block.stone.break');
});

test('placing a block plays the block that ARRIVED', needPhysics, () => {
  const ev = eventForChange(physics, 'minecraft:air', 'minecraft:white_wool');
  assert.ok(ev);
  assert.equal(ev.event, 'minecraft:block.wool.place');
});

test('air to air is silent', () => {
  assert.equal(changeKind('minecraft:air', 'minecraft:cave_air'), 'none');
  assert.equal(eventForChange(physics, 'minecraft:air', 'minecraft:air'), null);
});

test('every spelling of air counts as air', () => {
  for (const air of ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']) {
    assert.equal(changeKind(air, 'minecraft:stone'), 'place', `${air} should be a place`);
    assert.equal(changeKind('minecraft:stone', air), 'break', `${air} should be a break`);
  }
});

test('replacing one solid with another is a place of the new one', needPhysics, () => {
  assert.equal(changeKind('minecraft:stone', 'minecraft:white_wool'), 'place');
  assert.equal(eventForChange(physics, 'minecraft:stone', 'minecraft:white_wool')?.event,
    'minecraft:block.wool.place');
});

test('an unknown block makes no sound rather than a guessed one', () => {
  assert.equal(eventForChange(physics, 'somemod:mystery', 'minecraft:air'), null);
  assert.equal(eventForChange(null, 'minecraft:stone', 'minecraft:air'), null);
});

// ---------------------------------------------------------------------------
// The events actually exist as files.

test('every event a block names is one the fetched index can PLAY', { ...needPhysics, ...needSounds }, () => {
  // The gap this catches: the extraction naming an event that `sounds.json` does not
  // resolve, or the fetch missing it — either way a block that is silently mute.
  const table = physics as unknown as { sounds?: Array<Record<string, string>> };
  const events = new Set<string>();
  for (const s of table.sounds ?? []) {
    for (const k of ['breakSound', 'stepSound', 'placeSound']) {
      if (s[k]) events.add(String(s[k]).replace(/^minecraft:/, ''));
    }
  }
  // `intentionally_empty` is vanilla's OWN no-op sound — `SoundType.EMPTY` names it, and it
  // deliberately has no files. It is silence by design, not a missing fetch, and the engine
  // already treats an event with no variants as nothing to play.
  const missing = [...events]
    .filter((e) => e !== 'intentionally_empty')
    .filter((e) => !soundIndex!.events[e]?.length);
  assert.equal(missing.length, 0,
    `${missing.length} block sound events have no files: ${missing.slice(0, 5).join(', ')}`);
  assert.ok(events.size > 50, `only ${events.size} events — the extraction looks empty`);
});

// ---------------------------------------------------------------------------
// Variant selection.

test('weighted variants are honoured, so a footstep loop is not mechanical', () => {
  const variants = [
    { file: 'a.ogg', volume: 1, pitch: 1, weight: 1 },
    { file: 'b.ogg', volume: 1, pitch: 1, weight: 3 },
  ];
  assert.equal(pickVariant(variants, 0.1)!.file, 'a.ogg');
  assert.equal(pickVariant(variants, 0.9)!.file, 'b.ogg');
  assert.equal(pickVariant([], 0.5), null);
});

test('pitch is jittered around the base, as vanilla does', () => {
  assert.ok(Math.abs(jitterPitch(1, 0.5) - 1) < 1e-9);
  assert.ok(jitterPitch(1, 0) < 1 && jitterPitch(1, 1) > 1);
  // Never zero or negative: a playbackRate of 0 hangs the source forever.
  assert.ok(jitterPitch(1, 0) > 0.5);
});

// ---------------------------------------------------------------------------
// Footsteps.

test('standing still is SILENT, however long you stand there', () => {
  const f = new Footsteps();
  for (let i = 0; i < 200; i++) {
    assert.equal(f.update([10, 64, 10], true), false, 'a stationary body produced a footstep');
  }
});

test('walking produces a step every STEP_DISTANCE blocks, not on a timer', () => {
  const f = new Footsteps();
  let steps = 0;
  for (let i = 0; i < 100; i++) if (f.update([i * 0.1, 64, 0], true)) steps++;
  // 10 blocks travelled.
  const expected = Math.floor(10 / STEP_DISTANCE);
  assert.ok(Math.abs(steps - expected) <= 1, `${steps} steps over 10 blocks, expected ~${expected}`);
});

test('walking slowly gives the same steps per BLOCK, just spread over more frames', () => {
  const run = (per: number) => {
    const f = new Footsteps();
    let n = 0;
    for (let i = 0; i < 10 / per; i++) if (f.update([i * per, 64, 0], true)) n++;
    return n;
  };
  assert.equal(run(0.05), run(0.2), 'step count must follow distance, not frame count');
});

test('falling makes no footsteps — vertical movement is not walking', () => {
  const f = new Footsteps();
  let steps = 0;
  for (let i = 0; i < 100; i++) if (f.update([0, 200 - i, 0], false)) steps++;
  assert.equal(steps, 0, 'a fall machine-gunned footsteps');
});

test('airborne movement is silent even while moving horizontally', () => {
  const f = new Footsteps();
  let steps = 0;
  for (let i = 0; i < 100; i++) if (f.update([i * 0.3, 80, 0], false)) steps++;
  assert.equal(steps, 0);
});

test('a teleport does not fire a burst of steps', () => {
  const f = new Footsteps();
  f.update([0, 64, 0], true);
  assert.equal(f.update([500, 64, 500], true), false, 'a resync was counted as walking');
});
