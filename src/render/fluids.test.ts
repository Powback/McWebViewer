/**
 * Fluids: the geometry the viewer had none of.
 *
 * The bug this guards against is not subtle — `registry.ts` returned `quads: []` for every
 * fluid state, so oceans, rivers and lava lakes were holes in the world. What makes it worth
 * a test rather than an eyeball is that the failure MODE is silent: a fluid has no model
 * elements by design, so nothing in the asset pipeline reports anything missing. Only
 * running the mesher over a cell that holds water and counting what comes out catches it.
 *
 * These run the real `meshSection` over a hand-built section, so they exercise the whole
 * path the viewer uses: registry -> mesher -> fluid generation -> atlas lookup -> layer.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { cornerHeights, fluidOf, fluidQuads, spritesFor } from './fluids.js';
import { meshSection, type MeshContext } from './mesher.js';
import type { RenderableState } from './registry.js';

// --------------------------------------------------------------------------------------
// Heights. Measured out of the real game (FluidState.getOwnHeight for all 9,246 states).

test('a source block stands 8 ninths tall, not a full block', () => {
  const c = fluidOf('minecraft:water', { level: '0' });
  assert.ok(c);
  assert.equal(c.kind, 'water');
  assert.ok(Math.abs(c.height - 8 / 9) < 1e-9, `height ${c.height}`);
  assert.equal(c.falling, false);
});

test('each level step removes exactly one ninth', () => {
  const h = (level: number) => fluidOf('minecraft:water', { level: String(level) })!.height;
  for (let level = 0; level <= 7; level++) {
    assert.ok(Math.abs(h(level) - (8 - level) / 9) < 1e-9, `level ${level} -> ${h(level)}`);
  }
});

// The correction the measurement forced: levels 8..15 are FALLING fluid, which stands at
// full height. Reading the property name as "lower and lower" makes every waterfall a
// sliver hanging in mid-air, which is exactly what the naive formula produces.
test('levels 8 and above are falling fluid at full height, not the thinnest fluid', () => {
  for (const level of [8, 12, 15]) {
    const c = fluidOf('minecraft:water', { level: String(level) })!;
    assert.equal(c.falling, true, `level ${level} should be falling`);
    assert.ok(c.height > fluidOf('minecraft:water', { level: '1' })!.height,
      `falling level ${level} must not be shorter than level 1`);
  }
});

test('lava is recognised as its own fluid and gets its own sprites', () => {
  assert.equal(fluidOf('minecraft:lava', { level: '0' })!.kind, 'lava');
  assert.equal(fluidOf('minecraft:flowing_lava', { level: '3' })!.kind, 'lava');
  assert.equal(spritesFor('lava').still, 'minecraft:block/lava_still');
  assert.notEqual(spritesFor('lava').still, spritesFor('water').still);
});

test('a waterlogged block carries full-height water even though it is not a fluid block', () => {
  const c = fluidOf('minecraft:oak_fence', { waterlogged: 'true' });
  assert.ok(c, 'a waterlogged fence holds water');
  assert.equal(c.kind, 'water');
  assert.ok(Math.abs(c.height - 8 / 9) < 1e-9);
  assert.equal(fluidOf('minecraft:oak_fence', { waterlogged: 'false' }), null);
});

test('an ordinary block holds nothing', () => {
  assert.equal(fluidOf('minecraft:stone', {}), null);
  assert.equal(fluidOf('create:andesite_casing', { axis: 'y' }), null);
});

// --------------------------------------------------------------------------------------
// Corners. The averaging is what makes a shoreline slope instead of terrace.

const NO_NEIGHBOURS = { above: false, around: new Array<number | null>(9).fill(null) };

test('an isolated cell is flat at its own height', () => {
  const cell = fluidOf('minecraft:water', { level: '2' })!;
  const c = cornerHeights(cell, NO_NEIGHBOURS);
  for (const h of c) assert.ok(Math.abs(h - cell.height) < 1e-9, `corner ${h}`);
});

test('a lower neighbour pulls only the corners that touch it down', () => {
  const cell = fluidOf('minecraft:water', { level: '0' })!;
  const around = new Array<number | null>(9).fill(null);
  // the cell at dx=-1, dz=0 -> index (0)*3 + 1
  around[1] = 1 / 9;
  const [nn, np, pp, pn] = cornerHeights(cell, { above: false, around });
  assert.ok(nn < cell.height, 'the -x,-z corner touches the shallow neighbour');
  assert.ok(np < cell.height, 'the -x,+z corner touches it too');
  assert.ok(Math.abs(pp - cell.height) < 1e-9, 'the far corner is untouched');
  assert.ok(Math.abs(pn - cell.height) < 1e-9, 'and so is the other far one');
});

test('fluid above makes the top flat and full, so a deep column has no dimples', () => {
  const cell = fluidOf('minecraft:water', { level: '3' })!;
  const around = new Array<number | null>(9).fill(null);
  around[1] = 1 / 9;
  const c = cornerHeights(cell, { above: true, around });
  for (const h of c) assert.equal(h, 1);
});

test('falling fluid is full height on every corner', () => {
  const c = cornerHeights(fluidOf('minecraft:water', { level: '8' })!, NO_NEIGHBOURS);
  for (const h of c) assert.equal(h, 1);
});

// --------------------------------------------------------------------------------------
// Quads.

const ALL_FACES = { up: true, down: true, north: true, south: true, east: true, west: true };

test('a full cell emits six faces and a culled one emits fewer', () => {
  const cell = fluidOf('minecraft:water', { level: '0' })!;
  const corners = cornerHeights(cell, NO_NEIGHBOURS);
  assert.equal(fluidQuads(cell, corners, ALL_FACES).length, 6);
  assert.equal(fluidQuads(cell, corners, { ...ALL_FACES, up: false, down: false }).length, 4);
  assert.equal(fluidQuads(cell, corners, { ...ALL_FACES, ...allOff() }).length, 0);
});

function allOff() {
  return { up: false, down: false, north: false, south: false, east: false, west: false };
}

test('the top face sits at the corner heights, so a sloped surface is actually sloped', () => {
  const cell = fluidOf('minecraft:water', { level: '0' })!;
  const corners: [number, number, number, number] = [0.4, 0.6, 0.8, 1.0];
  const top = fluidQuads(cell, corners, { ...allOff(), up: true })[0];
  const ys = [top.positions[1], top.positions[4], top.positions[7], top.positions[10]];
  ys.forEach((y, i) => assert.ok(Math.abs(y - corners[i]) < 1e-6,
    `top vertex ${i} at ${y}, expected ${corners[i]}`));
});

test('a side face is as tall as the corners it spans', () => {
  const cell = fluidOf('minecraft:water', { level: '0' })!;
  const corners: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];
  const west = fluidQuads(cell, corners, { ...allOff(), west: true })[0];
  const east = fluidQuads(cell, corners, { ...allOff(), east: true })[0];
  const topY = (q: typeof west) => Math.max(q.positions[1], q.positions[4], q.positions[7], q.positions[10]);
  assert.ok(Math.abs(topY(west) - 0.25) < 1e-9, `west top ${topY(west)}`);
  assert.ok(Math.abs(topY(east) - 0.75) < 1e-9, `east top ${topY(east)}`);
});

test('water is tinted by biome and lava is not, and lava is not shaded like rock', () => {
  const water = fluidQuads(fluidOf('minecraft:water', { level: '0' })!, [1, 1, 1, 1], ALL_FACES);
  const lava = fluidQuads(fluidOf('minecraft:lava', { level: '0' })!, [1, 1, 1, 1], ALL_FACES);
  assert.ok(water.every((q) => q.tintIndex === 0), 'water quads feed the biome tint');
  assert.ok(lava.every((q) => q.tintIndex < 0), 'lava is never biome tinted');
  assert.ok(lava.every((q) => q.shade === false), 'lava is its own light source');
  assert.ok(water.some((q) => q.shade === true), 'water still takes directional shade');
});

test('the sides use the flow texture and the top uses the still one', () => {
  const qs = fluidQuads(fluidOf('minecraft:water', { level: '0' })!, [1, 1, 1, 1], ALL_FACES);
  const up = qs.find((q) => q.facing === 'up')!;
  const north = qs.find((q) => q.facing === 'north')!;
  assert.equal(up.texture, 'minecraft:block/water_still');
  assert.equal(north.texture, 'minecraft:block/water_flow');
});

// --------------------------------------------------------------------------------------
// Through the real mesher. This is the test that would have failed before the fix.

const SPRITE = { u0: 0, v0: 0, u1: 1, v1: 1, frames: 1, frametime: 1 };

function stateFor(key: string): RenderableState {
  const [name, rest] = key.split('[');
  const props: Record<string, string> = {};
  if (rest) {
    for (const pair of rest.replace(']', '').split(',')) {
      const [k, v] = pair.split('=');
      props[k] = v;
    }
  }
  const fluid = name === 'minecraft:water' || name === 'minecraft:lava';
  const air = name === 'minecraft:air';
  return {
    key, name, props,
    quads: fluid || air ? [] : [cubeQuad()],
    renderType: fluid ? 'translucent' : 'solid',
    opaqueFullCube: !fluid && !air,
    ambientOcclusion: false,
    tintSource: name === 'minecraft:water' ? 2 : -1,
    provenance: fluid ? 'fluid' : air ? 'air' : 'asset',
    lightEmission: 0,
  };
}

function cubeQuad() {
  return {
    positions: new Float32Array([0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0]),
    uvs: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
    normal: [0, 1, 0] as [number, number, number],
    texture: 'minecraft:block/stone',
    facing: 'up' as const,
    cullface: 'up' as const,
    tintIndex: -1,
    shade: true,
  };
}

/**
 * A one-section world built from a callback. Structural rather than a real `World` on
 * purpose: the point is to drive `meshSection` with a known neighbourhood, not to test
 * region loading.
 */
