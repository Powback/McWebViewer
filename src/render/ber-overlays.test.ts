/**
 * A block the world has a block entity for, whose full-cube model has a see-through face,
 * bakes with a dark backdrop behind that face — the structural "painted surface" rule.
 *
 * The worked example is a ComputerCraft monitor: a plain cube whose front texture is
 * transparent where the screen is, painted by the renderer in game. Nothing in the rule
 * names it: the in-memory pack is monitor-shaped, and the registry is told (as the bake's
 * scan tells it) that the world has block entities at `computercraft:monitor_advanced`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PackStack, type Pack } from '../assets/pack.js';
import { encodeRgba } from '../assets/png.js';
import { INTERIOR_DARK_SPRITE } from '../assets/builtin-pack.js';
import { BlockRegistry } from './registry.js';

/** In-memory pack: the CC:T monitor files, cut down to what the registry reads. */
class MemPack implements Pack {
  readonly name = 'mem';
  private files = new Map<string, Uint8Array>();
  json(path: string, v: unknown) { this.files.set(path, new TextEncoder().encode(JSON.stringify(v))); return this; }
  png(path: string, alpha: number) {
    const data = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i++) { data[i * 4] = 200; data[i * 4 + 1] = 180; data[i * 4 + 2] = 90; data[i * 4 + 3] = alpha; }
    this.files.set(path, encodeRgba({ width: 16, height: 16, data }));
    return this;
  }
  has(p: string) { return this.files.has(p); }
  get(p: string) { return this.files.get(p); }
  list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}

function monitorPack(): Pack {
  const mem = new MemPack()
    .json('assets/minecraft/models/block/cube.json', {
      parent: 'block/block',
      elements: [{
        from: [0, 0, 0], to: [16, 16, 16],
        faces: {
          down: { texture: '#down', cullface: 'down' }, up: { texture: '#up', cullface: 'up' },
          north: { texture: '#north', cullface: 'north' }, south: { texture: '#south', cullface: 'south' },
          west: { texture: '#west', cullface: 'west' }, east: { texture: '#east', cullface: 'east' },
        },
      }],
    })
    .json('assets/minecraft/models/block/block.json', {})
    .json('assets/computercraft/models/block/monitor_base.json', {
      parent: 'block/cube', render_type: 'cutout',
      textures: { particle: '#front', down: '#top', up: '#top', north: '#front', east: '#side', south: '#back', west: '#side' },
    })
    .json('assets/computercraft/models/block/monitor_advanced_lrud.json', {
      parent: 'computercraft:block/monitor_base',
      textures: {
        back: 'computercraft:block/monitor_advanced_43', front: 'computercraft:block/monitor_advanced_27',
        side: 'computercraft:block/monitor_advanced_6', top: 'computercraft:block/monitor_advanced_2',
      },
    })
    .json('assets/computercraft/blockstates/monitor_advanced.json', {
      variants: {
        'facing=south,orientation=north,state=lrud': { model: 'computercraft:block/monitor_advanced_lrud', x: 0, y: 180 },
        'facing=west,orientation=north,state=lrud': { model: 'computercraft:block/monitor_advanced_lrud', x: 0, y: 270 },
      },
    })
    // the interior tile is the real thing: fully transparent, the renderer owns it
    .png('assets/computercraft/textures/block/monitor_advanced_27.png', 0)
    .png('assets/computercraft/textures/block/monitor_advanced_43.png', 255)
    .png('assets/computercraft/textures/block/monitor_advanced_6.png', 255)
    .png('assets/computercraft/textures/block/monitor_advanced_2.png', 255);
  return new PackStack().add(mem);
}

test('a south-facing monitor gets a blank-terminal backdrop behind its south face', () => {
  const reg = new BlockRegistry(monitorPack(), { blockEntityBlocks: ['computercraft:monitor_advanced'] });
  const s = reg.resolve('computercraft:monitor_advanced[facing=south,orientation=north,state=lrud]');
  const screen = s.quads.filter((q) => q.texture === INTERIOR_DARK_SPRITE);
  assert.equal(screen.length, 1, 'exactly one backdrop quad');
  assert.equal(screen[0].facing, 'south', 'rotated onto the block front with the bezel');
  assert.equal(screen[0].cullface, null, 'never culled by a neighbour');
  // Just inside the front face (1/16), so the bezel in front wins where it is opaque.
  const zs = [0, 1, 2, 3].map((i) => screen[0].positions[i * 3 + 2]);
  for (const z of zs) assert.ok(Math.abs(z - 15 / 16) < 1e-6, `backdrop z=${z}, want 15/16`);
  // The bezel is still there and the block is otherwise what the JSON says.
  assert.equal(s.quads.length, 7, 'six cube faces plus the screen');
  assert.equal(s.renderType, 'cutout');
  // The front is transparent in the TEXTURE only because the renderer paints it; with the
  // backdrop there the block occludes like the full cube it is in game — otherwise the side
  // faces between two monitors survive and draw a grid of seams across the merged screen.
  assert.equal(s.opaqueFullCube, true, 'a monitor with its screen occludes its neighbours');
  assert.equal(s.provenance, 'asset');
});

test('the backdrop follows the variant rotation to a west-facing front', () => {
  const reg = new BlockRegistry(monitorPack(), { blockEntityBlocks: ['computercraft:monitor_advanced'] });
  const s = reg.resolve('computercraft:monitor_advanced[facing=west,orientation=north,state=lrud]');
  const screen = s.quads.filter((q) => q.texture === INTERIOR_DARK_SPRITE);
  assert.equal(screen.length, 1);
  assert.equal(screen[0].facing, 'west');
  const xs = [0, 1, 2, 3].map((i) => screen[0].positions[i * 3]);
  for (const x of xs) assert.ok(Math.abs(x - 1 / 16) < 1e-6, `backdrop x=${x}, want 1/16`);
});

test('the same block WITHOUT a block entity in the world is left as the plain cutout cube it is', () => {
  // leaves, glass panes, anything cutout: no renderer paints them, so no backdrop
  const reg = new BlockRegistry(monitorPack());
  const s = reg.resolve('computercraft:monitor_advanced[facing=south,orientation=north,state=lrud]');
  assert.equal(s.quads.filter((q) => q.texture === INTERIOR_DARK_SPRITE).length, 0);
  assert.equal(s.quads.length, 6);
  assert.equal(s.opaqueFullCube, false);
});

test('the synthesised sprite is served by every pack stack', () => {
  const stack = new PackStack();
  assert.ok(stack.has('assets/mcwv/textures/block/interior_dark.png'));
});
