/**
 * Ambient block particles.
 *
 * The feature the user asked for after being told it cannot be made generic. These tests
 * therefore guard two different things: that the vanilla emitters behave like vanilla's, and
 * that the vanilla-only-ness is STRUCTURAL — a modded block must emit nothing rather than
 * borrowing an emitter that happens to share a name.
 *
 * Measured in this world before building: about 560 emitting blocks — 456 bubble columns,
 * 49 torches, 38 spore blossoms, 14 lit campfires, 11 lit candles.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { emissionsFor, isEmitter, particleSprites, PARTICLES } from './particles.js';
import { frameOf, samplePos, MAX_PARTICLES, SAMPLES_PER_TICK, SAMPLE_RANGES } from './particle-system.js';
import { propsOf } from './ambient-particles.js';

// ---------------------------------------------------------------------------
// The vanilla-only boundary — the property that matters most

test('a modded block emits nothing, even when its name mirrors a vanilla emitter', () => {
  for (const name of [
    'somemod:torch', 'create:campfire', 'somemod:wall_torch', 'tconstruct:candle',
    'biomesoplenty:spore_blossom',
  ]) {
    assert.deepEqual(emissionsFor(name, { lit: 'true' }), [],
      `${name} must not inherit a vanilla emitter`);
    assert.equal(isEmitter(name), false);
  }
});

test('an unknown vanilla block emits nothing rather than guessing', () => {
  assert.deepEqual(emissionsFor('minecraft:stone', {}), []);
  assert.equal(isEmitter('minecraft:stone'), false);
});

// ---------------------------------------------------------------------------
// The emitters themselves

test('a torch emits both smoke and flame', () => {
  const kinds = emissionsFor('minecraft:torch', {}).map((e) => e.kind);
  assert.deepEqual(kinds.sort(), ['flame', 'smoke']);
});

// A wall torch leans out from its wall; emitting at the block centre puts its flame inside
// the wall it is mounted on.
test('a wall torch emits away from its wall, by facing', () => {
  const at = (facing: string) => emissionsFor('minecraft:wall_torch', { facing })[0].at;
  assert.notDeepEqual(at('north'), at('south'));
  assert.equal(at('north')[2] > 0.5, true, 'a north-facing torch leans to +z');
  assert.equal(at('south')[2] < 0.5, true);
  assert.equal(at('west')[0] > 0.5, true);
  assert.equal(at('east')[0] < 0.5, true);
});

test('a wall torch with an unreadable facing emits nothing rather than at the centre', () => {
  assert.deepEqual(emissionsFor('minecraft:wall_torch', { facing: 'sideways' }), []);
});

// Every lit-gated emitter: the unlit state is the common one and must be silent.
test('campfires and candles emit only when lit', () => {
  for (const name of ['minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:candle', 'minecraft:red_candle']) {
    assert.ok(emissionsFor(name, { lit: 'true' }).length > 0, `${name} lit`);
    assert.deepEqual(emissionsFor(name, { lit: 'false' }), [], `${name} unlit`);
    assert.deepEqual(emissionsFor(name, {}), [], `${name} with no lit property`);
  }
});

test('every dyed candle is an emitter, not just the plain one', () => {
  for (const c of ['white', 'black', 'lime', 'magenta']) {
    assert.equal(isEmitter(`minecraft:${c}_candle`), true, c);
  }
});

// A bubble column's drag property is which way the water pulls; the particles follow it.
test('a bubble column sends its bubbles the way the column pulls', () => {
  const up = emissionsFor('minecraft:bubble_column', { drag: 'false' })[0];
  const down = emissionsFor('minecraft:bubble_column', { drag: 'true' })[0];
  assert.ok(up.vel[1] > 0, 'drag=false is an upward column');
  assert.ok(down.vel[1] < 0);
});

test('a spore blossom drips downward, slowly', () => {
  const e = emissionsFor('minecraft:spore_blossom', {})[0];
  assert.equal(e.kind, 'spore');
  assert.ok(e.vel[1] < 0);
  assert.ok(e.chance < 1, 'and not on every sample, or it is a waterfall');
});

// ---------------------------------------------------------------------------
// Frames — taken from the particle definitions, which corrected two guesses

test('smoke shrinks as it ages rather than growing', () => {
  // The definition lists generic_7 down to generic_0 and the set is indexed by age. Listing
  // them the other way makes a puff grow, which reads as steam.
  const f = PARTICLES.smoke.frames;
  assert.equal(f[0], 'minecraft:particle/generic_7');
  assert.equal(f[f.length - 1], 'minecraft:particle/generic_0');
});

test('a spore uses drip_fall, the texture the definition actually names', () => {
  assert.deepEqual(PARTICLES.spore.frames, ['minecraft:particle/drip_fall']);
});

test('the frame advances with age and never runs off the end', () => {
  const frames = ['a', 'b', 'c', 'd'];
  assert.equal(frameOf({ age: 0, life: 100, frames }), 'a');
  assert.equal(frameOf({ age: 99, life: 100, frames }), 'd');
  assert.equal(frameOf({ age: 100, life: 100, frames }), 'd', 'clamped, not out of range');
  assert.equal(frameOf({ age: 5, life: 10, frames: ['only'] }), 'only');
});

test('every frame any particle can show is offered to the bake', () => {
  const baked = new Set(particleSprites());
  for (const spec of Object.values(PARTICLES)) {
    for (const f of spec.frames) assert.ok(baked.has(f), `${f} must be baked`);
  }
  assert.ok(baked.size >= 20, `expected the full frame sets, got ${baked.size}`);
});

// ---------------------------------------------------------------------------
// Sampling — vanilla's, so the rates are not anyone's choice

test('the sampling matches the game: 667 positions at each of two ranges', () => {
  assert.equal(SAMPLES_PER_TICK, 667);
  assert.deepEqual([...SAMPLE_RANGES], [16, 32]);
});

test('a sampled position is centred on the origin and within range', () => {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = samplePos(100, 16, Math.random);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    sum += v;
  }
  assert.ok(lo >= 100 - 15 && hi <= 100 + 15, `range ${lo}..${hi}`);
  assert.ok(Math.abs(sum / n - 100) < 0.5, 'and centred on the origin');
});

test('the distribution is triangular — near the camera far more often than far', () => {
  let near = 0;
  let far = 0;
  for (let i = 0; i < 20000; i++) {
    const d = Math.abs(samplePos(0, 16, Math.random));
    if (d <= 3) near++;
    if (d >= 12) far++;
  }
  assert.ok(near > far * 3, `near ${near} should dominate far ${far}`);
});

// ---------------------------------------------------------------------------
// The ceiling — the property that keeps this from taking the tab

test('there is a hard ceiling, and it is a fixed number', () => {
  assert.equal(typeof MAX_PARTICLES, 'number');
  assert.ok(MAX_PARTICLES > 0 && MAX_PARTICLES <= 20000, `cap ${MAX_PARTICLES}`);
});

// ---------------------------------------------------------------------------
// State key parsing

test('properties are read off a state key, and a bare name has none', () => {
  assert.deepEqual(propsOf('minecraft:campfire[facing=west,lit=true]'), { facing: 'west', lit: 'true' });
  assert.deepEqual(propsOf('minecraft:torch'), {});
  assert.deepEqual(propsOf('minecraft:x[a=1]'), { a: '1' });
});

// ---------------------------------------------------------------------------
// Colour — the thing the first screenshot got wrong.
//
// Torch smoke rendered as bright white blobs because nothing set a colour.
// `BaseAshSmokeParticle` does `rCol = gCol = bCol = nextFloat() * scale` with scale 0.3, so
// smoke is a random DARK grey. Size and UVs had been correct all along; only the colour was
// missing, which is why the failure looked like a texturing bug and was not one.

test('smoke is dark, not white', () => {
  const c = PARTICLES.smoke.colour;
  assert.ok(c.every((v) => v <= 0.35), `smoke colour ${c} should be dark grey`);
  assert.equal(PARTICLES.smoke.colourJitter, 1, 'and varies per particle, as vanilla does');
});

test('flame and bubble are drawn white, because their textures carry the colour', () => {
  for (const k of ['flame', 'small_flame', 'bubble'] as const) {
    assert.deepEqual([...PARTICLES[k].colour], [1, 1, 1], k);
    assert.equal(PARTICLES[k].colourJitter, 0, `${k} must not be jittered`);
  }
});

test('a campfire plume is much lighter than torch smoke', () => {
  const lum = (c: readonly number[]) => (c[0] + c[1] + c[2]) / 3;
  assert.ok(lum(PARTICLES.big_smoke.colour) > lum(PARTICLES.smoke.colour) * 2);
});

test('every kind declares a colour, so none falls back to undefined white', () => {
  for (const [kind, spec] of Object.entries(PARTICLES)) {
    assert.equal(spec.colour.length, 3, kind);
    assert.ok(spec.colour.every((v) => v >= 0 && v <= 1), `${kind} colour out of range`);
    assert.ok(spec.colourJitter >= 0 && spec.colourJitter <= 1, `${kind} jitter`);
  }
});
