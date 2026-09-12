/**
 * What the renderer's `World` looks like to something walking on it.
 *
 * The renderer stores block STATES. The planner needs to know whether a body can occupy a
 * cell and whether it can stand on one, and Minecraft answers that with
 * `Block.getCollisionShape` — Java, not assets. There is nothing in a blockstate JSON or a
 * model that says a flower is walk-through and a fence post is not: both are non-full-cube
 * geometry, and `opaqueFullCube` (which the mesher derives honestly, from the sprite's
 * alpha channel) is true for stone and false for glass, leaves, stairs and slabs alike.
 * So this is a table, in the same category as the two the block registry already keeps for
 * render layer and biome tint: things vanilla defines in code and cannot be derived.
 *
 * THE TABLE ONLY LISTS WHAT IS NOT SOLID, and everything unlisted is solid. That is the
 * direction the failure has to point. A modded flower this does not know about makes the
 * character walk AROUND a flower — silly, and it still arrives. A modded wall this did not
 * know about would make it plan straight through a wall, shove into it and give up, which
 * is the bug this whole feature exists to remove. So: unknown means solid, always.
 *
 * Matching is by suffix wherever the vanilla name shape carries the meaning
 * (`*_sapling`, `*_pressure_plate`, `*_rail`), because that shape is what modded blocks
 * copy — `biomesoplenty:rose_sapling` is caught without a line of its own.
 */

import { AIR_ID, type World } from '../render/world.js';
import type { NavClass, NavWorld } from './pathfind.js';

/** Blocks a body may walk through: no collision box at all in vanilla. */
const PASSABLE_EXACT = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:light',
  'minecraft:structure_void', 'minecraft:snow', 'minecraft:vine', 'minecraft:glow_lichen',
  'minecraft:sugar_cane', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass',
  'minecraft:tall_seagrass', 'minecraft:nether_wart', 'minecraft:wheat',
  'minecraft:carrots', 'minecraft:potatoes', 'minecraft:beetroots', 'minecraft:torchflower',
  'minecraft:redstone_wire', 'minecraft:tripwire', 'minecraft:tripwire_hook',
  'minecraft:lever', 'minecraft:hanging_roots', 'minecraft:small_dripleaf',
  'minecraft:dead_bush', 'minecraft:crimson_roots', 'minecraft:warped_roots',
  'minecraft:nether_sprouts', 'minecraft:twisting_vines', 'minecraft:twisting_vines_plant',
  'minecraft:weeping_vines', 'minecraft:weeping_vines_plant', 'minecraft:pink_petals',
  'minecraft:end_rod', 'minecraft:lightning_rod', 'minecraft:comparator',
  'minecraft:repeater', 'minecraft:rail', 'minecraft:string',
  // Vanilla plants whose names match none of the shapes below, so nothing else catches
  // them. They were all being walked AROUND — see the note on `isBareName`; these are the
  // ones that rule does not reach either, because their names are not a suffix of anything.
  'minecraft:allium', 'minecraft:cornflower', 'minecraft:lily_of_the_valley',
  'minecraft:sunflower', 'minecraft:lilac', 'minecraft:peony', 'minecraft:pitcher_plant',
  'minecraft:melon_stem', 'minecraft:pumpkin_stem', 'minecraft:attached_melon_stem',
  'minecraft:attached_pumpkin_stem', 'minecraft:cave_vines', 'minecraft:cave_vines_plant',
  'minecraft:spore_blossom', 'minecraft:torchflower_crop', 'minecraft:pitcher_crop',
]);

const PASSABLE_SUFFIX = [
  '_sapling', '_flower', '_torch', '_sign', '_banner', '_rail', '_button',
  '_pressure_plate', '_carpet', '_fern', '_grass', '_bush', '_roots', '_sprouts',
  '_mushroom', '_lichen', '_coral', '_coral_fan', '_coral_wall_fan', '_plate',
  '_tulip', '_orchid', '_bluet', '_daisy', '_lily', '_poppy', '_dandelion',
  // MEASURED AGAINST THIS WORLD, not guessed at. A parity audit of modded collision found
  // 137 cells of Farmer's Delight crop — rice, rice panicles, wild onions, wild beetroots,
  // a sandy shrub — falling through to "unlisted, therefore solid" and standing in the
  // world as walls. A rice paddy you cannot walk across looks exactly like a pathfinding
  // bug and is not one; these have no collision box in the game at all, so the server and
  // the planner only agree once they are listed here.
  //
  // Suffixes rather than the five exact names, because the name SHAPE is what other mods
  // copy — the same reason the vanilla entries above are suffixes.
  '_panicles', '_onions', '_beetroots', '_shrub', '_rice',
];

/**
 * Blocks a body may not occupy AND may not stand on.
 *
 * These are the ones where routing "onto" them is the failure. Water is the clear case: it
 * has no collision box, so treating it as air would have the planner route a swim; and it
 * has a surface, so treating it as solid would have the planner route a walk ON it. Both
 * are wrong, and the character's swimming is not something this control path can steer.
 */
