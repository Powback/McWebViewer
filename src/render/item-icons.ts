/**
 * Drawing item icons.
 *
 * Two kinds, decided by the bake (see server/item-bake.ts):
 *
 *   FLAT   the item has a `layer0` texture — swords, ingots, food, most modded items.
 *          Blitted straight from the item atlas.
 *   BLOCK  the item is a block. Vanilla renders those as a 3D cube in an isometric view,
 *          and rather than stand up a second renderer for a 32px icon, this composites
 *          the cube in 2D from the three faces the block atlas already has: a top rhombus
 *          and two parallelogram sides, with vanilla's own directional shading.
 *
 * Icons are cached per item id. A hotbar redraws every time the inventory poll lands, and
 * re-compositing a cube per slot per poll is pure waste.
 */

import type { TextureAtlas } from './atlas.js';
import type { StateSource } from './mesher.js';
import type { BakedItems, HeldContext, ItemIcon, ItemTransform, WireIcon } from '../server/item-bake.js';
import { decodeIcon } from '../server/item-bake.js';

/** Rendered size of one icon, in CSS pixels before any hotbar scaling. */
export const ICON_SIZE = 32;

/** Vanilla's directional shading, so a cube icon reads the same way the world does. */
const SHADE_TOP = 1.0;
const SHADE_LEFT = 0.8;
const SHADE_RIGHT = 0.6;

type Canvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function ctx2d(c: Canvas): CanvasRenderingContext2D {
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.imageSmoothingEnabled = false;
  return g;
}

export interface ItemIconsDeps {
  /** the item atlas image and its sprite rects */
  itemAtlas: Canvas;
  meta: BakedItems;
  /** the BLOCK atlas, for cube icons */
  blockAtlas: TextureAtlas;
  /** resolves a block state key to its baked quads, for picking cube face textures */
  states: StateSource;
}

export class ItemIcons {
  private cache = new Map<string, Canvas | null>();

  constructor(private deps: ItemIconsDeps) {}

  /** How many item ids the bake knows about — reported so a stale bake is visible. */
  get size(): number {
    return Object.keys(this.deps.meta.icons).length;
  }

  has(itemId: string): boolean {
    return this.deps.meta.icons[itemId] !== undefined;
  }

  /**
   * How this item is held in a given context, from its model's `display` block.
   *
   * Null when the bake carried no transforms, or the item has no `display` anywhere in its
   * parent chain — the caller then draws it untransformed, which is what it did before these
   * were extracted.
   */
  transformFor(itemId: string, context: HeldContext): ItemTransform | null {
    const meta = this.deps.meta;
    const i = meta.itemTransforms?.[itemId];
    if (i === undefined) return null;
    return meta.transforms?.[i]?.[context] ?? null;
  }

  /**
   * A canvas for this item, or null when the bake has no icon for it.
   *
   * Null rather than a placeholder on purpose: the caller draws the item's name instead,
   * which is far more useful than a uniform grey square that could be anything.
   */
  get(itemId: string): Canvas | null {
    const hit = this.cache.get(itemId);
    if (hit !== undefined) return hit;
    const wire: WireIcon | undefined = this.deps.meta.icons[itemId];
    const icon: ItemIcon | null = wire === undefined ? null : decodeIcon(itemId, wire);
    const drawn = icon ? this.render(icon) : null;
    this.cache.set(itemId, drawn);
    return drawn;
  }

  private render(icon: ItemIcon): Canvas | null {
    if (icon.sprite) return this.renderFlat(icon.sprite);
    if (icon.block) return this.renderCube(icon.block);
    return null;
  }

  private renderFlat(spriteId: string): Canvas | null {
    const rect = this.deps.meta.atlas.sprites[spriteId];
    if (!rect) return null;
    const { width, height } = this.deps.meta.atlas;
    const canvas = makeCanvas(ICON_SIZE, ICON_SIZE);
    const g = ctx2d(canvas);
    // Sprite rects are normalised UVs; the atlas image is the pixel source.
    const sx = rect.u0 * width;
    const sy = rect.v0 * height;
    const sw = (rect.u1 - rect.u0) * width;
    const sh = (rect.v1 - rect.v0) * height;
    g.drawImage(this.deps.itemAtlas as CanvasImageSource, sx, sy, sw, sh, 0, 0, ICON_SIZE, ICON_SIZE);
    return canvas;
  }

