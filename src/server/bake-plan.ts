/**
 * When does the bake need redoing?
 *
 * The baked bundle is a snapshot of the block states, biomes and entity types the world
 * contained when it was made. The world is live: turtles place blocks the bake has never
 * seen, and every such state renders as NOTHING — the mesher resolves it to an empty model
 * and moves on. That is how a viewer comes to show a tower with no walls while the region
 * file on disk has them. Found on the reference server: nine stone-brick states in the
 * world, none in a bundle three days old, and the live sync faithfully re-reading chunks
 * it could not draw.
 *
 * So staleness is a SET comparison, not a timestamp: a bundle is stale exactly when the
 * world contains something it does not. Pure, so the decision is testable without jars or
 * a world; the tool wraps it in a scan and a loop.
 */

export interface WorldInventory {
  states: Iterable<string>;
  biomes: Iterable<string>;
  entityTypes: Iterable<string>;
  regions: readonly string[];
}

/** The parts of a served `assets.json` the decision reads. */
export interface BundleInventory {
  states: Record<string, unknown>;
  biomes: Record<string, unknown>;
  /** Absent in bundles baked before this field existed; treated as stale once. */
  entityTypes?: readonly string[];
  regions: readonly string[];
}

export interface BakePlan {
  needed: boolean;
  /** One line per kind of thing missing, each naming examples. Empty when up to date. */
  reasons: string[];
  /** Every state the world has that the bundle lacks — what the HUD counts as NOT IN BAKE. */
  missingStates: string[];
}

const EXAMPLES = 4;

export function planBake(world: WorldInventory, bundle: BundleInventory | null): BakePlan {
  const states = [...world.states];
  if (!bundle) return { needed: true, reasons: ['no bundle yet'], missingStates: states };

  const reasons: string[] = [];
  const missingStates = states.filter((k) => !has(bundle.states, k));
  if (missingStates.length) reasons.push(describe('state', missingStates));

  const biomes = [...world.biomes].filter((k) => !has(bundle.biomes, k));
  if (biomes.length) reasons.push(describe('biome', biomes));

  if (!bundle.entityTypes) {
    reasons.push('bundle predates entity-type tracking');
  } else {
    const have = new Set(bundle.entityTypes);
    const types = [...world.entityTypes].filter((k) => !have.has(k));
    if (types.length) reasons.push(describe('entity type', types));
  }

  if (!sameSet(world.regions, bundle.regions)) {
    reasons.push(`regions changed: ${bundle.regions.join(',') || '(none)'} -> ${world.regions.join(',')}`);
  }

  return { needed: reasons.length > 0, reasons, missingStates };
}

function describe(kind: string, missing: readonly string[]): string {
  const shown = missing.slice(0, EXAMPLES).join(', ');
  const more = missing.length > EXAMPLES ? `, +${missing.length - EXAMPLES} more` : '';
  return `${missing.length} ${kind}${missing.length === 1 ? '' : 's'} not in bundle: ${shown}${more}`;
}

/** Own keys only: `'constructor' in {}` is true, and a block may be called anything. */
function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
