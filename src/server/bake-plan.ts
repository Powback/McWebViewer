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

/**
 * The bundle format the baker writes. Bump it when the BAKER's output for an unchanged
 * world changes — a new geometry rule, a synthesised sprite, a serialisation change — so a
 * bundle a previous build wrote is re-baked once even though the world has nothing new.
 * Without this the set comparison below would happily keep serving stale geometry for ever.
 *
 *   1  original
 *   2  block-entity overlays (a CC:T monitor bakes with its screen) + the `mcwv:` builtin
 *      sprites they use
 *   3  an overlaid face counts as opaque for occlusion (monitors hide their neighbours'
 *      faces, so merged screens have no seams)
 *   4  turtle tool upgrades bake as a single outward face (the two-faced card drew a
 *      mirrored twin)
 *   5  painted surfaces are a structural rule (block entity + full cube + see-through face)
 *      and upgrade models resolve generically; flat items face image-top-forward *   6  upgrade models also match the mod's own sided models by shared name words (a
 *      modem is CC:T's modem model again)
 */
export const BAKE_FORMAT = 6;

/** The parts of a served `assets.json` the decision reads. */
export interface BundleInventory {
  /** BAKE_FORMAT of the baker that wrote it; absent in the earliest bundles. */
  version?: number;
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
  reasons.push(...formatReason(bundle));
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

/** A bundle an older baker wrote is stale once, however complete its inventory is. */
function formatReason(bundle: BundleInventory): string[] {
  const v = bundle.version ?? 0;
  return v < BAKE_FORMAT ? [`bundle format ${v} predates the baker's ${BAKE_FORMAT}`] : [];
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
