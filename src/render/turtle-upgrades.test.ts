/**
 * A turtle's upgrades come from its block entity, not its state, and their models from the
 * jars by one generic path: upgrade definition -> sided model by naming convention -> the
 * item's own model. These run the real registry over an in-memory pack shaped like the mods'
 * files, with nothing mod-specific in the code under test.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PackStack, type Pack } from '../assets/pack.js';
import { encodeRgba } from '../assets/png.js';
import type { NbtCompound } from '../core/nbt.js';
import { BlockRegistry } from './registry.js';
import {
  readTurtleUpgrades, sidedModelCandidates, upgradeStateKey, upgradeStateKeysAllFacings, TURTLE_UPGRADE_STATE,
} from './turtle-upgrades.js';

class MemPack implements Pack {
  readonly name = 'mem';
  private files = new Map<string, Uint8Array>();
  json(path: string, v: unknown) { this.files.set(path, new TextEncoder().encode(JSON.stringify(v))); return this; }
  png(path: string) {
    const data = new Uint8Array(16 * 16 * 4).fill(255);
    this.files.set(path, encodeRgba({ width: 16, height: 16, data }));
    return this;
  }
  has(p: string) { return this.files.has(p); }
  get(p: string) { return this.files.get(p); }
  list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}

const SIDE_BOX_LEFT = { from: [0.5, 4.5, 3.5], to: [2, 12.5, 11.5] };
const SIDE_BOX_RIGHT = { from: [14, 4.5, 3.5], to: [15.5, 12.5, 11.5] };

function pack(): Pack {
  const mem = new MemPack()
    .json('assets/minecraft/models/block/block.json', {})
    .json('assets/minecraft/models/item/generated.json', {})
    .json('assets/minecraft/models/item/handheld.json', { parent: 'minecraft:item/generated' })
    // the side footprint the mod ships (CC:T's turtle_upgrade_base_*)
    .json('assets/computercraft/models/block/turtle_upgrade_base_left.json', {
      parent: 'block/block', textures: { particle: '#texture' },
      elements: [{ ...SIDE_BOX_LEFT, faces: { west: { uv: [2, 2, 14, 14], texture: '#texture' } } }],
    })
    .json('assets/computercraft/models/block/turtle_upgrade_base_right.json', {
      parent: 'block/block', textures: { particle: '#texture' },
      elements: [{ ...SIDE_BOX_RIGHT, faces: { east: { uv: [2, 2, 14, 14], texture: '#texture' } } }],
    })
    // a mod upgrade with a sided model, named by the convention (Advanced Peripherals style)
    .json('data/somemod/computercraft/turtle_upgrade/scanner_turtle.json',
      { type: 'somemod:scanner_turtle', item: 'somemod:scanner' })
    .json('assets/somemod/models/block/turtle_scanner_left.json',
      { parent: 'computercraft:block/turtle_upgrade_base_left', textures: { texture: 'somemod:block/scanner_front' } })
    .png('assets/somemod/textures/block/scanner_front.png')
    // a tool: definition + a generated item model
    .json('data/minecraft/computercraft/turtle_upgrade/diamond_pickaxe.json',
      { type: 'computercraft:tool', item: 'minecraft:diamond_pickaxe' })
    .json('assets/minecraft/models/item/diamond_pickaxe.json',
      { parent: 'minecraft:item/handheld', textures: { layer0: 'minecraft:item/diamond_pickaxe' } })
    .png('assets/minecraft/textures/item/diamond_pickaxe.png')
    // a block item (a modem) with NO sided model of its own: drawn as its block, fitted to the side
    .json('data/computercraft/computercraft/turtle_upgrade/wireless_modem_normal.json',
      { type: 'computercraft:wireless_modem', item: 'computercraft:wireless_modem_normal' })
    .json('assets/computercraft/models/item/wireless_modem_normal.json', { parent: 'computercraft:block/modem_off' })
    .json('assets/computercraft/models/block/modem_off.json', {
      textures: { front: 'computercraft:block/modem_face' },
      elements: [{ from: [0, 0, 10], to: [16, 16, 16], faces: {
        north: { texture: '#front' }, south: { texture: '#front' }, up: { texture: '#front' },
        down: { texture: '#front' }, west: { texture: '#front' }, east: { texture: '#front' },
      } }],
    })
    .png('assets/computercraft/textures/block/modem_face.png')
    // ...and the sided modem models CC:T registers in CODE, under names the convention does
    // not predict; found by the words they share with the upgrade
    .json('assets/computercraft/models/block/turtle_modem_normal_on_left.json',
      { parent: 'computercraft:block/turtle_upgrade_base_left', textures: { texture: 'computercraft:block/modem_face_on' } })
    .json('assets/computercraft/models/block/turtle_modem_normal_off_left.json',
      { parent: 'computercraft:block/turtle_upgrade_base_left', textures: { texture: 'computercraft:block/modem_face' } })
    .png('assets/computercraft/textures/block/modem_face_on.png');
  return new PackStack().add(mem);
}

const axis = (q: { positions: Float32Array }, a: number) => [0, 1, 2, 3].map((i) => q.positions[i * 3 + a]);

test('a sided model is found by convention from the definition, and sits on the named side', () => {
  const reg = new BlockRegistry(pack());
  const s = reg.resolve(upgradeStateKey('north', 'left', { id: 'somemod:scanner_turtle', on: false }));
  assert.equal(s.provenance, 'extracted');
  assert.equal(s.quads.length, 1);
  assert.equal(s.quads[0].texture, 'somemod:block/scanner_front');
  for (const x of axis(s.quads[0], 0)) assert.ok(x <= 2 / 16 + 1e-6, `x=${x} is not on the west flank`);
});

test('the sided model turns with the turtle: facing east puts the left side to the north', () => {
  const reg = new BlockRegistry(pack());
  const s = reg.resolve(upgradeStateKey('east', 'left', { id: 'somemod:scanner_turtle', on: false }));
  for (const z of axis(s.quads[0], 2)) assert.ok(z <= 2 / 16 + 1e-6, `z=${z}: not on the north flank`);
});

test('candidates cover the upgrade, type and item namespaces and the stripped name', () => {
  const c = sidedModelCandidates('somemod:scanner_turtle', { type: 'somemod:scanner_turtle', item: 'othermod:scanner' }, 'right');
  assert.ok(c.includes('somemod:block/turtle_scanner_right'));
  assert.ok(c.includes('somemod:block/turtle_scanner_turtle_right'));
  assert.ok(c.includes('othermod:block/turtle_scanner_right'));
});

test('a tool is its item stood flat on the side at the 0.4065 offset, one face, facing out', () => {
  const reg = new BlockRegistry(pack());
  const s = reg.resolve(upgradeStateKey('north', 'right', { id: 'minecraft:diamond_pickaxe', on: false }));
  assert.equal(s.provenance, 'extracted');
  assert.equal(s.quads.length, 1, 'one face, on the outside — two drew a mirrored twin');
  assert.equal(s.quads[0].facing, 'east');
  assert.equal(s.quads[0].texture, 'minecraft:item/diamond_pickaxe');
  for (const x of axis(s.quads[0], 0)) assert.ok(Math.abs(x - (0.5 + 0.4065)) < 0.04, `x=${x}`);
  // image top (v=0) toward the FRONT of a north-facing turtle: the vertex with v=0 has the smaller z
  const q = s.quads[0];
  const vOf = (i: number) => q.uvs[i * 2 + 1];
  const top = [0, 1, 2, 3].filter((i) => vOf(i) < 0.5).map((i) => q.positions[i * 3 + 2]);
  const bottom = [0, 1, 2, 3].filter((i) => vOf(i) > 0.5).map((i) => q.positions[i * 3 + 2]);
  assert.ok(Math.max(...top) < Math.min(...bottom), 'image top must be toward the front (north, z small)');
});

test('a code-registered sided model is found by the words it shares with the upgrade, state included', () => {
  const reg = new BlockRegistry(pack());
  const on = reg.resolve(upgradeStateKey('north', 'left', { id: 'computercraft:wireless_modem_normal', on: true }));
  assert.equal(on.quads.length, 1);
  assert.equal(on.quads[0].texture, 'computercraft:block/modem_face_on', 'the ON model for an on modem');
  const off = reg.resolve(upgradeStateKey('north', 'left', { id: 'computercraft:wireless_modem_normal', on: false }));
  assert.equal(off.quads[0].texture, 'computercraft:block/modem_face', 'the OFF model for an off modem');
});

test('a block item with no sided model is its block, fitted into the side footprint', () => {
  const reg = new BlockRegistry(pack());
  // the right side has no sided modem model in this pack, so the item path takes over
  const s = reg.resolve(upgradeStateKey('north', 'right', { id: 'computercraft:wireless_modem_normal', on: true }));
  assert.equal(s.provenance, 'extracted');
  assert.ok(s.quads.length >= 5, 'the block model, not a card');
  const xs = s.quads.flatMap((q) => axis(q, 0));
  const ys = s.quads.flatMap((q) => axis(q, 1));
  assert.ok(Math.min(...xs) >= SIDE_BOX_RIGHT.from[0] / 16 - 1e-6 && Math.max(...xs) <= SIDE_BOX_RIGHT.to[0] / 16 + 1e-6, 'within the footprint (x)');
  assert.ok(Math.min(...ys) >= SIDE_BOX_RIGHT.from[1] / 16 - 1e-6 && Math.max(...ys) <= SIDE_BOX_RIGHT.to[1] / 16 + 1e-6, 'within the footprint (y)');
});

test('an upgrade the packs do not define renders as nothing rather than throwing', () => {
  const reg = new BlockRegistry(pack());
  const s = reg.resolve(upgradeStateKey('north', 'left', { id: 'somemod:mystery', on: false }));
  assert.equal(s.quads.length, 0);
  assert.equal(s.provenance, 'none');
});

test('block entity NBT -> upgrades -> one key per side per facing; no block name involved', () => {
  const be: NbtCompound = {
    id: 'anymod:some_turtle_like_thing',
    LeftUpgrade: { id: 'computercraft:wireless_modem_normal', components: { 'computercraft:on': 1 } },
    RightUpgrade: { id: 'minecraft:diamond_pickaxe' },
  } as unknown as NbtCompound;
  const ups = readTurtleUpgrades(be)!;
  assert.deepEqual(ups, {
    left: { id: 'computercraft:wireless_modem_normal', on: true },
    right: { id: 'minecraft:diamond_pickaxe', on: false },
  });
  const keys = upgradeStateKeysAllFacings(ups);
  assert.equal(keys.length, 8);
  assert.ok(keys.every((k) => k.startsWith(TURTLE_UPGRADE_STATE + '[')));
  assert.equal(readTurtleUpgrades({ id: 'computercraft:turtle_normal' } as NbtCompound), null);
});
