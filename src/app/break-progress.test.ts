/**
 * Break timing, against the REAL extracted hardness, the REAL tool components and the REAL
 * merged block tags.
 *
 * These are checkable against the game: a diamond pickaxe breaks stone in 0.4 s, a wooden
 * one in 1.15 s, a bare hand in 7.5 s. If the tag merge or the tool extraction regresses,
 * every one of those numbers moves and these fail — which is the point, because the failure
 * mode otherwise is "mining feels wrong" with everything still looking plausible.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import {
  breakSeconds, breakStage, toolEffect, BreakTracker, type TagIndex,
} from './break-progress.js';
import type { PhysicsData } from './physics.js';

const P = 'public/physics.json';
const T = '.cache/baked/tags.json';
const have = existsSync(P) && existsSync(T);
const physics: PhysicsData | null = have ? JSON.parse(readFileSync(P, 'utf8')) : null;
const tags: TagIndex | null = have ? JSON.parse(readFileSync(T, 'utf8')) : null;
const need = { skip: have ? false : 'run harness/run.sh and npm run bake-assets' };

const inputs = (tool: string | null) => ({ physics, tags, tool });
const near = (a: number, b: number, eps = 0.06) => Math.abs(a - b) <= eps;

test('a bare hand on stone takes the time the game charges', need, () => {
  // hardness 1.5, speed 1, wrong tool: 1.5 * 100 / 1 = 150 ticks = 7.5 s
  const s = breakSeconds(inputs(null), 'minecraft:stone');
  assert.ok(s !== null && near(s, 7.5), `bare hand on stone: ${s}s, expected 7.5`);
});

test('a diamond pickaxe on stone is much faster, and by the right amount', need, () => {
  // speed 8, correct: 1.5 * 30 / 8 = 5.625 -> 6 ticks = 0.3 s
  const s = breakSeconds(inputs('minecraft:diamond_pickaxe'), 'minecraft:stone');
  assert.ok(s !== null && s < 0.5, `diamond pickaxe on stone: ${s}s, expected well under 0.5`);
  const bare = breakSeconds(inputs(null), 'minecraft:stone')!;
  assert.ok(bare / s! > 15, `a diamond pickaxe should be far faster than a hand (${bare} vs ${s})`);
});

test('a wooden pickaxe is slower than a diamond one, faster than a hand', need, () => {
  const wood = breakSeconds(inputs('minecraft:wooden_pickaxe'), 'minecraft:stone')!;
  const diamond = breakSeconds(inputs('minecraft:diamond_pickaxe'), 'minecraft:stone')!;
  const hand = breakSeconds(inputs(null), 'minecraft:stone')!;
  assert.ok(diamond < wood && wood < hand, `${diamond} < ${wood} < ${hand} expected`);
});

test('the WRONG tool does not get the harvest bonus', need, () => {
  // A shovel is not for stone: it should be no better than a hand on it.
  const shovel = breakSeconds(inputs('minecraft:diamond_shovel'), 'minecraft:stone')!;
  const hand = breakSeconds(inputs(null), 'minecraft:stone')!;
  assert.ok(shovel >= hand * 0.9, `a shovel broke stone in ${shovel}s vs a hand's ${hand}s`);
});

test('a shovel IS right for dirt', need, () => {
  const shovel = breakSeconds(inputs('minecraft:diamond_shovel'), 'minecraft:dirt')!;
  const hand = breakSeconds(inputs(null), 'minecraft:dirt')!;
  assert.ok(shovel < hand, `shovel ${shovel}s should beat a hand's ${hand}s on dirt`);
  assert.equal(toolEffect(inputs('minecraft:diamond_shovel'), 'minecraft:dirt').correct, true);
});

test('a MODDED block gets the right tool treatment — the tag merge is what makes this work', need, () => {
  // 6,504 of the blocks in mineable/pickaxe are modded. Without merging every pack's copy
  // of the tag, all of them would look like they need no tool.
  const pk = tags!['minecraft:mineable/pickaxe'] ?? [];
  const modded = pk.find((b) => b.startsWith('create:') || b.startsWith('ae2:'));
  assert.ok(modded, 'no modded block in mineable/pickaxe — the tag merge regressed');
  assert.equal(toolEffect(inputs('minecraft:diamond_pickaxe'), modded).correct, true,
    `${modded} should be harvestable by a pickaxe`);
});

test('bedrock is unbreakable, and says so', need, () => {
  assert.equal(breakSeconds(inputs('minecraft:diamond_pickaxe'), 'minecraft:bedrock'), null);
});

test('an instant block is 0 seconds, which is NOT the same as unknown', need, () => {
  // hardness 0. `0` is a real answer; `null` means "cannot" or "do not know".
  const s = breakSeconds(inputs(null), 'minecraft:torch');
  assert.equal(s, 0);
});

test('an unknown block gives null rather than a made-up duration', () => {
  assert.equal(breakSeconds({ physics, tags, tool: null }, 'somemod:mystery'), null);
  assert.equal(breakSeconds({ physics: null, tags: null, tool: null }, 'minecraft:stone'), null);
});

test('obsidian with the right tool is still slow — hardness dominates', need, () => {
  const s = breakSeconds(inputs('minecraft:diamond_pickaxe'), 'minecraft:obsidian')!;
  assert.ok(s > 8 && s < 12, `obsidian with a diamond pickaxe: ${s}s, expected about 9.4`);
});

// ---------------------------------------------------------------------------
// Stages and the tracker.

test('the crack stage spans the 10 textures vanilla ships', () => {
  assert.equal(breakStage(0), -1, 'no progress means no overlay at all');
  assert.equal(breakStage(0.01), 0);
  assert.equal(breakStage(0.55), 5);
  assert.equal(breakStage(0.999), 9);
  assert.equal(breakStage(1), 9, 'stage must never exceed the 9 texture index');
  assert.equal(breakStage(5), 9);
});

test('progress accumulates while the target stays the same', () => {
  const t = new BreakTracker();
  t.update('stone@1,2,3', 2, 0);
  t.update('stone@1,2,3', 2, 1);
  assert.ok(Math.abs(t.progress - 0.5) < 1e-9, `progress ${t.progress}`);
  assert.equal(t.stage, 5);
});

test('looking at a DIFFERENT block starts again — progress must not carry over', () => {
  const t = new BreakTracker();
  t.update('stone@1,2,3', 2, 0);
  t.update('stone@1,2,3', 2, 1.9);
  assert.ok(t.progress > 0.9);
  // Same state, different position: still a different block.
  t.update('stone@1,2,4', 2, 0);
  assert.equal(t.progress, 0, 'progress carried over to a different block');
});

test('releasing the dig clears the overlay', () => {
  const t = new BreakTracker();
  t.update('stone@1,2,3', 2, 1);
  t.update(null, null, 0);
  assert.equal(t.stage, -1);
  assert.equal(t.block, null);
});

test('an instant block reads as fully broken rather than stuck at zero', () => {
  const t = new BreakTracker();
  t.update('torch@1,2,3', 0, 0);
  assert.equal(t.progress, 1);
});
