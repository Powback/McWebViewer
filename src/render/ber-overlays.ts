/**
 * Surfaces a BlockEntityRenderer paints ONTO an otherwise complete block model.
 *
 * ber-models.ts covers blocks whose whole shape lives in Java (chests, signs, beds): their
 * model JSON has no elements. This is the other half: blocks whose model JSON is complete
 * and bakes fine, but leaves a see-through area for the renderer to fill every frame — a
 * ComputerCraft monitor's screen, a spawner's cage interior. Baked as-is, a wall of
 * monitors is a hollow frame you look straight through.
 *
 * THE RULE IS STRUCTURAL, NOT A BLOCK LIST. A block gets a backdrop when three things the
 * data already says are all true:
 *   1. the WORLD has a block entity at blocks of this name (the region files say so — a
 *      renderer only exists for blocks that have one);
 *   2. the model is a full cube (the block's occlusion shape is the whole block, so what
 *      shows through is the renderer's, not a neighbour's);
 *   3. a face's texture has fully transparent texels (binary alpha) — the hole the
 *      renderer fills. Translucent (partial-alpha) faces are glass-like and left alone.
 * Every such face gets one quad 1/16 behind it in a dark "unlit interior" colour, and
 * counts as opaque for occlusion, since the surface now IS opaque. No mod is named here;
 * what the renderer would have drawn (terminal text, a spinning mob) is out of reach of a
 * static bake and is layered on live where a feed exists (monitor-screens.ts).
 *
 * The quad is authored on the UNROTATED model face, so the blockstate's `x`/`y` rotation
 * carries it to the block's actual side exactly as it does the face itself.
 */

import type { Direction, RawModel } from '../assets/model.js';
import { INTERIOR_DARK_SPRITE } from '../assets/builtin-pack.js';

/** How far behind the face the backdrop sits, in model units (1/16 block). */
const BACKDROP_INSET = 1;

/**
 * The backdrop for one face as a parent-less RawModel in the block's own (unrotated)
 * model space, for `bakeModel` to rotate with the same Variant as the block's real model.
 */
export function backdropModel(face: Direction): RawModel {
  return {
    textures: { interior: INTERIOR_DARK_SPRITE },
    elements: [
      {
        // A zero-thickness plane is a legal element (rails and item frames use them); this
        // one is the full face slid `inset` model units into the block.
        ...planeAt(face, BACKDROP_INSET),
        // No cullface: this looks OUT of the block, and a neighbour there never hides a
        // painted surface — the renderer draws over everything.
        faces: { [face]: { uv: [0, 0, 16, 16], texture: '#interior' } },
      },
    ],
  };
}

/** `from`/`to` of a 16x16 plane lying `inset` units inside the given face. */
function planeAt(face: Direction, inset: number): { from: [number, number, number]; to: [number, number, number] } {
  switch (face) {
    case 'north': return { from: [0, 0, inset], to: [16, 16, inset] };
    case 'south': return { from: [0, 0, 16 - inset], to: [16, 16, 16 - inset] };
    case 'west': return { from: [inset, 0, 0], to: [inset, 16, 16] };
    case 'east': return { from: [16 - inset, 0, 0], to: [16 - inset, 16, 16] };
    case 'down': return { from: [0, inset, 0], to: [16, inset, 16] };
    case 'up': return { from: [0, 16 - inset, 0], to: [16, 16 - inset, 16] };
  }
}