function worldOf(at: (x: number, y: number, z: number) => string) {
  const palette: string[] = ['minecraft:air'];
  const idOf = (key: string) => {
    const i = palette.indexOf(key);
    return i >= 0 ? i : palette.push(key) - 1;
  };
  const ids = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++) {
    ids[i] = idOf(at(i & 15, i >> 8, (i >> 4) & 15));
  }
  const section = { ids, uniform: 0 };
  const world = {
    palette,
    biomePalette: ['minecraft:plains'],
    getChunk: (cx: number, cz: number) =>
      cx === 0 && cz === 0 ? { sections: new Map([[0, section]]), blockEntities: new Map() } : null,
    getState: (x: number, y: number, z: number) =>
      x < 0 || x > 15 || y < 0 || y > 15 || z < 0 || z > 15 ? 0 : ids[(y << 8) | (z << 4) | x],
    getBiome: () => 0,
    getLight: () => 0xff,
  };
  const cache = new Map<string, RenderableState>();
  const ctx = {
    world,
    registry: {
      resolve: (key: string) => {
        let s = cache.get(key);
        if (!s) cache.set(key, (s = stateFor(key)));
        return s;
      },
    },
    atlas: { get: () => SPRITE },
    biomes: { tint: () => [0.2, 0.4, 0.9] as const },
    states: [],
  } as unknown as MeshContext;
  return ctx;
}

