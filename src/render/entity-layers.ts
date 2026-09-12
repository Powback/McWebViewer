/**
 * Secondary entity layers: the parts of a mob that are NOT its base model.
 *
 * Vanilla builds a mob out of a base model plus a stack of `RenderLayer`s — the wool on a
 * sheep, the collar on a wolf, the profession robe on a villager, armour on anything. The
 * extraction captured base models only (`entity-index.json` lists `allModels:
 * ["minecraft:sheep#main"]`), so every mob here renders as its bare body.
 *
 * WHAT THIS COVERS, AND WHY THOSE. Measured against the live world's 713 entities, because
 * a layer nothing in the world triggers is a layer nobody can see:
 *
 *   sheep wool          28 of 28 sheep, none sheared  -> all 28 look shorn today
 *   wolf variant coat   27 of 31 wolves are woods/chestnut, drawn with the pale texture
 *   horse coat          5 of 5 horses, all drawn white regardless of their Variant
 *
 * And what is deliberately NOT here, with the number that decided it:
 *
 *   mob armour          0 of 713 entities wear any
 *   wolf / cat collars  0 of 33 are tamed, and vanilla draws the collar only when tame
 *   horse saddle+armour 0 of 6 equines carry either
 *   donkey chest        0 of 1
 *
 * Those are real vanilla layers and the machinery below would carry them, but none of them
 * can be verified against this world, and shipping geometry no measurement can confirm is
 * how a renderer accumulates plausible-looking bugs.
 *
 * THE WOLF COAT IS READ FROM THE DATAPACK, NOT FROM A TABLE. `data/<ns>/wolf_variant/
 * <name>.json` carries `wild_texture` / `tame_texture` / `angry_texture`, so a mod that
 * adds a wolf variant works with no code change. That is the same reason the sheep tint is
 * extracted rather than written down (see DYE_RGB).
 */

/** One drawable layer: a model from the extraction, a texture, and an optional tint. */
export interface EntityLayer {
  /** key into entity-models.json, e.g. `minecraft:sheep#fur` */
  model: string | null;
  /** `assets/<ns>/textures/<path>.png`, or null to keep the base entry's texture */
  texture: string | null;
  /** multiply colour, or null for none */
  tint: readonly [number, number, number] | null;
}

export interface EntityAppearance {
  /**
   * Cache identity. Two entities with the same key are the same geometry and must share a
   * mesh — without this a world of 28 sheep meshes 28 times instead of once per colour.
   */
  key: string;
  layers: EntityLayer[];
}

/** What the caller can tell us about the packs, for the data-driven lookups. */
export interface AppearanceContext {
  /**
   * `data/<ns>/<registry>/<name>.json` as parsed JSON, or null. Registry is e.g.
   * `wolf_variant`. Injected so this module stays pure and testable.
   */
  variant?: (registry: string, id: string) => Record<string, unknown> | string | null;
  /** every id in a variant registry, for picking a default when a mob has no fixed texture */
  variantIds?: (registry: string) => Iterable<string>;
}

type Nbt = Record<string, unknown>;

const num = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The base layer every entity has: whatever the index already resolved. */
const BASE: EntityLayer = { model: null, texture: null, tint: null };

/**
 * The appearance of one entity.
 *
 * Always returns at least the base layer, so a caller can use this unconditionally; `key`
 * is `''` for an entity with nothing special about it, which keeps the common path on the
 * existing per-type mesh cache.
 */
export function appearanceOf(type: string, nbt: Nbt, ctx: AppearanceContext = {}): EntityAppearance {
  const build = RULES[type];
  if (!build) return { key: '', layers: [BASE] };
  // A rule returns the COMPLETE stack, base included, so a rule that both swaps the base
  // texture and adds an overlay (a horse: coat, then markings) says so directly rather
  // than through a convention about what its first element means.
  const layers = build(nbt, ctx);
  if (!layers.length) return { key: '', layers: [BASE] };
  return { key: keyOf(type, layers), layers };
}

