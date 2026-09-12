/**
 * WHICH CELL A QUAD IS LIT BY.
 *
 * A cube's face sits exactly on the block boundary, so it is lit by the cell it faces INTO —
 * the air in front of it, not the solid it belongs to. That is right, and it is what the
 * mesher did for every quad.
 *
 * It is wrong for geometry that lives INSIDE its own block. The X of a grass cross, a torch,
 * a fence post, a flower: those quads face a cardinal direction but never touch the boundary,
 * and offsetting their light sample reads whatever is next door. Next door to a plant is very
 * often a wall, the light inside a solid block is 0, and `faceBrightness(0)` is 0.05 — so the
 * plant is drawn at five percent brightness. "transparent blocks such as grass when they are
 * next to a solid block, they become very dark" (the user, 2026-09-11).
 *
 * Vanilla makes exactly this distinction, in `ModelBlockRenderer`: quads bucketed by a
 * direction (`getQuads(state, direction, …)`, i.e. the ones with a cullface) are lit from
 * `pos.relative(direction)`, and the general bucket (`getQuads(state, null, …)`, no cullface)
 * is lit from `pos` itself. The cullface is the model saying "this face is flush with the
 * boundary", which is the same thing the mesher already uses it for when culling and when
 * deciding whether ambient occlusion applies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshSection, type MeshContext } from './mesher.js';
import type { RenderableState } from './registry.js';

const SPRITE = { u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1, vStep: 0 };

/** A unit quad facing `facing`, with or without a cullface. */
function quad(facing: 'up' | 'east', cullface: 'up' | 'east' | null) {
  return {
    facing,
    cullface,
    texture: 'x',
    tintIndex: -1,
    // `shade: false` on purpose: the per-face brightness multiplier would otherwise mask the
    // thing under test. What is measured here is the LIGHT SAMPLE, not the face shading.
    shade: false,
    normal: (facing === 'up' ? [0, 1, 0] : [1, 0, 0]) as [number, number, number],
    positions: new Float32Array([0, 0.5, 0, 0, 0.5, 1, 1, 0.5, 1, 1, 0.5, 0]),
    uvs: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
  };
}

/**
 * Two block kinds and nothing else:
 *   stone  an opaque full cube whose one quad is flush with the boundary (has a cullface)
 *   grass  a cross: one quad facing east, INSIDE its own cell, with no cullface
 */
function stateFor(key: string): RenderableState {
  const base = {
    key, name: key, props: {}, tintSource: -1, lightEmission: 0, provenance: 'baked' as const,
  };
  if (key === 'stone') {
    return {
      ...base, quads: [quad('up', 'up')], renderType: 'solid' as const,
      opaqueFullCube: true, ambientOcclusion: true,
    } as unknown as RenderableState;
  }
  return {
    ...base, quads: [quad('east', null)], renderType: 'cutout' as const,
    opaqueFullCube: false, ambientOcclusion: false,
  } as unknown as RenderableState;
}

/**
 * A one-section world with REAL per-cell light: full daylight in the open, and 0 inside any
 * solid block, which is what a light engine actually produces and what makes this bug bite.
 */
function worldOf(at: (x: number, y: number, z: number) => string) {
  const palette: string[] = ['minecraft:air'];
  const idOf = (key: string) => {
    const i = palette.indexOf(key);
    return i >= 0 ? i : palette.push(key) - 1;
  };
  const ids = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++) ids[i] = idOf(at(i & 15, i >> 8, (i >> 4) & 15));
  const getState = (x: number, y: number, z: number) =>
    x < 0 || x > 15 || y < 0 || y > 15 || z < 0 || z > 15 ? 0 : ids[(y << 8) | (z << 4) | x]!;
  const world = {
    palette,
    biomePalette: ['minecraft:plains'],
    getChunk: (cx: number, cz: number) => (cx === 0 && cz === 0
      ? { sections: new Map([[0, { ids, uniform: 0 }]]), blockEntities: new Map() }
      : null),
    getState,
    getBiome: () => 0,
    getLight: (x: number, y: number, z: number) => (palette[getState(x, y, z)] === 'stone' ? 0 : 0xff),
  };
  const cache = new Map<string, RenderableState>();
  return {
    world,
    registry: {
      resolve: (key: string) => {
        let s = cache.get(key);
        if (!s) cache.set(key, (s = stateFor(key)));
        return s;
      },
    },
    atlas: { get: () => SPRITE },
    biomes: { tint: () => [1, 1, 1] as const },
    states: [],
  } as unknown as MeshContext;
}

/**
 * The brightest RGB channel in a layer.
 *
 * RGB ONLY — every fourth float is alpha and the mesher writes 1 into it unconditionally, so
 * a max over the whole array is always exactly 1 and says nothing about brightness at all.
 */
function brightest(colors: Float32Array | Uint8Array): number {
  // Vertex colours ship as normalized uint8 now -- 4 bytes a vertex instead of 16, which is what
  // the picture actually has on an 8-bit screen. Decoded back to 0..1 so the numbers below still
  // read as brightnesses rather than as byte values.
  const scale = colors instanceof Float32Array ? 1 : 1 / 255;
  let max = 0;
  for (let i = 0; i < colors.length; i++) {
    if (i % 4 !== 3) max = Math.max(max, colors[i]! * scale);
  }
  return max;
}

/** How brightly the plant is drawn: it lands in the cutout layer. */
function plantBrightness(ctx: MeshContext): number {
  const mesh = meshSection(ctx, 0, 0, 0);
  assert.ok(mesh, 'the section meshes');
  const layer = mesh.layers.cutout;
  assert.ok(layer, 'the plant is in the cutout layer');
  return brightest(layer.colors);
}

/** Grass at (5,5,5); `wall` decides whether a stone block sits next to it, to its east. */
const scene = (wall: boolean) => worldOf((x, y, z) => {
  if (x === 5 && y === 5 && z === 5) return 'grass';
  if (wall && x === 6 && y === 5 && z === 5) return 'stone';
  return 'minecraft:air';
});

test('A PLANT NEXT TO A WALL IS AS BRIGHT AS ONE IN THE OPEN', () => {
  // The whole bug in one comparison. Both stand in full daylight; the only difference is a
  // block beside one of them, which has no business changing how lit it is.
  const open = plantBrightness(scene(false));
  const beside = plantBrightness(scene(true));
  assert.ok(open > 0.9, `a plant in daylight should be bright, got ${open}`);
  assert.ok(
    Math.abs(beside - open) < 1e-6,
    `a wall next door must not darken the plant: open ${open}, beside a wall ${beside}`,
  );
});

test('and specifically it is not crushed to the 0.05 floor', () => {
  // `faceBrightness(0)` is 0.05 + 0.95 * 0, the value a quad gets when it samples the inside
  // of a solid block. Naming the number is what makes a regression legible in the failure.
  assert.ok(plantBrightness(scene(true)) > 0.5, 'reading the wall\'s interior light gives 0.05');
});

test('a CUBE FACE is still lit by the cell it faces into, which is the rule that was right', () => {
  // The fix must not become "always use your own cell": a stone block's own light is 0, so a
  // cube lit from itself would turn the whole world black. Its top face faces open air.
  const ctx = worldOf((x, y, z) => (x === 5 && y === 5 && z === 5 ? 'stone' : 'minecraft:air'));
  const mesh = meshSection(ctx, 0, 0, 0)!;
  const solid = mesh.layers.solid;
  assert.ok(solid, 'the cube is in the solid layer');
  assert.ok(brightest(solid.colors) > 0.9, 'its top face reads the daylight above it, not its own 0');
});