const AVOID_EXACT = new Set([
  'minecraft:water', 'minecraft:flowing_water', 'minecraft:bubble_column',
  'minecraft:lava', 'minecraft:flowing_lava',
  'minecraft:fire', 'minecraft:soul_fire', 'minecraft:cactus', 'minecraft:magma_block',
  'minecraft:powder_snow', 'minecraft:cobweb', 'minecraft:sweet_berry_bush',
  'minecraft:wither_rose', 'minecraft:campfire', 'minecraft:soul_campfire',
  'minecraft:end_portal', 'minecraft:nether_portal', 'minecraft:end_gateway',
  'minecraft:pointed_dripstone',
]);

/** The state name without its properties: `minecraft:oak_stairs[facing=north]` -> the name. */
export function nameOf(stateKey: string): string {
  const bracket = stateKey.indexOf('[');
  return bracket < 0 ? stateKey : stateKey.slice(0, bracket);
}

/**
 * Modded blocks that carry no collision and whose name does not end in a shape this knows.
 *
 * A short list on purpose. Everything here was seen in the live world and checked against
 * what the game actually does, because the cost of being wrong is not symmetric: a plant
 * wrongly called solid is a silly detour, and a wall wrongly called air is a route the
 * character walks into and gives up on.
 */
const MODDED_PASSABLE = new Set([
  'farmersdelight:rice', 'farmersdelight:rice_panicles',
  'farmersdelight:wild_onions', 'farmersdelight:wild_beetroots',
  'farmersdelight:sandy_shrub',
]);

/**
 * WHAT IS DELIBERATELY NOT HERE: `computercraft:cable`, all 577 cells of it.
 *
 * A cable's real collision is a thin cross, and this table has no way to say that — the
 * three classes are "a body may occupy it", "it may stand on it" and "avoid it", and a
 * cable is none of those cleanly. Unlisted it resolves to a full cube, which makes the
 * planner walk AROUND a cable. That is the wrong answer and it is the SAFE wrong answer:
 * the route is a little longer and the character still arrives. Listed as passable it would
 * be a route planned straight through a cable the SERVER still collides with, and the walk
 * would end in "stuck" against geometry the browser insists is not there — which is the
 * exact failure this whole file's "unknown means solid, always" rule exists to prevent.
 *
 * The real fix is a collision box, not a class: extract modded shapes the way
 * `harness/src/mcextract/ExtractPhysics.java` extracts vanilla ones, and let
 * block-shapes.ts serve them at tier 1. Until then this stays a detour rather than a trap.
 */

/**
 * Is this the WHOLE block name, after the namespace, rather than the tail of a longer one?
 *
 * `minecraft:dandelion` was a WALL. The suffix list carries `_dandelion`, `_fern`,
 * `_poppy` and so on because that is the shape modded names copy — but a suffix beginning
 * with an underscore cannot match a block simply called `dandelion`, and vanilla names a
 * good few of its plants with no prefix at all. So the character walked around dandelions,
 * ferns and poppies, and the table said it was working. Found by the first test ever
 * written against `classifyName`, which is the argument for having written it.
 *
 * So a suffix `_x` also matches a block whose name is exactly `x` in any namespace. That is
 * the same claim the suffix already makes — "a block called this is a plant" — with the
 * separator made optional rather than required.
 */
function isBareName(name: string, suffix: string): boolean {
  const colon = name.lastIndexOf(':');
  return name.slice(colon + 1) === suffix.slice(1);
}

export function classifyName(name: string): NavClass {
  if (MODDED_PASSABLE.has(name)) return 'air';
  if (AVOID_EXACT.has(name)) return 'avoid';
  if (PASSABLE_EXACT.has(name)) return 'air';
  for (const suffix of PASSABLE_SUFFIX) {
    if (name.endsWith(suffix) || isBareName(name, suffix)) return 'air';
  }
  return 'solid';
}

/**
 * Wrap a rendered `World` as something the planner can walk.
 *
 * The classification is cached BY GLOBAL STATE ID, which is what makes this affordable: a
 * search expands thousands of cells and looks at four or five blocks for each, but a chunk
 * has a few hundred distinct states in it, so after the first few cells every lookup is an
 * array index. The cache is safe because a state id's meaning never changes — the world's
 * palette only ever grows.
 */
export function navWorld(world: World): NavWorld {
  const cache: NavClass[] = [];
  return {
    classify(x, y, z) {
      const id = world.getState(x, y, z);
      if (id === AIR_ID) return 'air';
      let c = cache[id];
      if (!c) {
        c = classifyName(nameOf(world.palette[id] ?? ''));
        cache[id] = c;
      }
      return c;
    },
    known(x, y, z) {
      // Outside the built height the world has nothing to say, and `getState` would answer
      // AIR — which reads as "walkable" and is how a planner ends up routing through the
      // void under the map.
      if (y < world.minY || y > world.maxY) return false;
      return world.getChunk(x >> 4, z >> 4) !== undefined;
    },
  };
}