function keyOf(type: string, layers: EntityLayer[]): string {
  const parts = layers.map((l) => `${l.model ?? ''}|${l.texture ?? ''}|${l.tint?.join(',') ?? ''}`);
  return `${type}#${parts.join(';')}`;
}

type Rule = (nbt: Nbt, ctx: AppearanceContext) => EntityLayer[];

const RULES: Record<string, Rule> = {
  'minecraft:sheep': sheepLayers,
  'minecraft:wolf': wolfLayers,
  'minecraft:horse': horseLayers,
  'minecraft:villager': villagerLayers,
  'minecraft:zombie_villager': villagerLayers,
  'minecraft:cat': registryCoat('cat_variant'),
  'minecraft:frog': registryCoat('frog_variant'),
  'minecraft:axolotl': registryCoat('axolotl_variant'),
};

/** An integer variant id as a table key, or null when there is not one. */
function numKey(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : String(n);
}

/**
 * A mob whose whole skin is a registry entry's texture.
 *
 * Cats and frogs work like wolves — the variant decides the texture — but their variants are
 * a BUILT-IN registry rather than a datapack, so there is no JSON to read and the mapping is
 * extracted from the running game instead (`ExtractPhysics.extractEntityVariants`). The
 * effect of not having it was total: the entity index could not pick one texture for a cat,
 * left it null, and all of this world's cats drew nothing at all.
 *
 * The registry gives a plain ResourceLocation with `textures/` and `.png` already in the
 * path, which is a different shape from the datapack's `{wild,tame,angry}` object — hence a
 * separate converter rather than reusing `texturePathOf`.
 */
function registryCoat(registry: string): Rule {
  return (nbt, ctx) => {
    // Cats and frogs name their variant; an axolotl stores an INT, because its variants are
    // a Java enum indexed by id rather than a registry keyed by name. Both end up as a key
    // into the same extracted table.
    const variant = str(nbt.variant) ?? numKey(nbt.Variant);
    if (!variant) return [];
    const entry = ctx.variant?.(registry, variant);
    const texture = typeof entry === 'string' ? entry : str((entry as Nbt | null)?.texture);
    const path = texture ? assetPathOf(texture) : null;
    return path ? [{ model: null, texture: path, tint: null }] : [];
  };
}

/**
 * A stand-in texture for a mob whose real one is per-variant.
 *
 * The entity index stores ONE texture per type and leaves it null when the renderer picks
 * from a registry — which made `geometryFor` refuse to draw a cat at all, before any
 * appearance rule could supply the right coat. This gives such a type a default so it is
 * drawable, and the per-entity rule then overrides it. Any variant will do; the first is
 * taken because the registry has no notion of a canonical one.
 */
export function defaultVariantTexture(
  entityType: string, ctx: AppearanceContext,
): string | null {
  const registry = REGISTRY_COATS[entityType];
  if (!registry || !ctx.variantIds) return null;
  for (const id of ctx.variantIds(registry)) {
    const entry = ctx.variant?.(registry, id);
    const texture = typeof entry === 'string' ? entry : str((entry as Nbt | null)?.texture);
    if (texture) return assetPathOf(texture);
  }
  return null;
}

/** Entity types whose whole skin comes from a built-in variant registry. */
const REGISTRY_COATS: Record<string, string> = {
  'minecraft:cat': 'cat_variant',
  'minecraft:frog': 'frog_variant',
  'minecraft:axolotl': 'axolotl_variant',
};

/** `minecraft:textures/entity/cat/tabby.png` -> `assets/minecraft/textures/entity/cat/tabby.png` */
export function assetPathOf(id: string): string {
  const i = id.indexOf(':');
  const ns = i < 0 ? 'minecraft' : id.slice(0, i);
  const path = i < 0 ? id : id.slice(i + 1);
  return `assets/${ns}/${path}`;
}

// ---------------------------------------------------------------------------
// Villager

