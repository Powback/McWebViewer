/**
 * The item in each hand, drawn in the world in front of the camera.
 *
 * WIDENS AN EXISTING MECHANISM RATHER THAN ADDING ONE. A block item is meshed by the very
 * same `meshBlockSet` that already draws falling blocks and Create contraptions, through
 * the same registry and the same atlas — so a modded block held in hand is correct for
 * exactly the reason a modded block in the world is. A flat item is a quad sampling the
 * item atlas the hotbar icons already come from. There is no new asset pipeline here and
 * nothing that knows about any specific item.
 *
 * WHAT THIS IS NOT. It is not vanilla's first-person renderer. Vanilla positions a held
 * item with the `display.firstperson_righthand` transform baked into each item model, plus
 * an arm, plus a swing animation. The transforms are in the model JSON and the bake does
 * not currently carry them, so the placement here is a fixed offset that reads correctly
 * rather than one derived from the model — stated so nobody mistakes it for exact. Getting
 * the real transforms is an extension to `item-bake.ts`, not a rewrite of this.
 *
 * Held items are attached to the CAMERA, not to the world: they move with the view and are
 * not affected by the world's fog or by the reveal shader, which is what makes them read as
 * "in my hand" rather than "floating over there".
 */

import * as THREE from 'three';
import type { TextureAtlas } from './atlas.js';
import { meshBlockSet } from './entities.js';
import type { ItemIcons } from './item-icons.js';
import type { StateSource } from './mesher.js';

export type Hand = 'main' | 'off';

/** Where each hand sits, in camera space: right/left, down, and forward. */
const PLACEMENT: Record<Hand, { x: number; y: number; z: number; scale: number; spin: number }> = {
  // Slightly below the centre line and off to the side, far enough forward to clear the
  // near plane. A held block reads at about a third of a block on screen.
  main: { x: 0.32, y: -0.30, z: -0.55, scale: 0.34, spin: -0.5 },
  off: { x: -0.32, y: -0.30, z: -0.55, scale: 0.34, spin: 0.5 },
};

export interface HeldItemDeps {
  camera: THREE.Camera;
  getStates: () => StateSource | null;
  getAtlas: () => TextureAtlas | null;
  /**
   * The baked item icons.
   *
   * Reused rather than re-plumbed: `ItemIcons.get` already composites a 32px canvas for any
   * item in any mod — flat sprite or isometric block — and a canvas is one constructor away
   * from a texture. Threading the item ATLAS through instead would mean a second uv lookup
   * and a second texture for no gain.
   */
  getIcons: () => ItemIcons | null;
}

/**
 * Is this id a BLOCK we can mesh, or a flat item?
 *
 * Asked of the registry rather than guessed from the name: `create:shaft` is a block and
 * `create:shaft` as an item id is the same string, so only the registry knows. A state that
 * resolves to no geometry is treated as flat, which is the safe direction — a flat sprite
 * always draws something.
 */
export function isBlockItem(id: string, states: StateSource | null): boolean {
  if (!states) return false;
  const resolved = states.resolve(id);
  return resolved.quads.length > 0;
}

export interface Stack { slot: number; id: string; count: number }

/**
 * Which item is in each hand, from one inventory read.
 *
 * `data get entity <name> Inventory` returns EVERY compartment in one list keyed by slot,
 * so the off hand is already in the data — it just needs identifying by its slot number.
 *
 * When `offhandSlot` is not known the off hand is EMPTY rather than guessed. A wrong slot
 * would confidently show the wrong item, which is worse than showing none: an empty hand
 * reads as "nothing there", a wrong one reads as a fact.
 */
export function handsFrom(
  stacks: readonly Stack[],
  selectedSlot: number,
  offhandSlot: number | undefined,
): { main: string | null; off: string | null } {
  const at = (slot: number): string | null => {
    const hit = stacks.find((s) => s.slot === slot);
    return hit && hit.id && hit.count > 0 ? hit.id : null;
  };
  return {
    main: at(selectedSlot),
    off: offhandSlot === undefined ? null : at(offhandSlot),
  };
}

export class HeldItems {
  private meshes: Partial<Record<Hand, THREE.Object3D>> = {};
  private shown: Partial<Record<Hand, string | null>> = {};
  private blockCache = new Map<string, THREE.Object3D | null>();
  private atlasTexture: THREE.CanvasTexture | null = null;

  readonly stats = { main: '', off: '', drawn: 0 };

  constructor(private deps: HeldItemDeps) {}