  /**
   * Face textures for a block state, from the geometry the renderer already baked.
   *
   * Returns null when the state is not in the block atlas — which happens for blocks that
   * do not occur in the loaded region, since the bake is scoped to the world.
   */
  private faces(blockKey: string): { up: string; left: string; right: string } | null {
    const state = this.deps.states.resolve(blockKey);
    if (!state?.quads?.length) return null;
    const byFacing = new Map<string, string>();
    for (const q of state.quads) if (!byFacing.has(q.facing)) byFacing.set(q.facing, q.texture);
    // Most blocks are one texture on every face; when a face is missing, any resolved one
    // reads far better than a hole. Nulls only when the state had no textured quad at all.
    const any = byFacing.values().next().value;
    if (!any) return null;
    const pick = (...names: string[]) => names.map((n) => byFacing.get(n)).find(Boolean) ?? any;
    return {
      up: pick('up'),
      left: pick('north', 'west'),
      right: pick('south', 'east'),
    };
  }

  /**
   * Composite an isometric cube.
   *
   * Each face is rendered into its own scratch canvas — sprite, then shading — and only
   * then transformed into place. Shading a face after it has been composited would darken
   * the faces already drawn underneath it, and `source-atop` on a scratch canvas is what
   * keeps the shade inside the sprite's alpha instead of squaring off its corners.
   *
   * The three transforms map the unit square onto the cube's visible faces:
   *   top    a rhombus,     u=(1,0) -> upper corner, u=(0,1) -> lower corner
   *   left   a parallelogram sheared down-right
   *   right  a parallelogram sheared down-left
   */
  private renderCube(blockKey: string): Canvas | null {
    const faces = this.faces(blockKey);
    if (!faces) return null;
    const canvas = makeCanvas(ICON_SIZE, ICON_SIZE);
    const g = ctx2d(canvas);
    const S = ICON_SIZE;
    const w = S * 0.45;   // half-width of the cube
    const h = S * 0.22;   // half-height of the top rhombus
    const side = S * 0.42; // height of the vertical faces
    const cx = S / 2;
    const top = S * 0.06;

    this.drawFace(g, faces.up, SHADE_TOP, [w / S, -h / S, w / S, h / S, cx - w, top + h]);
    this.drawFace(g, faces.left, SHADE_LEFT, [w / S, h / S, 0, side / S, cx - w, top + h]);
    this.drawFace(g, faces.right, SHADE_RIGHT, [w / S, -h / S, 0, side / S, cx, top + 2 * h]);
    return canvas;
  }

  /** One atlas sprite, shaded, then placed under an affine transform. */
  private drawFace(
    g: CanvasRenderingContext2D,
    textureId: string,
    shade: number,
    t: [number, number, number, number, number, number],
  ): void {
    const face = this.spriteCanvas(this.deps.blockAtlas, textureId, shade);
    if (!face) return;
    g.save();
    g.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    g.drawImage(face as CanvasImageSource, 0, 0, ICON_SIZE, ICON_SIZE);
    g.restore();
  }

  /** A square canvas holding one sprite, optionally darkened within its own alpha. */
  private spriteCanvas(atlas: TextureAtlas, textureId: string, shade: number): Canvas | null {
    const sprite = atlas.get(textureId);
    if (!sprite) return null;
    const c = makeCanvas(ICON_SIZE, ICON_SIZE);
    const g = ctx2d(c);
    const aw = atlas.width;
    const ah = atlas.height;
    g.drawImage(
      atlas.canvas as unknown as CanvasImageSource,
      sprite.u0 * aw, sprite.v0 * ah,
      (sprite.u1 - sprite.u0) * aw, (sprite.v1 - sprite.v0) * ah,
      0, 0, ICON_SIZE, ICON_SIZE,
    );
    if (shade < 1) {
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = `rgba(0,0,0,${(1 - shade).toFixed(3)})`;
      g.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
    }
    return c;
  }
}

/**
 * Fetch the item bake. Returns null when it is not served, so live mode degrades to
 * name-only slots rather than failing to start.
 */
export async function loadItemIcons(
  base: string,
  blockAtlas: TextureAtlas,
  states: StateSource,
): Promise<ItemIcons | null> {
  const metaRes = await fetch(`${base}/items.json`).catch(() => null);
  if (!metaRes?.ok) return null;
  const meta = (await metaRes.json()) as BakedItems;
  const imgRes = await fetch(`${base}/items.png`).catch(() => null);
  if (!imgRes?.ok) return null;
  const bitmap = await createImageBitmap(await imgRes.blob());
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  return new ItemIcons({ itemAtlas: canvas, meta, blockAtlas, states });
}
