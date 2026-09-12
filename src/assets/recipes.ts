/**
 * Recipes, read structurally rather than per mod.
 *
 * Recipes ARE data — every one of them is a JSON file in a mod's own jar under
 * `data/<ns>/recipe/` — so this should be generic across all 130 mods for free. Measured
 * across the real jar set: **12,809 recipe files in 54 jars**, and 96.9% of them expose
 * their inputs and outputs through a small set of field names that nothing mod-specific is
 * needed to read.
 *
 * WHERE THE GENERICITY ACTUALLY BREAKS, measured rather than assumed. A recipe type's
 * *processing* fields are mod-defined and unbounded — `heat_requirement`, `processing_time`,
 * `accept_mirrored`, `chance` — but those are EXTRA fields, not obstacles: they do not stop
 * the inputs and outputs being read. What genuinely cannot be read structurally is a recipe
 * that names neither through any recognised field, and that is the remaining ~3%:
 *
 *   ammo / weight               cannon ammunition tables (createbigcannons)
 *   input_cell / result_cell    AE2 storage-cell upgrades
 *   block / components          block-transform recipes with no item output
 *
 * Those are COUNTED and reported, not special-cased. The moment this file names a mod it
 * has stopped being generic, and a coverage number that quietly excludes what it cannot do
 * is the thing this project keeps fixing.
 *
 * One vanilla shape is worth handling explicitly and is not a mod special case: smithing
 * (`base` + `addition` + `template`) is vanilla's own field naming, listed alongside the
 * others rather than as an exception.
 */

/** One input. A tag is left AS a tag: expanding it needs the tag files, and it is honest. */
export interface RecipeIngredient {
  kind: 'item' | 'tag' | 'fluid';
  id: string;
  /** millibuckets for a fluid, items otherwise; absent means one */
  amount?: number;
}

export interface RecipeOutput {
  id: string;
  count: number;
  /** Create-style secondary outputs carry a probability; absent means certain */
  chance?: number;
  fluid?: boolean;
}

export interface Recipe {
  /** `create:mixing/tea`, from the file path */
  id: string;
  /** `create:mixing` */
  type: string;
  inputs: RecipeIngredient[];
  outputs: RecipeOutput[];
  /** shaped crafting only, so a grid can be drawn */
  pattern?: string[];
  /** the key map for a pattern: symbol -> the ingredients it stands for */
  key?: Record<string, RecipeIngredient[]>;
}

/** Every field name that has ever held an input, across the whole jar set. */
const INPUT_FIELDS = ['ingredients', 'ingredient', 'inputs', 'input', 'base', 'addition', 'template'];
/** ...and an output. 1.21 spells a result's item `id`; older and some modded ones use `item`. */
const OUTPUT_FIELDS = ['result', 'results', 'output', 'outputs'];

/**
 * One ingredient, in any of the shapes the jars actually use.
 *
 * `{item}`, `{tag}`, `{fluid}`, a bare string, or a nested `{value}` — plus arrays of those
 * for "any of these". Returns a LIST because alternatives are one input slot, not several.
 */
export function readIngredient(raw: unknown): RecipeIngredient[] {
  if (typeof raw === 'string') return [{ kind: 'item', id: raw }];
  if (Array.isArray(raw)) return raw.flatMap(readIngredient);
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  // NeoForge wraps alternatives and tag ingredients in `value`.
  if (o.value !== undefined) return readIngredient(o.value);
  return ingredientFields(o);
}

/** The four field names an ingredient's identity can live under, in priority order. */
function ingredientFields(o: Record<string, unknown>): RecipeIngredient[] {
  const amount = typeof o.amount === 'number' ? o.amount : undefined;
  for (const [field, kind] of [
    ['fluid', 'fluid'], ['tag', 'tag'], ['item', 'item'], ['id', 'item'],
  ] as Array<[string, RecipeIngredient['kind']]>) {
    if (typeof o[field] === 'string') return [{ kind, id: o[field] as string, amount }];
  }
  return [];
}

/** One output, in any of the shapes the jars use. */
export function readOutput(raw: unknown): RecipeOutput[] {
  if (typeof raw === 'string') return [{ id: raw, count: 1 }];
  if (Array.isArray(raw)) return raw.flatMap(readOutput);
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const count = numberOr(o.count, numberOr(o.amount, 1));
  const chance = typeof o.chance === 'number' ? o.chance : undefined;
  if (typeof o.fluid === 'string') return [{ id: o.fluid, count, chance, fluid: true }];
  // 1.21 names a result's item `id`; `item` is the older spelling and several mods kept it.
  const id = typeof o.id === 'string' ? o.id : typeof o.item === 'string' ? o.item : null;
  return id ? [{ id, count, chance }] : [];
}

function numberOr(v: unknown, dflt: number): number {
  return typeof v === 'number' ? v : dflt;
}

/** `data/create/recipe/mixing/tea.json` -> `create:mixing/tea`. */
export function recipeIdFromPath(path: string): string | null {
  const m = /^data\/([^/]+)\/recipe\/(.+)\.json$/.exec(path);
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * Parse one recipe file. Returns null when neither an input nor an output can be read.
 *
 * Deliberately tolerant about everything else: an unknown `type`, unknown processing
 * fields and `neoforge:conditions` all pass through untouched, because none of them stops
 * the inputs and outputs being understood.
 */
export function parseRecipe(id: string, raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : 'unknown';

  const outputs = collect(o, OUTPUT_FIELDS, readOutput);
  const key = readKey(o.key);
  const inputs = [
    ...(key ? Object.values(key).flat() : []),
    ...collect(o, INPUT_FIELDS, readIngredient),
  ];
  if (!inputs.length && !outputs.length) return null;
  const pattern = readPattern(o.pattern);
  return { id, type, inputs, outputs, ...(pattern ? { pattern } : {}), ...(key ? { key } : {}) };
}

/** Gather every recognised field into one list, in the order the names are listed. */
function collect<T>(
  o: Record<string, unknown>, fields: readonly string[], read: (v: unknown) => T[],
): T[] {
  const out: T[] = [];
  for (const f of fields) if (o[f] !== undefined) out.push(...read(o[f]));
  return out;
}

/** A shaped recipe's symbol map, or undefined when there is none. */
function readKey(raw: unknown): Record<string, RecipeIngredient[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, RecipeIngredient[]> = {};
  for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
    const ing = readIngredient(v);
    if (ing.length) out[sym] = ing;
  }
  return Object.keys(out).length ? out : undefined;
}

function readPattern(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) return undefined;
  return raw as string[];
}

/** Everything a recipe consumes or produces, for building the "what uses this" index. */
export function itemsOf(r: Recipe): { inputs: string[]; outputs: string[] } {
  return {
    inputs: [...new Set(r.inputs.map((i) => (i.kind === 'tag' ? `#${i.id}` : i.id)))],
    outputs: [...new Set(r.outputs.map((o) => o.id))],
  };
}