  /**
   * Set what is in a hand. `null` empties it.
   *
   * Cheap to call every frame: an unchanged id is a no-op, because rebuilding a mesh per
   * frame for something that has not changed is exactly the kind of cost that shows up as a
   * frame-rate mystery later.
   */
  set(hand: Hand, id: string | null): void {
    if (this.shown[hand] === id) return;
    this.shown[hand] = id;
    this.stats[hand] = id ?? '';
    const old = this.meshes[hand];
    if (old) {
      this.deps.camera.remove(old);
      delete this.meshes[hand];
    }
    if (!id) return;
    const built = this.build(id);
    if (!built) return;
    // The item model's own first-person orientation, where it has one. Only the ROTATION is
    // taken: vanilla composes it with the first-person arm's pose, which this viewer does not
    // model, so its translation and scale are relative to a frame we do not have and would
    // move the item somewhere wrong. The rotation is frame-independent and is what makes a
    // sword sit diagonally in the fist rather than flat — `item/handheld` rolls it 55
    // degrees. Falls back to the fixed spin for items with no `display` block.
    const t = this.deps.getIcons()?.transformFor(
      id, hand === 'off' ? 'firstperson_lefthand' : 'firstperson_righthand');
    place(built, PLACEMENT[hand], t?.rotation);
    this.deps.camera.add(built);
    this.meshes[hand] = built;
  }

  private build(id: string): THREE.Object3D | null {
    const states = this.deps.getStates();
    if (isBlockItem(id, states)) return this.blockModel(id);
    return this.flatModel(id);
  }

  /** A held block, through the ordinary block mesher. */
  private blockModel(id: string): THREE.Object3D | null {
    const hit = this.blockCache.get(id);
    if (hit !== undefined) return hit ? hit.clone() : null;
    const states = this.deps.getStates();
    const atlas = this.deps.getAtlas();
    if (!states || !atlas) return null;
    // Centred on the origin so the placement offsets mean what they say.
    const mesh = meshBlockSet([{ x: -0.5, y: -0.5, z: -0.5, stateKey: id }], states, atlas);
    if (!mesh.quadCount) {
      this.blockCache.set(id, null);
      return null;
    }
    const group = new THREE.Group();
    for (const buf of Object.values(mesh.layers)) {
      if (!buf) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(buf.uvs, 2));
      geom.setAttribute('color', new THREE.BufferAttribute(buf.colors, 4));
      geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
      group.add(new THREE.Mesh(geom, this.blockMaterial(atlas)));
    }
    this.blockCache.set(id, group);
    return group.clone();
  }

  private blockMaterial(atlas: TextureAtlas): THREE.Material {
    // Its own material rather than the world's: the held item must not be fogged, clipped
    // by the reveal shader, or lit by the world's block light.
    if (!this.atlasTexture) {
      this.atlasTexture = new THREE.CanvasTexture(atlas.canvas as unknown as HTMLCanvasElement);
      this.atlasTexture.magFilter = THREE.NearestFilter;
      this.atlasTexture.minFilter = THREE.NearestFilter;
      this.atlasTexture.flipY = false;
      this.atlasTexture.colorSpace = THREE.SRGBColorSpace;
    }
    return new THREE.MeshBasicMaterial({
      map: this.atlasTexture,
      vertexColors: true,
      alphaTest: 0.5,
      side: THREE.FrontSide,
      fog: false,
    });
  }

  /** A flat item: one quad showing the icon the hotbar already draws for it. */
  private flatModel(id: string): THREE.Object3D | null {
    const canvas = this.deps.getIcons()?.get(id) ?? null;
    if (!canvas) return null;
    const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      fog: false,
    }));
  }

  /** Remove both hands, e.g. when control is released. */
  clear(): void {
    this.set('main', null);
    this.set('off', null);
  }

  hudLine(): string {
    const main = this.stats.main ? shortName(this.stats.main) : '-';
    const off = this.stats.off ? shortName(this.stats.off) : '-';
    if (main === '-' && off === '-') return '';
    return ` | hands: ${main} / ${off}`;
  }
}

function place(
  o: THREE.Object3D,
  p: { x: number; y: number; z: number; scale: number; spin: number },
  rotationDeg?: readonly [number, number, number],
): void {
  o.position.set(p.x, p.y, p.z);
  o.scale.setScalar(p.scale);
  if (rotationDeg) {
    const r = (d: number) => (d * Math.PI) / 180;
    // Vanilla applies the display rotation X, then Y, then Z.
    o.rotation.set(r(rotationDeg[0]), r(rotationDeg[1]), r(rotationDeg[2]), 'XYZ');
  } else {
    o.rotation.set(0.15, p.spin, 0);
  }
  // Drawn after the world and never occluded by it: a held item is in front of your face,
  // and depth-testing it against terrain makes it vanish inside walls.
  o.renderOrder = 999;
  o.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.Material | undefined;
    if (m) m.depthTest = false;
  });
}

function shortName(id: string): string {
  return id.replace(/^[^:]+:/, '');
}
