/**
 * Tests for the walkability table.
 *
 * THE ONE RULE THIS FILE EXISTS TO DEFEND is that the failure points in a safe direction.
 * The table lists only what is NOT solid, so a block nobody has heard of is solid, and the
 * consequences of the two mistakes are not symmetric:
 *
 *   a plant wrongly called SOLID   the character walks around a flower. Silly. It arrives.
 *   a wall wrongly called AIR      the route goes through a wall the server still has, the
 *                                  body shoves into it, and the walk ends in "stuck"
 *
 * That is why "unknown means solid" gets a test of its own below rather than being left as
 * a sentence in a comment: it is the kind of rule a well-meaning addition quietly inverts.
 *
 * The modded entries are here because they were MEASURED against the live world during a
 * collision-parity audit, not because anybody recognised the names — 137 cells of Farmer's
 * Delight crop standing in the world as walls, which reads as a pathfinding bug and is not
 * one. Pinning them stops a future tidy-up of the suffix list from putting them back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyName, nameOf, navWorld } from './nav-world.js';
import type { World } from '../render/world.js';

test('a state key is matched by its block name, not by its properties', () => {
  assert.equal(nameOf('minecraft:oak_stairs[facing=north,half=bottom]'), 'minecraft:oak_stairs');
  assert.equal(nameOf('minecraft:stone'), 'minecraft:stone');
  // The classification has to survive the properties, or every stair with a different
  // facing would be a different, unrecognised block.
  assert.equal(classifyName(nameOf('minecraft:dandelion[age=0]')), 'air');
});

test('ANYTHING THIS TABLE HAS NOT HEARD OF IS SOLID', () => {
  for (const name of [
    'somemod:reinforced_plating', 'create:cogwheel', '', 'minecraft:stone',
    'anothermod:whatever_this_is',
  ]) {
    assert.equal(classifyName(name), 'solid',
      `${name || '(empty)'} was treated as walkable; unknown must mean solid`);
  }
});

test('water, lava and the things that hurt are neither walked through nor stood on', () => {
  // A third class rather than two, because "a body cannot be here" and "a body can stand on
  // top of this" are different questions and water is the block that proves it.
  for (const name of ['minecraft:water', 'minecraft:lava', 'minecraft:fire',
    'minecraft:cactus', 'minecraft:powder_snow', 'minecraft:sweet_berry_bush']) {
    assert.equal(classifyName(name), 'avoid', `${name} has to be avoided, not walked on`);
  }
});

test('plants with no collision box are walked through', () => {
  for (const name of ['minecraft:dandelion', 'minecraft:tall_grass', 'minecraft:torch',
    'minecraft:oak_sign', 'minecraft:rail', 'minecraft:wheat', 'minecraft:white_carpet']) {
    assert.equal(classifyName(name), 'air', `${name} is not something to walk around`);
  }
});

test('a modded plant whose name copies a vanilla shape is caught without its own line', () => {
  // The reason the vanilla entries are suffixes at all: mods copy the name shape.
  assert.equal(classifyName('biomesoplenty:rose_sapling'), 'air');
  assert.equal(classifyName('somemod:glowing_mushroom'), 'air');
});

/**
 * A DANDELION WAS A WALL, and the table said it was working.
 *
 * The suffix list is written `_dandelion`, `_fern`, `_poppy` — the shape a modded name
 * copies — and a suffix that begins with an underscore cannot match a block simply called
 * `dandelion`. Vanilla names a good many of its plants with no prefix at all, so the
 * character walked around every one of them. This was the first assertion ever made against
 * `classifyName` and it failed immediately, which is the whole argument for the file.
 */
test('a plant with no prefix in its name is still a plant', () => {
  for (const name of ['minecraft:dandelion', 'minecraft:poppy', 'minecraft:fern',
    'minecraft:allium', 'minecraft:cornflower', 'minecraft:sunflower', 'minecraft:lilac',
    'minecraft:peony', 'minecraft:lily_of_the_valley']) {
    assert.equal(classifyName(name), 'air', `${name} was being walked around as a wall`);
  }
  // The same rule, for a mod that names one the same way.
  assert.equal(classifyName('somemod:fern'), 'air');
});

test('making the separator optional did not make the matching sloppy', () => {
  // `_bush` must not start matching things that merely CONTAIN it, or the safe direction
  // stops being safe. Only the whole name after the namespace counts.
  assert.equal(classifyName('somemod:bushhammer'), 'solid');
  assert.equal(classifyName('somemod:ferngully_bricks'), 'solid');
  assert.equal(classifyName('somemod:grasspacked_stone'), 'solid');
});

/**
 * MEASURED, NOT RECOGNISED. A collision-parity audit of the live world found these five
 * standing as solid walls across 137 cells. They have no collision box in the game, so a
 * rice paddy the character refuses to cross is the planner and the server disagreeing —
 * which looks exactly like a pathfinding bug from the outside.
 */
test('the Farmer’s Delight crops found standing as walls in the live world are walkable', () => {
  for (const name of [
    'farmersdelight:rice', 'farmersdelight:rice_panicles', 'farmersdelight:wild_onions',
    'farmersdelight:wild_beetroots', 'farmersdelight:sandy_shrub',
  ]) {
    assert.equal(classifyName(name), 'air', `${name} is a crop, not a wall`);
  }
});

/**
 * THE OTHER HALF OF THE AUDIT, kept deliberately unfixed.
 *
 * A ComputerCraft cable's real collision is a thin cross and this table cannot say that.
 * Solid is the wrong answer and it is the SAFE wrong answer: a detour, not a route planned
 * through something the server still collides with. Pinned so that "fixing" it to passable
 * is a decision somebody makes on purpose, with this comment in front of them, rather than
 * a tidy-up.
 */
test('a cable stays solid, because a detour beats a route into something that is there', () => {
  assert.equal(classifyName('computercraft:cable'), 'solid');
});

/** A `World` stub with one loaded chunk, which is all `known` looks at. */
function worldWith(loaded: Set<string>): World {
  return {
    palette: ['minecraft:air', 'minecraft:stone'],
    minY: -64,
    maxY: 320,
    getState: () => 1,
    getChunk: (cx: number, cz: number) => (loaded.has(`${cx},${cz}`) ? {} : undefined),
  } as unknown as World;
}

/**
 * `World.getState` answers AIR outside the loaded chunks, and a planner that believed it
 * would happily route through the edge of the render distance and out into nothing. So
 * "unknown" has to be a separate question from "what block is this".
 */
test('a chunk nobody has loaded is not walkable, however empty it looks', () => {
  const nav = navWorld(worldWith(new Set(['0,0'])));
  assert.equal(nav.known(5, 64, 5), true, 'chunk 0,0 is loaded');
  assert.equal(nav.known(100, 64, 100), false, 'chunk 6,6 is not, so nothing is known there');
});

test('nothing above or below the built world is known either', () => {
  const nav = navWorld(worldWith(new Set(['0,0'])));
  assert.equal(nav.known(5, -65, 5), false, 'under the world there is nothing to stand on');
  assert.equal(nav.known(5, 321, 5), false, 'and nothing above it');
  assert.equal(nav.known(5, 0, 5), true);
});
