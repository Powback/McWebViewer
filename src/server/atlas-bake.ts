/**
 * The texture atlas, built in Node.
 *
 * This mirrors `render/atlas.ts` exactly — same shelf packing, same 1px replicated edge
 * padding, same frame handling — but blits raw RGBA instead of driving a canvas, because
 * neither `createImageBitmap` nor `CanvasRenderingContext2D` exists on the server.
 *
 * Why bother: building the atlas in the browser is what forces the browser to have the
 * jars, and the jars are ~476 MB. Baking here means the client fetches one PNG of a few
 * hundred KB instead.
 *
 * The sprite rects it produces are the same shape the renderer already consumes, so the
 * mesher cannot tell a baked atlas from a browser-built one.
 */

import { texturePath, type Pack } from '../assets/pack.js';
import { decodeRgba, encodeRgba, type DecodedImage } from '../assets/png.js';
import type { SpriteRect, AnimationMeta } from '../render/atlas.js';

interface Loaded {
  id: string;
  img: DecodedImage;
  frames: number;
  frametime: number;
  frameH: number;
}

interface Placement {
  l: Loaded;
  x: number;
  y: number;
}

export interface BakedAtlas {
  width: number;
  height: number;
  png: Uint8Array;
  sprites: Record<string, SpriteRect>;
  missing: string[];
}

/** Animation metadata decides how tall one frame is; identical rules to the browser path. */
function resolveFrames(pack: Pack, id: string, img: DecodedImage) {
  const metaRaw = pack.get(texturePath(id) + '.mcmeta');
  if (metaRaw) {
    try {
      const meta = JSON.parse(new TextDecoder().decode(metaRaw)) as AnimationMeta;
      if (meta.animation) {
        const frameH = meta.animation.height ?? img.width;
        return {
          frameH,
          frames: Math.max(1, Math.round(img.height / frameH)),
          frametime: meta.animation.frametime ?? 1,
        };
      }
    } catch {
      /* a malformed mcmeta must not lose us the texture */
    }
  }
  if (img.height > img.width && img.height % img.width === 0) {
    return { frames: img.height / img.width, frametime: 1, frameH: img.width };
  }
  return { frames: 1, frametime: 1, frameH: img.height };
}

function loadSprite(pack: Pack, id: string): Loaded | null {
  const png = pack.get(texturePath(id));
  if (!png) return null;
  const img = decodeRgba(png);
  if (!img) return null;
  return { id, img, ...resolveFrames(pack, id, img) };
}

function packShelves(loaded: Loaded[], padding: number) {
  loaded.sort((a, b) => b.img.height - a.img.height || b.img.width - a.img.width);
  const totalArea = loaded.reduce(
    (s, l) => s + (l.img.width + padding * 2) * (l.img.height + padding * 2), 0,
  );
  let atlasW = 256;
  while (atlasW * atlasW < totalArea * 1.15) atlasW *= 2;

  let px = 0;
  let py = 0;
  let shelfH = 0;
  const placements: Placement[] = [];
  for (const l of loaded) {
    const w = l.img.width + padding * 2;
    const h = l.img.height + padding * 2;
    if (px + w > atlasW) {
      px = 0;
      py += shelfH;
      shelfH = 0;
    }
    placements.push({ l, x: px + padding, y: py + padding });
    px += w;
    shelfH = Math.max(shelfH, h);
  }
  return { atlasW, atlasH: nextPow2(py + shelfH), placements };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** The atlas being written into, so the per-pixel blit stays a two-argument call. */
interface Target {
  data: Uint8Array;
  width: number;
}

function blitPixel(dst: Target, dx: number, dy: number, src: DecodedImage, s: number): void {
  const di = (dy * dst.width + dx) * 4;
  dst.data[di] = src.data[s];
  dst.data[di + 1] = src.data[s + 1];
  dst.data[di + 2] = src.data[s + 2];
  dst.data[di + 3] = src.data[s + 3];
}

/**
 * Draw the sprite plus a replicated 1px border. With NEAREST filtering that border is
 * never sampled, but it makes the atlas safe against float error at grazing angles and is
 * what would make mipmaps possible later without re-packing.
 */
function drawWithPadding(dst: Target, p: Placement, padding: number): void {
  const { img } = p.l;
  for (let y = -padding; y < img.height + padding; y++) {
    for (let x = -padding; x < img.width + padding; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x));
      const sy = Math.min(img.height - 1, Math.max(0, y));
      blitPixel(dst, p.x + x, p.y + y, img, (sy * img.width + sx) * 4);
    }
  }
}

function rectFor(p: Placement, atlasW: number, atlasH: number): SpriteRect {
  const bw = p.l.img.width;
  return {
    x: p.x, y: p.y, w: bw, h: p.l.frameH,
    frames: p.l.frames, frametime: p.l.frametime,
    u0: p.x / atlasW, v0: p.y / atlasH,
    u1: (p.x + bw) / atlasW, v1: (p.y + p.l.frameH) / atlasH,
  };
}

export function bakeAtlas(
  pack: Pack,
  spriteIds: Iterable<string>,
  padding = 1,
): BakedAtlas {
  const loaded: Loaded[] = [];
  const missing: string[] = [];
  for (const id of new Set(spriteIds)) {
    const sprite = loadSprite(pack, id);
    if (sprite) loaded.push(sprite);
    else missing.push(id);
  }

  const { atlasW, atlasH, placements } = packShelves(loaded, padding);
  const target: Target = { data: new Uint8Array(atlasW * atlasH * 4), width: atlasW };
  const sprites: Record<string, SpriteRect> = {};
  for (const p of placements) {
    drawWithPadding(target, p, padding);
    sprites[p.l.id] = rectFor(p, atlasW, atlasH);
  }

  return {
    width: atlasW,
    height: atlasH,
    png: encodeRgba({ width: atlasW, height: atlasH, data: target.data }),
    sprites,
    missing,
  };
}
