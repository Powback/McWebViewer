/**
 * Oriented items in the world.
 *
 * A `THREE.Sprite` always faces the camera, which is right for a dropped item and wrong for
 * a held one: vanilla gives a held item an orientation from its model's `display` block, and
 * `item/handheld` rolls a sword 55 degrees. A sprite has no orientation to roll, which is why
 * the mob held-item caveat existed and why this exists to remove it.
 *
 * Runs against real three.js objects and reads the transforms back off them.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as THREE from 'three';

import { WorldItems } from './world-items.js';

/** A 2:1 canvas stand-in, so the aspect handling is exercised rather than assumed. */
function canvasOf(w = 16, h = 16): HTMLCanvasElement {
  return { width: w, height: h } as unknown as HTMLCanvasElement;
}

function items() {
  const scene = new THREE.Scene();
  return { scene, wi: new WorldItems(scene) };
}

const deg = (r: number) => (r * 180) / Math.PI;

test('placing an item adds one mesh to the scene', () => {
  const { scene, wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [1, 2, 3], 0.4, 0);
  assert.equal(wi.size, 1);
  assert.equal(scene.children.length, 1);
  assert.equal((scene.children[0] as THREE.Mesh).position.x, 1);
});

test('placing the same id again moves it rather than adding another', () => {
  const { scene, wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [1, 2, 3], 0.4, 0);
  wi.place('a', 'item:bow', canvasOf(), [9, 9, 9], 0.4, 0);
  assert.equal(wi.size, 1);
  assert.equal(scene.children.length, 1, 'no leak per frame');
  assert.equal((scene.children[0] as THREE.Mesh).position.x, 9);
});

// The whole point: a held item carries the model's own rotation.
test("the item model's roll is applied — a sword sits diagonally, not flat", () => {
  const { wi } = items();
  wi.place('a', 'item:golden_sword', canvasOf(), [0, 0, 0], 0.4, 0, [0, -90, 55]);
  const m = (wi as unknown as { items: Map<string, { mesh: THREE.Mesh }> }).items.get('a')!.mesh;
  assert.ok(Math.abs(deg(m.rotation.z) - 55) < 1e-6, `roll ${deg(m.rotation.z)}`);
  assert.ok(Math.abs(deg(m.rotation.x)) < 1e-6);
});

test('the body yaw and the item rotation compose on the Y axis', () => {
  const { wi } = items();
  wi.place('a', 'item:golden_sword', canvasOf(), [0, 0, 0], 0.4, 30, [0, -90, 55]);
  const m = (wi as unknown as { items: Map<string, { mesh: THREE.Mesh }> }).items.get('a')!.mesh;
  assert.ok(Math.abs(deg(m.rotation.y) - -60) < 1e-6, `yaw ${deg(m.rotation.y)} should be 30 + -90`);
});

test('with no display rotation the item just follows the body', () => {
  const { wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 45);
  const m = (wi as unknown as { items: Map<string, { mesh: THREE.Mesh }> }).items.get('a')!.mesh;
  assert.ok(Math.abs(deg(m.rotation.y) - 45) < 1e-6);
  assert.ok(Math.abs(deg(m.rotation.x)) < 1e-6);
  assert.ok(Math.abs(deg(m.rotation.z)) < 1e-6);
});

test('a non-square icon keeps its aspect instead of being squashed', () => {
  const { wi } = items();
  wi.place('a', 'item:wide', canvasOf(32, 16), [0, 0, 0], 0.4, 0);
  const m = (wi as unknown as { items: Map<string, { mesh: THREE.Mesh }> }).items.get('a')!.mesh;
  assert.ok(Math.abs(m.scale.x - 0.8) < 1e-9, `width ${m.scale.x}`);
  assert.ok(Math.abs(m.scale.y - 0.4) < 1e-9, `height ${m.scale.y}`);
});

test('retain drops what is gone and keeps what is not', () => {
  const { scene, wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 0);
  wi.place('b', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 0);
  wi.retain(new Set(['a']));
  assert.equal(wi.size, 1);
  assert.equal(scene.children.length, 1, 'the dropped mesh left the scene too');
});

test('a texture is shared between items showing the same icon', () => {
  const { wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 0);
  wi.place('b', 'item:bow', canvasOf(), [1, 0, 0], 0.4, 0);
  const map = (wi as unknown as { textures: Map<string, THREE.Texture> }).textures;
  assert.equal(map.size, 1, '23 skeletons with bows share one texture');
});

test('changing an item swaps the texture without replacing the mesh', () => {
  const { scene, wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 0);
  const before = scene.children[0];
  wi.place('a', 'item:golden_sword', canvasOf(), [0, 0, 0], 0.4, 0);
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0], before, 'the same mesh, re-textured');
});

test('clear empties the scene and the texture cache', () => {
  const { scene, wi } = items();
  wi.place('a', 'item:bow', canvasOf(), [0, 0, 0], 0.4, 0);
  wi.clear();
  assert.equal(wi.size, 0);
  assert.equal(scene.children.length, 0);
  assert.equal((wi as unknown as { textures: Map<string, THREE.Texture> }).textures.size, 0);
});

// Rotation order matters: YXZ applies the body yaw outermost, which is what a PoseStack
// pushing the body transform before the item's own does.
test('the rotation order puts the body yaw outside the item rotation', () => {
  const { wi } = items();
  wi.place('a', 'item:x', canvasOf(), [0, 0, 0], 0.4, 0, [0, 0, 0]);
  const m = (wi as unknown as { items: Map<string, { mesh: THREE.Mesh }> }).items.get('a')!.mesh;
  assert.equal(m.rotation.order, 'YXZ');
});