function meshOf(ctx: MeshContext) {
  return meshSection(ctx, 0, 0, 0);
}

test('a water block produces geometry — the bug was that it produced none', () => {
  const ctx = worldOf((x, y, z) => (x === 5 && y === 5 && z === 5 ? 'minecraft:water[level=0]' : 'minecraft:air'));
  const mesh = meshOf(ctx);
  assert.ok(mesh, 'the section meshes');
  assert.ok(mesh.quadCount >= 6, `a lone water cell should emit its six faces, got ${mesh.quadCount}`);
});

test('water lands in the translucent layer, not the solid one', () => {
  const ctx = worldOf((x, y, z) => (x === 5 && y === 5 && z === 5 ? 'minecraft:water[level=0]' : 'minecraft:air'));
  const mesh = meshOf(ctx)!;
  assert.ok(mesh.layers.translucent, 'there is a translucent layer');
  assert.equal(mesh.layers.solid, undefined, 'and nothing solid, since the only block is water');
});

// The reason the corner averaging exists, stated as a count rather than a look: a pool that
// is all one level has a flat top; the same pool with a shallow edge does not.
test('an ocean does not draw internal walls between its own cells', () => {
  const pool = (x: number, y: number, z: number) =>
    y === 5 && x >= 4 && x <= 7 && z >= 4 && z <= 7 ? 'minecraft:water[level=0]' : 'minecraft:air';
  const mesh = meshOf(worldOf(pool))!;
  // 16 cells x 6 faces = 96 if nothing were shared. A 4x4 grid has 24 internal adjacencies,
  // and each hides a face on BOTH sides, so 48 faces go and 48 remain: 16 tops, 16 bottoms
  // and the 16 faces around the rim. A viewer that drew all 96 would be a lattice of walls.
  assert.equal(mesh.quadCount, 48, 'shared faces between water cells must be culled');
});

