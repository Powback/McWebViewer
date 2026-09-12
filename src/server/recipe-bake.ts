/**
 * Bake every recipe in the pack stack into one file the browser can read.
 *
 * Same shape of decision as the asset bake: the browser must not fetch 130 jars and parse
 * 12,809 JSON files to show a crafting grid, so the parsing happens once on the server and
 * the result is served as a single artifact.
 *
 * Nothing here knows about any mod. It walks `data/<ns>/recipe/**.json` across the whole
 * stack — vanilla jar, every mod jar, every resource pack, in Minecraft's own precedence
 * order, so a pack that overrides a recipe wins exactly as it does in game — and parses each
 * one structurally (see assets/recipes.ts).
 *
 * COVERAGE IS REPORTED, NOT ASSUMED. Recipes whose inputs and outputs cannot be read through
 * any known field are counted and their types listed, so the number is checkable and the
 * gaps are nameable. Quietly dropping them would make the coverage figure a lie.
 */

import { RECIPE_PATH, type Pack } from '../assets/pack.js';
import { parseRecipe, recipeIdFromPath, itemsOf, type Recipe } from '../assets/recipes.js';

export interface RecipeBundle {
  generated: string;
  recipes: Recipe[];
  /** item or `#tag` -> indices of recipes that PRODUCE it */
  madeBy: Record<string, number[]>;
  /** item or `#tag` -> indices of recipes that CONSUME it */
  usedIn: Record<string, number[]>;
  stats: {
    files: number;
    parsed: number;
    unreadable: number;
    /** the recipe types that could not be read, with counts — the honest gap list */
    unreadableTypes: Record<string, number>;
    types: number;
  };
}

const decoder = new TextDecoder();

/**
 * Read every recipe the stack contains.
 *
 * `pack.list('data/')` is the only enumeration needed: the filter in `defaultFilter` has
 * already kept exactly the recipe files, so this does not have to re-derive which paths
 * matter.
 */
export function bakeRecipes(pack: Pack): RecipeBundle {
  const recipes: Recipe[] = [];
  const unreadableTypes: Record<string, number> = {};
  const types = new Set<string>();
  let files = 0;
  let unreadable = 0;

  for (const path of pack.list('data/')) {
    if (!RECIPE_PATH.test(path) || !path.endsWith('.json')) continue;
    files++;
    const parsed = readOne(pack, path, unreadableTypes);
    if (!parsed) { unreadable++; continue; }
    types.add(parsed.type);
    recipes.push(parsed);
  }

  return {
    generated: new Date().toISOString(),
    recipes,
    ...buildIndexes(recipes),
    stats: { files, parsed: recipes.length, unreadable, unreadableTypes, types: types.size },
  };
}

/**
 * One file. Null means unreadable, and WHY is recorded against its type so the gap can be
 * named rather than just counted.
 */
function readOne(pack: Pack, path: string, unreadableTypes: Record<string, number>): Recipe | null {
  const id = recipeIdFromPath(path);
  const bytes = pack.get(path);
  if (!id || !bytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    // A recipe file that is not JSON is a broken jar, not a recipe we failed to read.
    unreadableTypes['<invalid json>'] = (unreadableTypes['<invalid json>'] ?? 0) + 1;
    return null;
  }
  const parsed = parseRecipe(id, raw);
  if (parsed) return parsed;
  const t = typeof (raw as { type?: unknown })?.type === 'string'
    ? String((raw as { type: string }).type)
    : '<no type>';
  unreadableTypes[t] = (unreadableTypes[t] ?? 0) + 1;
  return null;
}

/**
 * Two lookups: what makes a thing, and what a thing is used in.
 *
 * Built here rather than in the browser because they are the whole point of having the
 * bundle — scanning 12,000 recipes per click would make the panel feel broken — and because
 * they compress well, being arrays of small integers.
 */
function buildIndexes(recipes: readonly Recipe[]): {
  madeBy: Record<string, number[]>;
  usedIn: Record<string, number[]>;
} {
  const madeBy: Record<string, number[]> = {};
  const usedIn: Record<string, number[]> = {};
  recipes.forEach((r, i) => {
    const { inputs, outputs } = itemsOf(r);
    for (const o of outputs) (madeBy[o] ??= []).push(i);
    for (const inp of inputs) (usedIn[inp] ??= []).push(i);
  });
  return { madeBy, usedIn };
}
