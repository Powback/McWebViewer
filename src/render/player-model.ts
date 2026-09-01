/**
 * Geometry for live players.
 *
 * The extracted entity index (`public/entity-index.json`) is keyed by entity TYPE, and
 * `minecraft:player` is not in it — the harness walks the entity type registry, and the
 * player is not a registered spawnable type. The MODEL is there, though:
 * `minecraft:player#main` was extracted because several mods' renderers delegate to it
 * (Corpse's `CorpseRenderer`, for one), so nothing new has to be extracted here. All that
 * is missing is the type -> (model, texture) row.
 *
 * The texture is vanilla's default wide skin. Real skins are fetched from Mojang's
 * session servers at runtime by the game client, which this viewer deliberately does not
 * do: it would mean the page making cross-origin requests to Mojang for every player it
 * sees, on a LAN-only viewer that otherwise talks to nothing outside the house. Everyone
 * is Steve, and that is a stated limitation rather than a silent one.
 */

import { EntityModelSet, type EntityIndex, type EntityIndexEntry } from './entity-geometry.js';

export const PLAYER_TYPE = 'minecraft:player';

export const PLAYER_INDEX_ENTRY: EntityIndexEntry = {
  renderer: 'net.minecraft.client.renderer.entity.player.PlayerRenderer',
  model: 'minecraft:player#main',
  texture: 'assets/minecraft/textures/entity/player/wide/steve.png',
};

/** The index plus the player row. Non-destructive: the extracted file is not mutated. */
export function withPlayerRow(index: EntityIndex): EntityIndex {
  return index[PLAYER_TYPE] ? index : { ...index, [PLAYER_TYPE]: PLAYER_INDEX_ENTRY };
}

/**
 * The same augmentation applied to an already-loaded model set.
 *
 * A new set rather than a mutation, so the audit — which reports what the *extraction*
 * covers — keeps reading the extracted index unchanged and does not start claiming a
 * type the harness never produced.
 */
export function withPlayerModel(set: EntityModelSet): EntityModelSet {
  return new EntityModelSet(set.models, withPlayerRow(set.index));
}