test('a deep column draws one surface, not one per layer', () => {
  const col = (x: number, y: number, z: number) =>
    x === 5 && z === 5 && y >= 2 && y <= 6 ? 'minecraft:water[level=0]' : 'minecraft:air';
  const mesh = meshOf(worldOf(col))!;
  // 5 cells: 4 sides each (20) + one top + one bottom.
  assert.equal(mesh.quadCount, 22, 'only the topmost cell gets a top face');
});

test('water against stone draws no face into the stone', () => {
  const scene = (x: number, y: number, z: number) => {
    if (x === 5 && y === 5 && z === 5) return 'minecraft:water[level=0]';
    if (x === 6 && y === 5 && z === 5) return 'minecraft:stone';
    return 'minecraft:air';
  };
  const mesh = meshOf(worldOf(scene))!;
  const solid = mesh.layers.solid;
  const water = mesh.layers.translucent;
  assert.ok(water && solid, 'both layers present');
  assert.equal(water.positions.length / 12, 5, 'the face into the stone is dropped');
});

test('a waterlogged block draws BOTH its model and the water inside it', () => {
  const dry = worldOf((x, y, z) =>
    x === 5 && y === 5 && z === 5 ? 'minecraft:oak_fence[waterlogged=false]' : 'minecraft:air');
  const wet = worldOf((x, y, z) =>
    x === 5 && y === 5 && z === 5 ? 'minecraft:oak_fence[waterlogged=true]' : 'minecraft:air');
  const a = meshOf(dry)!;
  const b = meshOf(wet)!;
  assert.ok(b.quadCount > a.quadCount, `waterlogged ${b.quadCount} should exceed dry ${a.quadCount}`);
  assert.equal(a.layers.translucent, undefined, 'a dry fence has no water');
  assert.ok(b.layers.translucent, 'a flooded one does');
  assert.ok(b.layers.solid, 'and it keeps its own model');
});

test('two adjacent waterlogged blocks share their water surface', () => {
  const one = worldOf((x, y, z) =>
    y === 5 && z === 5 && x === 5 ? 'minecraft:oak_fence[waterlogged=true]' : 'minecraft:air');
  const two = worldOf((x, y, z) =>
    y === 5 && z === 5 && (x === 5 || x === 6) ? 'minecraft:oak_fence[waterlogged=true]' : 'minecraft:air');
  const w1 = meshOf(one)!.layers.translucent!.positions.length / 12;
  const w2 = meshOf(two)!.layers.translucent!.positions.length / 12;
  assert.equal(w1, 6);
  assert.equal(w2, 10, 'the shared face between the two floods is culled, not drawn twice');
});

// Kelp is the reason `holdsFluid` is not just "is it a fluid block or waterlogged": kelp
// holds water and says so nowhere in its block state, so a kelp forest used to be a column
// of holes punched straight through the ocean.
test('kelp holds water even though its state never says so', () => {
  const ctx = worldOf((x, y, z) =>
    x === 5 && y === 5 && z === 5 ? 'minecraft:kelp_plant' : 'minecraft:air');
  const mesh = meshOf(ctx)!;
  assert.ok(mesh.layers.translucent, 'the kelp cell carries water');
  assert.equal(mesh.layers.translucent.positions.length / 12, 6);
});

test('water beside kelp draws no wall between them', () => {
  const scene = (x: number, y: number, z: number) => {
    if (y !== 5 || z !== 5) return 'minecraft:air';
    if (x === 5) return 'minecraft:water[level=0]';
    if (x === 6) return 'minecraft:kelp_plant';
    return 'minecraft:air';
  };
  const water = meshOf(worldOf(scene))!.layers.translucent!.positions.length / 12;
  assert.equal(water, 10, 'the shared face between the pond and the kelp cell is culled');
});

