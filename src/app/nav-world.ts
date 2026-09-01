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
]);

const PASSABLE_SUFFIX = [
  '_sapling', '_flower', '_torch', '_sign', '_banner', '_rail', '_button',
  '_pressure_plate', '_carpet', '_fern', '_grass', '_bush', '_roots', '_sprouts',
  '_mushroom', '_lichen', '_coral', '_coral_fan', '_coral_wall_fan', '_plate',
  '_tulip', '_orchid', '_bluet', '_daisy', '_lily', '_poppy', '_dandelion',
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
function nameOf(stateKey: string): string {
  const bracket = stateKey.indexOf('[');
  return bracket < 0 ? stateKey : stateKey.slice(0, bracket);
}

function classifyName(name: string): NavClass {
  if (AVOID_EXACT.has(name)) return 'avoid';
  if (PASSABLE_EXACT.has(name)) return 'air';
  for (const suffix of PASSABLE_SUFFIX) if (name.endsWith(suffix)) return 'air';
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
