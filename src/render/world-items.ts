/**
 * Items drawn in the world with a real orientation.
 *
 * A `THREE.Sprite` always faces the camera, which is right for a dropped item tumbling on
 * the ground and wrong for one held in a fist: vanilla gives a held item an orientation from
 * its model's `display` block, and `item/handheld` rolls a sword 55 degrees so it sits
 * diagonally rather than flat. A sprite has no orientation to roll.
 *
 * So this is the sprite path's sibling for things that DO have a facing — same canvas
 * textures, same place/retain lifecycle, but a real quad in world space carrying a full
 * rotation. It is deliberately not a new asset pipeline: the canvas comes from the same
 * `ItemIcons` the hotbar and the dropped-item billboards use.
 *
 * Double-sided and alpha-tested, because a flat item seen from behind must still be there —
 * vanilla's is a thin extruded solid and ours is one quad, which reads the same at the size
 * a held item occupies and costs two triangles instead of dozens.
 */

import * as THREE from 'three';

type Canvas = HTMLCanvasElement | OffscreenCanvas;

interface Entry {
  mesh: THREE.Mesh;
  key: string;
  aspect: number;
}

/** Rotation in DEGREES about x, then y, then z — vanilla's `display` order. */
export type Euler = readonly [number, number, number];

export class WorldItems {
  private items = new Map<string, Entry>();
  private textures = new Map<string, THREE.Texture>();

  constructor(private scene: THREE.Scene) {}

  get size(): number {
    return this.items.size;
  }

  /**
   * Ensure an oriented quad for `id`.
   *
   * `yawDeg` turns it with whatever carries it (a mob's body); `displayDeg` is the item
   * model's own rotation. They compose in that order, which is what vanilla's PoseStack does
   * — the body's yaw is applied first and the item's own orientation inside it.
   */
  place(
    id: string,
    texKey: string,
    canvas: Canvas,
    pos: readonly [number, number, number],
    height: number,
    yawDeg: number,
    displayDeg: Euler = [0, 0, 0],
  ): void {
    const tex = this.texture(texKey, canvas);
    const image = tex.image as { width: number; height: number };
    const aspect = image.height ? image.width / image.height : 1;
    let e = this.items.get(id);
    if (!e) {
      const material = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, fog: false,
      });
      e = { mesh: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material), key: texKey, aspect };
      this.scene.add(e.mesh);
      this.items.set(id, e);
    } else if (e.key !== texKey) {
      const m = e.mesh.material as THREE.MeshBasicMaterial;
      m.map = tex;
      m.needsUpdate = true;
      e.key = texKey;
      e.aspect = aspect;
    }
    e.mesh.position.set(pos[0], pos[1], pos[2]);
    e.mesh.scale.set(height * e.aspect, height, 1);
    const r = (d: number) => (d * Math.PI) / 180;
    e.mesh.rotation.set(r(displayDeg[0]), r(yawDeg + displayDeg[1]), r(displayDeg[2]), 'YXZ');
  }

  private texture(texKey: string, canvas: Canvas): THREE.Texture {
    const hit = this.textures.get(texKey);
    if (hit) return hit;
    const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.textures.set(texKey, tex);
    return tex;
  }

  /** Drop every item whose id is not in `alive`. */
  retain(alive: ReadonlySet<string>): void {
    for (const [id, e] of this.items) {
      if (alive.has(id)) continue;
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      (e.mesh.material as THREE.Material).dispose();
      this.items.delete(id);
    }
  }

  clear(): void {
    this.retain(new Set());
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}