/**
 * Biome robe, profession robe, and the rank badge — all on the villager's own model.
 *
 * Vanilla's `VillagerProfessionLayer` draws the TYPE overlay unconditionally, the
 * PROFESSION overlay unless the profession is `none`, and the level badge unless the
 * profession is `none` or `nitwit`. Following that exactly matters here: measured, 5 of
 * this world's 7 villagers are unemployed, so a rule that only drew professions would have
 * changed nothing for five of them — while the biome robe applies to all seven.
 *
 * Modded professions work unchanged: the id becomes the texture path, which is the same
 * convention vanilla's own `getResourceLocation` uses.
 */
function villagerLayers(nbt: Nbt): EntityLayer[] {
  const data = nbt.VillagerData;
  if (!data || typeof data !== 'object') return [];
  const d = data as Nbt;
  const out: EntityLayer[] = [BASE];
  const type = str(d.type);
  if (type) out.push(overlay('type', type));
  const profession = str(d.profession);
  if (!profession || bareName(profession) === 'none') return out;
  out.push(overlay('profession', profession));
  // The badge is a rank marker; a nitwit has no rank. Baby villagers do not wear one
  // either, but nothing in the save distinguishes them here beyond `Age`.
  const level = num(d.level) ?? 1;
  const badge = PROFESSION_LEVELS[Math.max(1, Math.min(5, level))];
  if (bareName(profession) !== 'nitwit' && badge) {
    out.push({
      model: null,
      texture: `assets/minecraft/textures/entity/villager/profession_level/${badge}.png`,
      tint: null,
    });
  }
  return out;
}

/** `minecraft:plains` -> the villager/type/plains overlay, namespace preserved for mods. */
function overlay(kind: 'type' | 'profession', id: string): EntityLayer {
  const i = id.indexOf(':');
  const ns = i < 0 ? 'minecraft' : id.slice(0, i);
  const name = i < 0 ? id : id.slice(i + 1);
  return {
    model: null,
    texture: `assets/${ns}/textures/entity/villager/${kind}/${name}.png`,
    tint: null,
  };
}

function bareName(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

/**
 * The rank badge for each trading level. The five names are exactly the five
 * `profession_level/*.png` files in the client jar, which is what fixes the order.
 */
const PROFESSION_LEVELS: Record<number, string> = {
  1: 'stone', 2: 'iron', 3: 'gold', 4: 'emerald', 5: 'diamond',
};

// ---------------------------------------------------------------------------
// Sheep

const SHEEP_FUR_MODEL = 'minecraft:sheep#fur';
const SHEEP_FUR_TEXTURE = 'assets/minecraft/textures/entity/sheep/sheep_fur.png';

/**
 * The wool, when the sheep still has it.
 *
 * `Sheared` is the whole condition — a sheared sheep IS the bare body, which is precisely
 * why the missing layer was invisible as a bug: every sheep looked like a legitimately
 * sheared one rather than like something broken.
 */
function sheepLayers(nbt: Nbt): EntityLayer[] {
  if (num(nbt.Sheared)) return [];
  const colour = num(nbt.Color) ?? 0;
  return [BASE, {
    model: SHEEP_FUR_MODEL,
    texture: SHEEP_FUR_TEXTURE,
    // No inflate needed: the extracted fur model carries grow 0.6 of its own, which is
    // exactly how vanilla stands the wool off the body without z-fighting it.
    tint: sheepTint(colour),
  }];
}

/**
 * Sheep wool colour, indexed by the `Color` byte (which is `DyeColor.getId()`).
 *
 * MEASURED out of the running game via `Sheep.getColor(DyeColor)`, not copied from the dye
 * table — and the difference is real: white wool is 0.9020 grey, while white DYE is
 * 0xf9fffe (0.976, 1.0, 0.996), and every OTHER colour is the dye scaled by ~0.75 — vanilla
 * darkens wool deliberately so a sheep does not blow out. Writing the dye values here was
 * the first attempt and the test below rejected 15 of the 16. `entity-layers.test.ts` re-derives this from
 * `physics.json` so a re-extraction that disagrees fails rather than drifts.
 */
export const SHEEP_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0.9020, 0.9020, 0.9020], [0.7294, 0.3765, 0.0824], [0.5843, 0.2275, 0.5529],
  [0.1686, 0.5255, 0.6392], [0.7451, 0.6353, 0.1765], [0.3765, 0.5843, 0.0902],
  [0.7137, 0.4078, 0.4980], [0.2078, 0.2314, 0.2392], [0.4588, 0.4588, 0.4431],
  [0.0627, 0.4588, 0.4588], [0.4000, 0.1451, 0.5412], [0.1765, 0.2000, 0.4980],
  [0.3843, 0.2471, 0.1451], [0.2745, 0.3647, 0.0627], [0.5176, 0.1333, 0.1098],
  [0.0824, 0.0824, 0.0941],
];

