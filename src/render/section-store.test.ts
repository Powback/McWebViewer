/**
 * GPU RESOURCES ARE RELEASED WHEN A SECTION IS REPLACED OR EVICTED.
 *
 * This is the class of bug that killed the tab, and it is invisible from the outside: a
 * leaked section still draws nothing (it is behind you, frustum-culled) and costs nothing
 * per frame. It just never goes away, and forty seconds later the page reloads itself.
 * Nothing in the UI moves until it dies, so it has to be pinned here.
 *
 * Three claims, each of them a way the old code could have leaked:
 *
 *   1. adding over an existing key disposes the old geometry — region-sync re-meshes the
 *      same key every time a turtle steps, so a replace that leaks is a leak per block
 *      moved by every drone on the server;
 *   2. removing a section disposes its geometry AND takes it out of the scene graph;
 *   3. the byte and quad totals come back DOWN, because the viewer's own counters only ever
 *      went up and so agreed with the leak instead of exposing it.
 *
 * `dispose()` is observed through three.js's own 'dispose' event, which is exactly what the
 * renderer listens to in order to free the GL buffer — so "was disposed" here means the
 * same thing it means to WebGL, not that a flag was set.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Object3D,
} from 'three';
import { SectionStore, geometryBytes, releaseAfterUpload } from './section-store.js';
import { DEFAULT_KEEP, planRetention, type SectionRecord, type ViewPoint } from './section-budget.js';

const material = new MeshBasicMaterial();

/** A section-shaped geometry: the same five attributes and index the mesher emits. */
function sectionGeometry(quads: number): BufferGeometry {
  const verts = quads * 4;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(verts * 2), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(verts * 4), 4));
  g.setAttribute('anim', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(quads * 6), 1));
  return g;
}

/** Watch a geometry for the 'dispose' event the WebGL renderer frees its buffers on. */
function watchDispose(g: BufferGeometry): () => boolean {
  let fired = false;
  g.addEventListener('dispose', () => { fired = true; });
  return () => fired;
}

function sectionMesh(quads: number): { mesh: Mesh; disposed: () => boolean } {
  const g = sectionGeometry(quads);
  return { mesh: new Mesh(g, material), disposed: watchDispose(g) };
}

test('adding over an existing key disposes the geometry it replaces', () => {
  const scene = new Object3D();
  const store = new SectionStore(scene);
  const first = sectionMesh(100);
  store.add('4,4,3', [first.mesh], { centre: [72, 72, 56], quads: 100 });
  assert.equal(first.disposed(), false);
  assert.equal(scene.children.length, 1);

  const second = sectionMesh(50);
  store.add('4,4,3', [second.mesh], { centre: [72, 72, 56], quads: 50 });

  assert.equal(first.disposed(), true, 'the replaced geometry was never disposed');
  assert.equal(scene.children.length, 1, 'the replaced mesh is still in the scene');
  assert.equal(scene.children[0], second.mesh);
  assert.equal(store.quads, 50, 'the quad count still holds the replaced section');
  assert.equal(store.bytes, geometryBytes(second.mesh.geometry as BufferGeometry));
});

test('removing a section disposes every layer and empties the scene', () => {
  const scene = new Object3D();
  const store = new SectionStore(scene);
  const solid = sectionMesh(80);
  const cutout = sectionMesh(20);
  store.add('0,0,0', [solid.mesh, cutout.mesh], { centre: [8, 8, 8], quads: 100 });
  assert.equal(scene.children.length, 2);
  const before = store.bytes;
  assert.ok(before > 0);

  assert.equal(store.remove('0,0,0'), true);

  assert.equal(solid.disposed(), true);
  assert.equal(cutout.disposed(), true);
  assert.equal(scene.children.length, 0);
  assert.equal(store.bytes, 0, 'bytes did not come back down');
  assert.equal(store.quads, 0, 'quads did not come back down');
  assert.equal(store.sectionCount, 0);
});

