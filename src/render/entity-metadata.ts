/**
 * Entity appearance from SpacetimeDB's `entity.appearance`, translated into the shape the
 * existing rules already read.
 *
 * The mirror publishes raw `SynchedEntityData` scalars as `{"<index>": value}` and
 * deliberately does not say what they mean — correctly, because **the indices are a property
 * of the pack, not of Minecraft**. On this modpack two mods add fields to `LivingEntity`, so
 * every subclass index shifts by two: sheep wool colour is 19 here, not the 17 every protocol
 * reference lists. A vanilla index table would be wrong, and wrong in the quiet way — it
 * would pick up a neighbouring field and render a plausible wrong colour.
 *
 * SO THE OFFSET IS A SETTING, NOT A CONSTANT. The rules below are written in VANILLA indices
 * and the offset is applied once, in one place. That keeps each rule readable as "sheep
 * colour is vanilla index 17" and makes the next pack a one-number change instead of a
 * rewrite.
 *
 * **It cannot be derived offline, and that is an honest dead end rather than a missing
 * feature.** The shift comes from mixin-injected fields in the running server's class
 * hierarchy; the extraction harness boots vanilla without mods and would report the vanilla
 * indices, which is precisely the wrong answer. The measurement procedure that produced the
 * default is:
 *
 *   1. Summon a mob with known NBT:  `/summon sheep ~ ~ ~ {Color:14b}`
 *   2. Read the column back:         `SELECT appearance FROM entity WHERE type_name='minecraft:sheep'`
 *   3. The index carrying 14 is the pack's sheep-colour index; subtract vanilla's 17.
 *
 * That is the same shape of answer as `animateTick` being imperative Java: measured, written
 * down next to its procedure, and re-measurable in a minute when the pack changes.
 *
 * TWO WIRE SEMANTICS THAT ARE EASY TO GET BACKWARDS:
 *
 * - **An absent index means DEFAULT, not unknown.** The server sends only what differs from
 *   the class defaults, so a WHITE sheep has no colour field at all. Returning "no
 *   appearance" for it would render the common case wrong.
 * - **Item-shaped entities have no blob.** The metadata walk stops at `ItemStack`, which
 *   since 1.20.5 is a data-component patch no generic reader can measure. Dropped items and
 *   item frames arrive with nothing, and their appearance IS the stack — so they keep the
 *   bridge path's behaviour and are not faked here.
 */

/** Raw scalars as the mirror publishes them, keyed by the pack's own metadata index. */
export type MetadataBlob = Record<string, unknown>;

/**
 * How far this pack's `LivingEntity` indices are shifted from vanilla's.
 *
 * Measured +2 on the reference modpack; see the procedure in the header. Settable because
 * the next pack moves it again.
 */
let indexOffset = 2;

export function setMetadataOffset(n: number): void {
  indexOffset = Number.isFinite(n) ? n : 0;
}

export function metadataOffset(): number {
  return indexOffset;
}

/** Look up a VANILLA index, applying the pack's shift. */
function at(meta: MetadataBlob, vanillaIndex: number): unknown {
  return meta[String(vanillaIndex + indexOffset)];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A registry's entries, as the bundle carries them: name -> { texture?, id? }. */
export type VariantTable = Record<string, { texture?: string; id?: number }>;

export interface MetadataContext {
  /** a registry's entries, for turning a network int back into a name */
  registry?: (name: string) => VariantTable | undefined;
}

/**
 * Turn a metadata blob into the NBT-shaped object `appearanceOf` already understands.
 *
 * Deliberately an ADAPTER rather than a second set of rules: the sheep-wool, wolf-coat,
 * villager-robe and horse-coat logic lives in `entity-layers.ts` and is shared by both
 * sources, so the two can only diverge in what they are fed, never in what they decide.
 */
export function nbtFromMetadata(
  type: string, meta: MetadataBlob, ctx: MetadataContext = {},
): Record<string, unknown> {
  const rule = RULES[type];
  return rule ? rule(meta, ctx) : {};
}

type Rule = (meta: MetadataBlob, ctx: MetadataContext) => Record<string, unknown>;

/** `3` in `cat_variant` -> `minecraft:siamese`; null when the registry is not carried. */
export function nameForId(
  ctx: MetadataContext, registry: string, id: number | null,
): string | null {
  if (id === null) return null;
  const table = ctx.registry?.(registry);
  if (!table) return null;
  for (const [name, row] of Object.entries(table)) {
    if (row.id === id) return name;
  }
  return null;
}

const RULES: Record<string, Rule> = {
  // Sheep pack both facts into one byte: 0x10 is the sheared flag and the low nibble is the
  // dye. A sheared sheep and a white one are different appearances, so both are read.
  'minecraft:sheep': (meta) => {
    const b = num(at(meta, 17));
    if (b === null) return {};
    return { Color: b & 0x0f, Sheared: (b & 0x10) !== 0 ? 1 : 0 };
  },
  // The horse's variant is the same packed integer the NBT carries, so it needs no lookup.
  'minecraft:horse': (meta) => {
    const v = num(at(meta, 18));
    return v === null ? {} : { Variant: v };
  },
  'minecraft:villager': (meta, ctx) => {
    const d = at(meta, 18);
    if (!Array.isArray(d) || d.length < 3) return {};
    const type = nameForId(ctx, 'villager_type', num(d[0]));
    const profession = nameForId(ctx, 'villager_profession', num(d[1]));
    if (!type && !profession) return {};
    return {
      VillagerData: {
        ...(type ? { type } : {}),
        ...(profession ? { profession } : {}),
        level: num(d[2]) ?? 1,
      },
    };
  },
  'minecraft:cat': (meta, ctx) => variantByRegistry(meta, ctx, 19, 'cat_variant'),
  'minecraft:frog': (meta, ctx) => variantByRegistry(meta, ctx, 17, 'frog_variant'),
  // The axolotl's rule reads the raw int, so it needs no registry.
  'minecraft:axolotl': (meta) => {
    const v = num(at(meta, 17));
    return v === null ? {} : { Variant: v };
  },
  // Only the COLLAR is reachable: a wolf's variant is a datapack registry, which the mirror
  // does not carry, so there is no way to turn its index into a name. A wolf therefore keeps
  // its default coat in this source — stated in the inventory rather than papered over.
  'minecraft:wolf': (meta) => {
    const c = num(at(meta, 20));
    return c === null ? {} : { CollarColor: c };
  },
};

function variantByRegistry(
  meta: MetadataBlob, ctx: MetadataContext, vanillaIndex: number, registry: string,
): Record<string, unknown> {
  const name = nameForId(ctx, registry, num(at(meta, vanillaIndex)));
  return name ? { variant: name } : {};
}

/**
 * Parse the mirror's column into a blob, or null when the row carries none.
 *
 * The column is a tagged option: `[0, "<json>"]` carries data and `[1, []]` does not, which
 * is how an item-shaped entity arrives. A malformed payload is treated as absent rather than
 * thrown, because one bad row must not stop a world rendering.
 */
export function parseAppearance(column: unknown): MetadataBlob | null {
  const raw = Array.isArray(column) && column.length === 2 && column[0] === 0
    ? column[1]
    : column;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as MetadataBlob)
      : null;
  } catch {
    return null;
  }
}