function sheepTint(colour: number): readonly [number, number, number] {
  return SHEEP_RGB[colour] ?? SHEEP_RGB[0];
}

// ---------------------------------------------------------------------------
// Wolf

/**
 * The wolf's coat.
 *
 * Not a second layer at all — a different BASE texture, which is why it returns a single
 * layer with a null model. Vanilla picks wild / tame / angry from the variant's own
 * datapack entry, so this reads that entry rather than pattern-matching the variant name:
 * `wolf_woods.png` happens to follow from `minecraft:woods`, but nothing guarantees a mod's
 * variant does, and the JSON states it outright.
 */
function wolfLayers(nbt: Nbt, ctx: AppearanceContext): EntityLayer[] {
  const variant = str(nbt.variant);
  if (!variant) return [];
  const entry = ctx.variant?.('wolf_variant', variant);
  if (!entry || typeof entry === 'string') return [];
  const tame = nbt.Owner !== undefined || nbt.OwnerUUID !== undefined;
  const angry = (num(nbt.AngerTime) ?? 0) > 0;
  const field = angry ? 'angry_texture' : tame ? 'tame_texture' : 'wild_texture';
  const id = str(entry[field]) ?? str(entry.wild_texture);
  const path = id ? texturePathOf(id) : null;
  return path ? [{ model: null, texture: path, tint: null }] : [];
}

/** `minecraft:entity/wolf/wolf_woods` -> `assets/minecraft/textures/entity/wolf/wolf_woods.png` */
export function texturePathOf(id: string): string {
  const i = id.indexOf(':');
  const ns = i < 0 ? 'minecraft' : id.slice(0, i);
  const path = i < 0 ? id : id.slice(i + 1);
  return `assets/${ns}/textures/${path}.png`;
}

// ---------------------------------------------------------------------------
// Horse

/**
 * The horse's coat colour.
 *
 * `Variant` packs colour in the low byte and markings in the next: `colour | markings << 8`.
 * The index has all seven colour textures but always hands back `horse_white`, so every
 * horse in the world is white today — measured: 5 of 5, with colours chestnut, gray and
 * creamy among them.
 *
 * The MARKINGS overlay is not drawn. It is the same geometry as the body with a
 * mostly-transparent texture, so adding it needs an inflate to avoid z-fighting the coat,
 * and there is no way to check the result is right against a world where every horse is
 * currently white anyway. The coat is the part that reads at a glance.
 */
const HORSE_COATS = [
  'white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'darkbrown',
];

function horseLayers(nbt: Nbt): EntityLayer[] {
  const variant = num(nbt.Variant);
  if (variant === null) return [];
  const coat = HORSE_COATS[variant & 0xff];
  if (!coat) return [];
  const out: EntityLayer[] = [{
    model: null,
    texture: `assets/minecraft/textures/entity/horse/horse_${coat}.png`,
    tint: null,
  }];
  // Markings sit on the same model as the coat, drawn after it. No inflate: the entity
  // material's depth function is three.js's default LessEqualDepth, so exactly-coplanar
  // geometry submitted later wins the depth test — which is precisely how vanilla layers
  // a horse's markings and a villager's robe over the body.
  const marking = HORSE_MARKINGS[(variant >> 8) & 0xff];
  if (marking) {
    out.push({
      model: null,
      texture: `assets/minecraft/textures/entity/horse/horse_markings_${marking}.png`,
      tint: null,
    });
  }
  return out;
}

