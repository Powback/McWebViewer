/**
 * Blocks whose textures come from their block entity, not from their model.
 *
 * Domum Ornamentum is the pattern: one block — `domum_ornamentum:plain` — stands in for
 * every wood, stone and brick in the game, and which one it actually IS lives in the block
 * entity as `textureData`, a map of "the texture my model names" -> "the block whose
 * texture to use instead". The model is a template; the block entity is the material.
 *
 * MEASURED on the live world before this was built: 28 placed blocks, every one of them
 * carrying `{minecraft:block/oak_planks -> minecraft:birch_planks, minecraft:block/
 * dark_oak_planks -> minecraft:birch_planks}`, and every one drawing in oak. Each block is
 * 126 quads — 120 oak and 6 dark oak — so 3,528 quads in the world were the wrong wood.
 *
 * WHY THIS IS NOT A DOMUM FEATURE. Nothing below names Domum. The rule is "a block entity
 * carrying a texture map retextures the block it sits in", which is the shape MineColonies'
 * and Domum's whole family of blocks use, and any other mod that stores its material the
 * same way gets it for free. The `id` of the block entity is never consulted.
 *
 * THE VALUE IS A BLOCK, NOT A TEXTURE. `minecraft:birch_planks` is a block id; its texture
 * is whatever that block's own model resolves to. Going through the registry rather than
 * guessing `block/<name>` is what makes a modded material work — a mod's plank block may
 * name a texture with a different path entirely.
 */

import type { BakedQuad } from '../assets/model.js';

/** `block/oak_planks` and `minecraft:block/oak_planks` are the same sprite. */
export function normaliseTexId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}

/**
 * The texture map a block entity carries, normalised, or null.
 *
 * Keys are normalised so a model naming `block/oak_planks` matches an NBT key written
 * `minecraft:block/oak_planks` — the two spellings are the same sprite and the mod uses
 * whichever it likes.
 */
export function textureMapOf(be: Record<string, unknown>): Map<string, string> | null {
  const raw = be.textureData;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = new Map<string, string>();
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof to !== 'string' || !to) continue;
    out.set(normaliseTexId(from), to);
  }
  return out.size ? out : null;
}

/**
 * Stable identity for a texture map, so two blocks of the same material share one mesh.
 *
 * Sorted, because NBT key order is not guaranteed and an unstable key would mesh the same
 * material once per block.
 */
export function retextureKey(map: ReadonlyMap<string, string>): string {
  return [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => `${e[0]}=${e[1]}`).join(';');
}

/**
 * Rewrite a model's quads onto the materials the block entity names.
 *
 * `materialTexture` turns a block id into the sprite its own model uses; a material that
 * resolves to nothing leaves that quad alone, which draws the template's texture — visibly
 * the wrong wood, but a texture, rather than whatever sits at atlas (0,0).
 *
 * Returns the ORIGINAL array when nothing matched, so the common case allocates nothing.
 */
export function retextureQuads(
  quads: readonly BakedQuad[],
  map: ReadonlyMap<string, string>,
  materialTexture: (blockId: string) => string | null,
): readonly BakedQuad[] {
  let changed = false;
  const out = quads.map((q) => {
    const want = map.get(normaliseTexId(q.texture));
    if (!want) return q;
    const tex = materialTexture(want);
    if (!tex || tex === q.texture) return q;
    changed = true;
    return { ...q, texture: tex };
  });
  return changed ? out : quads;
}

/**
 * Every block id any of these block entities names as a material.
 *
 * The bake needs this: a material's texture is referenced by no block state in the world —
 * the world holds `domum_ornamentum:plain`, not birch planks — so the atlas collection
 * never finds it. Same trap as `destroy_stage`, the fluid sprites and the entity layers,
 * and the same symptom: geometry sampling a sprite that is not there.
 */
export function materialsIn(blockEntities: Iterable<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const be of blockEntities) {
    const map = textureMapOf(be);
    if (!map) continue;
    for (const to of map.values()) out.add(to);
  }
  return out;
}
