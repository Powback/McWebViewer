/**
 * Texture atlas.
 *
 * Sprites are packed at their native resolution with a shelf packer rather than being
 * normalised to 16x16, because modded packs mix resolutions freely (Create ships 16x,
 * 32x and tall animated strips in the same namespace) and downsampling them would not
 * be "1:1 faithful".
 *
 * Padding: each sprite gets a 1px border replicated from its edge pixels. With NEAREST
 * filtering and no mipmaps that border is never sampled, but it keeps us safe against
 * float error at grazing angles, and it is what makes adding mipmaps later possible
 * without re-packing.
 *
 * Animated textures (.png.mcmeta with an `animation` block) are vertical frame strips.
 * We upload every frame and expose the frame table so the renderer can scroll UVs on
 * the GPU; the mesher only ever sees frame 0's rect.
 */

import { texturePath, type Pack } from '../assets/pack.js';

export interface SpriteRect {
  /** pixel coords in the atlas */
  x: number;
  y: number;
  w: number;
  /** height of ONE frame (not the whole strip) */
  h: number;
  /** number of animation frames stacked vertically */
  frames: number;
  frametime: number;
  /** normalised uv of frame 0 */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface Loaded {
  id: string;
  bitmap: ImageBitmap;
  frames: number;
  frametime: number;
  frameH: number;
}

export interface AnimationMeta {
  animation?: {
    frametime?: number;
    interpolate?: boolean;
    width?: number;
    height?: number;
    frames?: Array<number | { index: number; time?: number }>;
  };
}

export class TextureAtlas {
  readonly sprites = new Map<string, SpriteRect>();
  canvas!: OffscreenCanvas | HTMLCanvasElement;
  width = 0;
  height = 0;
  /** sprite ids we were asked for but could not find */
  readonly missing = new Set<string>();

  /**
   * Build an atlas containing exactly the sprites listed. Restricting to the sprites a
   * world actually uses keeps the atlas small: the reference world touches a few
   * hundred sprites out of the ~9k available across 128 jars.
   */
  static async build(pack: Pack, spriteIds: Iterable<string>, opts: { padding?: number } = {}) {
    const atlas = new TextureAtlas();
    const padding = opts.padding ?? 1;
    const loaded: Loaded[] = [];

    for (const id of new Set(spriteIds)) {
      const sprite = await loadSprite(pack, id);
      if (!sprite) {
        atlas.missing.add(id);
        continue;
      }
      loaded.push(sprite);
    }

    const { atlasW, atlasH, placements } = packShelves(loaded, padding);

    const canvas = makeCanvas(atlasW, atlasH);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    for (const p of placements) {
      drawWithPadding(ctx, p.l.bitmap, p.x, p.y, padding);
      atlas.sprites.set(p.l.id, spriteRectFor(p, atlasW, atlasH));
      p.l.bitmap.close();
    }

    atlas.canvas = canvas;
    atlas.width = atlasW;
    atlas.height = atlasH;
    return atlas;
  }

  get(id: string): SpriteRect | undefined {
    return this.sprites.get(id);
  }
}

/** where one sprite ended up in the atlas, before padding is drawn */
interface Placement {
  l: Loaded;
  x: number;
  y: number;
}

/** how a sprite's pixels split into animation frames */
interface FrameInfo {
  frames: number;
  frametime: number;
  frameH: number;
}

/** Decode one sprite's PNG and resolve its animation layout; null if unusable. */
async function loadSprite(pack: Pack, id: string): Promise<Loaded | null> {
  const png = pack.get(texturePath(id));
  if (!png) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
  } catch {
    return null;
  }
  const { frames, frametime, frameH } = resolveFrames(pack, id, bitmap);
  return { id, bitmap, frames, frametime, frameH };
}

/** Animation metadata decides how tall one frame is. */
function resolveFrames(pack: Pack, id: string, bitmap: ImageBitmap): FrameInfo {
  const metaRaw = pack.get(texturePath(id) + '.mcmeta');
  if (metaRaw) return readAnimationMeta(metaRaw, bitmap);
  return inferStripFrames(bitmap);
}

function readAnimationMeta(metaRaw: Uint8Array, bitmap: ImageBitmap): FrameInfo {
  try {
    const meta = JSON.parse(new TextDecoder().decode(metaRaw)) as AnimationMeta;
    if (meta.animation) {
      const frameH = meta.animation.height ?? bitmap.width;
      return {
        frameH,
        frames: Math.max(1, Math.round(bitmap.height / frameH)),
        frametime: meta.animation.frametime ?? 1,
      };
    }
  } catch {
    /* a malformed mcmeta should not lose us the texture */
  }
  return { frames: 1, frametime: 1, frameH: bitmap.height };
}

function inferStripFrames(bitmap: ImageBitmap): FrameInfo {
  if (bitmap.height > bitmap.width && bitmap.height % bitmap.width === 0) {
    // Some mods ship strips without mcmeta; treating them as one tall sprite would
    // squash the texture, so infer frames from the aspect ratio.
    return { frames: bitmap.height / bitmap.width, frametime: 1, frameH: bitmap.width };
  }
  return { frames: 1, frametime: 1, frameH: bitmap.height };
}

/** Shelf-pack, tallest first, into a power-of-two-width atlas. */
function packShelves(
  loaded: Loaded[],
  padding: number,
): { atlasW: number; atlasH: number; placements: Placement[] } {
  loaded.sort((a, b) => b.bitmap.height - a.bitmap.height || b.bitmap.width - a.bitmap.width);
  const totalArea = loaded.reduce(
    (s, l) => s + (l.bitmap.width + padding * 2) * (l.bitmap.height + padding * 2),
    0,
  );
  let atlasW = 256;
  while (atlasW * atlasW < totalArea * 1.15) atlasW *= 2;

  let px = 0;
  let py = 0;
  let shelfH = 0;
  const placements: Placement[] = [];
  for (const l of loaded) {
    const w = l.bitmap.width + padding * 2;
    const h = l.bitmap.height + padding * 2;
    if (px + w > atlasW) {
      px = 0;
      py += shelfH;
      shelfH = 0;
    }
    placements.push({ l, x: px + padding, y: py + padding });
    px += w;
    shelfH = Math.max(shelfH, h);
  }
  const atlasH = nextPow2(py + shelfH);
  return { atlasW, atlasH, placements };
}

function drawWithPadding(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  x: number,
  y: number,
  padding: number,
): void {
  const bw = bitmap.width;
  const bh = bitmap.height;
  ctx.drawImage(bitmap, x, y);
  if (padding > 0) {
    // Replicate edges into the padding ring.
    ctx.drawImage(bitmap, 0, 0, bw, 1, x, y - padding, bw, padding);
    ctx.drawImage(bitmap, 0, bh - 1, bw, 1, x, y + bh, bw, padding);
    ctx.drawImage(bitmap, 0, 0, 1, bh, x - padding, y, padding, bh);
    ctx.drawImage(bitmap, bw - 1, 0, 1, bh, x + bw, y, padding, bh);
  }
}

function spriteRectFor(p: Placement, atlasW: number, atlasH: number): SpriteRect {
  const { l, x, y } = p;
  const bw = l.bitmap.width;
  return {
    x,
    y,
    w: bw,
    h: l.frameH,
    frames: l.frames,
    frametime: l.frametime,
    u0: x / atlasW,
    v0: y / atlasH,
    u1: (x + bw) / atlasW,
    v1: (y + l.frameH) / atlasH,
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