/**
 * Markings, indexed by the second byte of `Variant`. Index 0 is no markings at all; the
 * four names are exactly the four `horse_markings_*.png` in the client jar.
 */
const HORSE_MARKINGS: ReadonlyArray<string | null> = [
  null, 'white', 'whitefield', 'whitedots', 'blackdots',
];

/**
 * Every texture any appearance of these types could need.
 *
 * The bake collects entity sprites from `index[type].texture`, one per type — so a layer's
 * texture is never referenced by anything and never reaches the atlas. That is the same
 * trap `destroy_stage` and the fluid sprites fell into, and the symptom is identical:
 * geometry that samples nothing and renders invisible, with no error anywhere.
 */
export function appearanceTextures(): string[] {
  const out = [SHEEP_FUR_TEXTURE];
  for (const coat of HORSE_COATS) {
    out.push(`assets/minecraft/textures/entity/horse/horse_${coat}.png`);
  }
  for (const m of HORSE_MARKINGS) {
    if (m) out.push(`assets/minecraft/textures/entity/horse/horse_markings_${m}.png`);
  }
  for (const badge of Object.values(PROFESSION_LEVELS)) {
    out.push(`assets/minecraft/textures/entity/villager/profession_level/${badge}.png`);
  }
  return out;
}

/**
 * Villager robes for the bake.
 *
 * Professions and biome types are an open registry — a mod adds its own — so these are
 * enumerated from the pack's texture files rather than listed here.
 */
export function villagerOverlayTextures(paths: Iterable<string>): string[] {
  const re = /^assets\/([^/]+)\/textures\/entity\/villager\/(type|profession)\/([^/]+)\.png$/;
  const out: string[] = [];
  for (const p of paths) if (re.test(p)) out.push(p);
  return out;
}

/**
 * Wolf coat textures, which come from the datapack and so cannot be listed statically.
 * Given a way to read `data/<ns>/wolf_variant/*.json`, returns every texture they name.
 */
export function wolfCoatTextures(
  variants: Iterable<string>,
  read: (registry: string, id: string) => Record<string, unknown> | null,
): string[] {
  const out = new Set<string>();
  for (const v of variants) {
    const entry = read('wolf_variant', v);
    if (!entry) continue;
    for (const field of ['wild_texture', 'tame_texture', 'angry_texture']) {
      const id = str(entry[field]);
      if (id) out.add(texturePathOf(id));
    }
  }
  return [...out];
}

/**
 * Adapt a pack-stack reader into the `variant` lookup `appearanceOf` wants.
 *
 * Kept here rather than in the pack layer so this module states the path shape it depends
 * on — `data/<ns>/<registry>/<name>.json` — in one place.
 */
export function variantLookup(
  readJson: (path: string) => Record<string, unknown> | undefined,
): (registry: string, id: string) => Record<string, unknown> | null {
  return (registry, id) => {
    const i = id.indexOf(':');
    const ns = i < 0 ? 'minecraft' : id.slice(0, i);
    const name = i < 0 ? id : id.slice(i + 1);
    return readJson(`data/${ns}/${registry}/${name}.json`) ?? null;
  };
}

/** `data/minecraft/wolf_variant/woods.json` -> `minecraft:woods`. */
export function variantIdsIn(registry: string, paths: Iterable<string>): string[] {
  const re = new RegExp(`^data/([^/]+)/${registry}/(.+)\\.json$`);
  const out: string[] = [];
  for (const p of paths) {
    const m = re.exec(p);
    if (m) out.push(`${m[1]}:${m[2]}`);
  }
  return out;
}