test('clear disposes everything, sections and entity meshes alike', () => {
  const scene = new Object3D();
  const store = new SectionStore(scene);
  const watches: Array<() => boolean> = [];
  for (let i = 0; i < 8; i++) {
    const m = sectionMesh(40);
    watches.push(m.disposed);
    store.add(`0,${i},0`, [m.mesh], { centre: [8, i * 16 + 8, 8], quads: 40 });
  }
  const entity = sectionMesh(10);
  store.add('mob:minecraft:cow:1', [entity.mesh], { centre: null, quads: 0 });
  assert.equal(store.sectionCount, 8);
  assert.equal(store.size, 9);

  store.clear();

  assert.equal(scene.children.length, 0);
  assert.equal(store.size, 0);
  assert.equal(store.bytes, 0);
  assert.equal(store.quads, 0);
  assert.ok(watches.every((w) => w()), 'a section survived clear() undisposed');
  assert.equal(entity.disposed(), true, 'an entity mesh survived clear() undisposed');
});

test('an evicted section is really gone: the plan, applied, frees its bytes', () => {
  // The whole loop, end to end: fill the store past a small ceiling, ask the budget what to
  // drop, apply it, and check the scene and the byte total actually came down. A plan that
  // is computed and not applied is exactly the bug that shipped.
  const scene = new Object3D();
  const store = new SectionStore(scene);
  const view: ViewPoint = { eye: [0, 64, 0], forward: [0, 0, -1] };
  for (let i = 1; i <= 40; i++) {
    const { mesh } = sectionMesh(200);
    store.add(`0,4,${-i}`, [mesh], { centre: [0, 64, -i * 16], quads: 200 });
  }
  const full = store.bytes;
  const cap = Math.floor(full / 4);

  const records: SectionRecord[] = [];
  for (const [key, entry] of store.all()) {
    if (entry.centre) records.push({ key, centre: entry.centre, bytes: entry.bytes });
  }
  const plan = planRetention(records, view, DEFAULT_KEEP, cap);
  for (const key of plan.drop) store.remove(key);

  assert.ok(plan.drop.length > 0, 'the ceiling should have forced drops');
  assert.ok(store.bytes <= cap, `store holds ${store.bytes} bytes over a ${cap} ceiling`);
  assert.equal(scene.children.length, store.size, 'scene and store disagree about what exists');
  // And what survived is the near end: eviction must not be arbitrary.
  assert.ok(store.has('0,4,-1'), 'evicted the section right in front of the camera');
});

test('a geometry releases its CPU arrays on upload but keeps everything the GPU needs', () => {
  const g = sectionGeometry(64);
  const bytes = geometryBytes(g);
  assert.ok(bytes > 0);
  releaseAfterUpload(g);
  const position = g.getAttribute('position') as BufferAttribute;
  const counts = { position: position.count, index: g.index!.count };

  // What WebGLAttributes does once the buffer exists. Calling it by hand is the only way to
  // reach this path without a GL context, and it is the same callback three.js invokes.
  for (const attr of Object.values(g.attributes)) {
    (attr as BufferAttribute).onUploadCallback.call(attr);
  }
  g.index!.onUploadCallback.call(g.index!);

  assert.equal(position.array, null, 'the CPU copy of the vertex data was not released');
  assert.equal(g.index!.array, null, 'the CPU copy of the index was not released');
  // The draw still needs these, and they must survive the release.
  assert.equal(position.count, counts.position);
  assert.equal(g.index!.count, counts.index);
  assert.equal(position.itemSize, 3);
});

test('the byte total is measured before release, not after', () => {
  // A figure read back off the live arrays would say a section costs nothing the moment it
  // is drawn, which would hand the budget an ever-growing allowance and put the crash
  // straight back.
  const scene = new Object3D();
  const store = new SectionStore(scene);
  const { mesh } = sectionMesh(128);
  store.add('1,1,1', [mesh], { centre: [24, 24, 24], quads: 128 });
  const measured = store.bytes;
  assert.ok(measured > 0);

  const g = mesh.geometry as BufferGeometry;
  for (const attr of Object.values(g.attributes)) {
    (attr as BufferAttribute).onUploadCallback.call(attr);
  }
  g.index!.onUploadCallback.call(g.index!);

  assert.equal(store.bytes, measured, 'the budget forgot what an uploaded section costs');
  assert.equal(geometryBytes(g), 0, 'fixture: the arrays really were released');
});
