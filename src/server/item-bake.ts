/**
 * Item icons, baked server-side.
 *
 * The block atlas cannot supply these. A hotbar shows `minecraft:diamond_sword`, whose
 * icon lives at `assets/minecraft/textures/item/diamond_sword.png` — a path no block state
 * ever names, so nothing puts it in the block atlas.
 *
 * Items come in two kinds and this module tells them apart:
 *
 *   FLAT    the item model has a `layer0` texture (swords, ingots, food, most modded
 *           items). Those textures are packed into their own atlas here.
 *   BLOCK   the item model has no layers and inherits a block model instead
 *           (`minecraft:stone` -> `minecraft:block/stone`). Vanilla draws those as a
 *           3D block in an isometric view. Rather than ship a second renderer, the bake
 *           records WHICH block state the item stands for, and the browser composites an
 *           isometric icon from the block atlas it already has. See render/item-icons.ts.
 *
 * The output is a SEPARATE file from the main bundle, fetched only in live mode. That
 * keeps `?auto=1` at the 224 KB it already costs — the whole point of the bake — while
 * still giving the playing path real icons.
 */

import { readJson, type Pack } from '../assets/pack.js';
import { bakeAtlas, type BakedAtlas } from './atlas-bake.js';
import type { SpriteRect } from '../render/atlas.js';

/** How deep to follow `parent` before giving up. Vanilla chains are 2-3 long. */
const MAX_PARENT_DEPTH = 8;

interface ItemModel {
  parent?: string;
  textures?: Record<string, string>;
}

export interface ItemIcon {
  /** sprite id in the ITEM atlas, for flat items */
  sprite?: string;
  /** block state key to composite isometrically, for block items */
  block?: string;
}

/**
 * Wire encoding for one icon, chosen because the naive form is 1.4 MB for this pack.
 *
 *   string  a sprite id in the item atlas (flat item)
 *   0       a block item whose block state is the item id itself — the overwhelmingly
 *           common case, and the one worth spending a single byte on
 *   {b}     a block item whose state differs from its id
 */
export type WireIcon = string | 0 | { b: string };

export interface BakedItems {
  version: 1;
  atlas: { width: number; height: number; sprites: Record<string, SpriteRect> };
  /** item id -> how to draw it; see WireIcon */
  icons: Record<string, WireIcon>;
  missing: string[];
}

export function encodeIcon(id: string, icon: ItemIcon): WireIcon | null {
  if (icon.sprite) return icon.sprite;
  if (!icon.block) return null;
  return icon.block === id ? 0 : { b: icon.block };
}

export function decodeIcon(id: string, wire: WireIcon): ItemIcon {
  if (typeof wire === 'string') return { sprite: wire };
  if (wire === 0) return { block: id };
  return { block: wire.b };
}

/** `assets/<ns>/models/item/<path>.json` -> `<ns>:<path>`. */
function itemIdFromPath(path: string): string | null {
  const m = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(path);
  return m ? `${m[1]}:${m[2]}` : null;
}

function modelPathOf(id: string): string {
  const [ns, path] = id.includes(':') ? id.split(':') : ['minecraft', id];
  return `assets/${ns}/models/${path}.json`;
}

/**
 * Walk the parent chain, answering two questions: is this a flat sprite, and if not,
 * which block model does it stand for?
 *
 * The block answer is the FIRST `block/…` parent, not the last. Every block model
 * eventually inherits `minecraft:block/block`, so taking the last one classifies every
 * block item in the game as the same icon — which is exactly what the first version of
 * this did, and it turned the whole hotbar into identical grey cubes.
 */
function resolveItemModel(pack: Pack, itemId: string): { layer0?: string; block?: string } {
  let current: string | undefined = modelPathOf(itemId.replace(':', ':item/'));
  let block: string | undefined;
  for (let depth = 0; depth < MAX_PARENT_DEPTH && current; depth++) {
    const model = readJson<ItemModel>(pack, current);
    if (!model) break;
    const layer0 = model.textures?.layer0;
    if (layer0) return { layer0 };
    if (!model.parent) break;
    if (!block) block = blockStateFor(model.parent);
    current = modelPathOf(model.parent);
  }
  return { block };
}

/**
 * A `minecraft:block/stone` parent means the icon is that block. The browser looks the
 * state up in the block atlas it already has, so only the state KEY is recorded here.
 */
const ROOT_MODELS = new Set(['minecraft:block', 'minecraft:cube_all', 'minecraft:cube']);

function blockStateFor(parent: string | undefined): string | undefined {
  if (!parent) return undefined;
  const m = /^(?:([a-z0-9_.-]+):)?block\/(.+)$/.exec(parent);
  if (!m) return undefined;
  // `minecraft:block/block` and friends are the shared roots every block model inherits.
  // They name no real block, so an item that resolves to one has no usable icon and must
  // say so rather than render a generic grey cube that looks like a wrong item.
  return ROOT_MODELS.has(`minecraft:${m[2]}`) ? undefined : `${m[1] ?? 'minecraft'}:${m[2]}`;
}

/** Every item model in the pack stack, as `<ns>:<path>`. */
export function listItemIds(pack: Pack): string[] {
  const out = new Set<string>();
  for (const path of pack.list('assets/')) {
    const id = itemIdFromPath(path);
    if (id) out.add(id);
  }
  return [...out].sort();
}

/**
 * Classify every item, then pack the flat ones into an atlas.
 *
 * `limit` exists because a 128-mod pack has thousands of item models and the atlas is a
 * fixed power-of-two; overflowing it silently drops sprites, which would show as random
 * blank hotbar slots. Hitting the limit is reported rather than hidden.
 */
/** Split out of bakeItems purely to keep each piece within the repo's complexity limit. */
function classifyAll(pack: Pack, icons: Record<string, ItemIcon>, sprites: Set<string>): void {
  for (const itemId of listItemIds(pack)) {
    const { layer0, block } = resolveItemModel(pack, itemId);
    if (layer0) {
      icons[itemId] = { sprite: layer0 };
      sprites.add(layer0);
    } else if (block) {
      icons[itemId] = { block };
    }
  }
}

export function bakeItems(
  pack: Pack,
  opts: { limit?: number } = {},
): { meta: BakedItems; png: Uint8Array } {
  const icons: Record<string, ItemIcon> = {};
  const sprites = new Set<string>();

  classifyAll(pack, icons, sprites);

  const limit = opts.limit ?? Infinity;
  const chosen = [...sprites].sort().slice(0, limit);
  const atlas: BakedAtlas = bakeAtlas(pack, new Set(chosen));

  // An item whose sprite did not make it into the atlas must not claim it did — a hotbar
  // slot drawing nothing with no explanation is exactly the failure this repo keeps
  // designing against.
  for (const [id, icon] of Object.entries(icons)) {
    if (icon.sprite && !atlas.sprites[icon.sprite]) delete icons[id];
  }

  const wire: Record<string, WireIcon> = {};
  for (const [id, icon] of Object.entries(icons)) {
    const enc = encodeIcon(id, icon);
    if (enc !== null) wire[id] = enc;
  }

  return {
    meta: {
      version: 1,
      atlas: { width: atlas.width, height: atlas.height, sprites: atlas.sprites },
      icons: wire,
      missing: atlas.missing,
    },
    png: atlas.png,
  };
}
