/**
 * Textures the renderer needs that no jar ships.
 *
 * A few surfaces in the game are painted by Java at render time rather than read from a
 * PNG — a block entity renderer filling a see-through face of its block (a monitor's
 * screen). Reproducing that needs a sprite that exists nowhere in the assets, so this pack
 * synthesises it. It sits at the BOTTOM of every
 * `PackStack`, under its own `mcwv:` namespace, so no mod or resource pack is shadowed
 * and any of them could override it by shipping `assets/mcwv/...`.
 *
 * Everything here is generated in memory with `encodeRgba`; nothing is read from disk.
 */

import type { Pack } from './pack.js';
import { encodeRgba } from './png.js';

/** One synthesised 16x16 sprite: a single opaque colour. */
interface SolidSprite {
  /** sprite id, e.g. `mcwv:block/terminal_blank` */
  id: string;
  rgb: readonly [number, number, number];
}

/**
 * The "unlit interior" behind a surface a renderer paints (see render/ber-overlays.ts):
 * near-black, not black — 0x111111 is what a blank ComputerCraft terminal shows and reads
 * as "switched on, nothing drawn" for a spawner cage or any other painted hole as well.
 */
export const INTERIOR_DARK_SPRITE = 'mcwv:block/interior_dark';

const SOLID_SPRITES: readonly SolidSprite[] = [
  { id: INTERIOR_DARK_SPRITE, rgb: [0x11, 0x11, 0x11] },
];

function solidPng(rgb: readonly [number, number, number], size = 16): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return encodeRgba({ width: size, height: size, data });
}

function spriteFile(id: string): string {
  const colon = id.indexOf(':');
  return `assets/${id.slice(0, colon)}/textures/${id.slice(colon + 1)}.png`;
}

/** An in-memory pack holding the synthesised sprites. */
export class BuiltinPack implements Pack {
  readonly name = 'builtin';
  private files = new Map<string, Uint8Array>();

  constructor() {
    for (const s of SOLID_SPRITES) this.files.set(spriteFile(s.id), solidPng(s.rgb));
  }

  has(path: string): boolean {
    return this.files.has(path);
  }
  get(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }
  list(prefix: string): string[] {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
}