test('lava meshes too, and is not confused with water', () => {
  const ctx = worldOf((x, y, z) => (x === 5 && y === 5 && z === 5 ? 'minecraft:lava[level=0]' : 'minecraft:air'));
  const mesh = meshOf(ctx)!;
  assert.equal(mesh.quadCount, 6);
  const mixed = worldOf((x, y, z) => {
    if (y === 5 && z === 5 && x === 5) return 'minecraft:lava[level=0]';
    if (y === 5 && z === 5 && x === 6) return 'minecraft:water[level=0]';
    return 'minecraft:air';
  });
  // Different fluids do NOT hide each other's shared face: 6 + 6, nothing culled.
  assert.equal(meshOf(mixed)!.quadCount, 12);
});

test('a flowing edge slopes: its top vertices are not all at the same height', () => {
  const scene = (x: number, y: number, z: number) => {
    if (y !== 5 || z !== 5) return 'minecraft:air';
    if (x === 5) return 'minecraft:water[level=0]';
    if (x === 6) return 'minecraft:water[level=6]';
    return 'minecraft:air';
  };
  const mesh = meshOf(worldOf(scene))!;
  const p = mesh.layers.translucent!.positions;
  const ys = new Set<number>();
  for (let i = 1; i < p.length; i += 3) ys.add(Math.round(p[i] * 1000));
  assert.ok(ys.size > 3, `a shoreline must have varied heights, saw ${[...ys].sort((a, b) => a - b)}`);
});

// --------------------------------------------------------------------------------------
// Completeness, against the real game.
//
// `physics.json` carries `BlockState.getFluidState()` read out of the running client for
// every one of the 26,684 block states in this 130-mod pack. Every state that holds a fluid
// must be one this module recognises — otherwise that block renders as a hole in the water.
// This is the check that makes the module generic rather than a vanilla guess: install a mod
// that adds a fluid or an always-flooded block, re-extract, and this fails.

import { readFileSync, existsSync } from 'node:fs';

const PHYSICS = 'harness/out/physics.json';

test('every fluid-carrying state in the real game is recognised', { skip: !existsSync(PHYSICS) }, () => {
  const rows = JSON.parse(readFileSync(PHYSICS, 'utf8')).fluids as Array<{
    state: string; height: number; fluid: string;
  }>;
  assert.ok(rows.length > 1000, `expected the full extraction, saw ${rows.length} rows`);

  const unrecognised = new Set<string>();
  const wrongHeight: string[] = [];
  for (const row of rows) {
    const [name, rest] = row.state.split('[');
    const props: Record<string, string> = {};
    if (rest) {
      for (const pair of rest.replace(']', '').split(',')) {
        const [k, v] = pair.split('=');
        props[k] = v;
      }
    }
    const cell = fluidOf(name, props);
    if (!cell) {
      unrecognised.add(name);
      continue;
    }
    const expectedKind = row.fluid.includes('lava') ? 'lava' : 'water';
    if (cell.kind !== expectedKind) wrongHeight.push(`${row.state}: kind ${cell.kind} != ${expectedKind}`);
    // Falling fluid is the documented departure: the game reports its OWN height as the
    // level implies, but it is drawn full-height, which is what this module returns.
    if (!cell.falling && Math.abs(cell.height - row.height) > 1e-6) {
      wrongHeight.push(`${row.state}: ${cell.height} != ${row.height}`);
    }
  }
  assert.deepEqual([...unrecognised], [],
    'these blocks hold a fluid in the real game but render dry');
  assert.deepEqual(wrongHeight.slice(0, 5), [], `${wrongHeight.length} height/kind mismatches`);
});

test('the fluid sprites the module asks for are in the baked atlas', { skip: !existsSync(PHYSICS) }, async () => {
  const { FLUID_SPRITES } = await import('../tools/bake-assets.js');
  for (const kind of ['water', 'lava'] as const) {
    const s = spritesFor(kind);
    assert.ok(FLUID_SPRITES.includes(s.still), `${s.still} must be forced into the bake`);
    assert.ok(FLUID_SPRITES.includes(s.flow), `${s.flow} must be forced into the bake`);
  }
});
