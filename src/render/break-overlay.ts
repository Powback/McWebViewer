/**
 * The mining crack overlay: the cube of cracks that grows over the block you are breaking.
 *
 * Ten stages, because that is how many `destroy_stage_N.png` textures the client jar ships.
 * Which stage to draw and when comes from `app/break-progress.ts`, whose timing is the
 * game's own — extracted hardness, extracted tool speeds, and the merged `mineable/*` tags.
 * This file only draws it.
 *
 * THREE THINGS THAT MAKE IT LOOK RIGHT RATHER THAN NEARLY RIGHT:
 *
 * 1. **It is inflated, not coincident.** A cube drawn exactly on the block's faces
 *    z-fights: every pixel is at the same depth as the block under it and the two flicker
 *    against each other as the camera moves. Vanilla offsets by a small epsilon and so does
 *    this — 1/256 of a block, big enough to win the depth test and far too small to see.
 *
 * 2. **It is drawn on ALL SIX faces of a full cube, whatever the block's real shape.** That
 *    is what vanilla does too: the crack overlay is a cube, not a copy of the block's
 *    collision or model geometry. Trying to match a stair's shape would be more work for a
 *    worse result, since the overlay reads as "this block is breaking" rather than as part
 *    of the block.
 *
 * 3. **One mesh, retextured.** The geometry never changes — only which of the ten sprites
 *    it samples — so advancing a stage rewrites eight UV pairs rather than rebuilding a
 *    mesh. A stage change happens ten times per block broken and must cost nothing.
 */

import * as THREE from 'three';
import type { SpriteRect, TextureAtlas } from './atlas.js';

/** How far outside the block's faces the overlay sits, in blocks. */
const INFLATE = 1 / 256;

/** `minecraft:block/destroy_stage_<n>` — the ids the bake was told to include. */
export function destroyStageSprite(stage: number): string {
  return `minecraft:block/destroy_stage_${Math.max(0, Math.min(9, stage))}`;
}

/**
 * The six faces of a unit cube, inflated, as position + uv arrays.
 *
 * Written out rather than reusing the block mesher: the mesher culls faces against
 * neighbours and applies lighting and tints, all of which are wrong here — the overlay must
 * be visible on every face regardless of what is next to it, and at full brightness.
 */
function cubeGeometry(): THREE.BufferGeometry {
  const lo = -INFLATE;
  const hi = 1 + INFLATE;
  const faces: Array<[number[], number[], number[], number[]]> = [
    // +Y, -Y, +X, -X, +Z, -Z, each counter-clockwise seen from outside.
    [[lo, hi, lo], [lo, hi, hi], [hi, hi, hi], [hi, hi, lo]],
    [[lo, lo, hi], [lo, lo, lo], [hi, lo, lo], [hi, lo, hi]],
    [[hi, lo, hi], [hi, lo, lo], [hi, hi, lo], [hi, hi, hi]],
    [[lo, lo, lo], [lo, lo, hi], [lo, hi, hi], [lo, hi, lo]],
    [[lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, hi, hi]],
    [[hi, lo, lo], [lo, lo, lo], [lo, hi, lo], [hi, hi, lo]],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  faces.forEach((quad, f) => {
    for (const v of quad) pos.push(v[0], v[1], v[2]);
    // Placeholder uvs; `setStage` writes the real ones.
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const b = f * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setIndex(idx);
  return geom;
}

export class BreakOverlay {
  private mesh: THREE.Mesh;
  private geom: THREE.BufferGeometry;
  private stage = -1;
  private atlas: TextureAtlas | null = null;

  constructor(private scene: THREE.Scene) {
    this.geom = cubeGeometry();
    this.mesh = new THREE.Mesh(this.geom, new THREE.MeshBasicMaterial({
      transparent: true,
      // The crack texture is mostly transparent with dark cracks; multiplying darkens the
      // block underneath instead of pasting a grey box over it, which is what vanilla does.
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      depthWrite: false,
      // Ever so slightly in front, so it never loses the depth test to its own block.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: false,
    }));
    this.mesh.visible = false;
    this.mesh.renderOrder = 500;
    this.scene.add(this.mesh);
  }

  setAtlas(atlas: TextureAtlas): void {
    this.atlas = atlas;
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    const tex = new THREE.CanvasTexture(atlas.canvas as unknown as HTMLCanvasElement);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex;
    mat.needsUpdate = true;
    // The stage was set before the atlas arrived; re-apply so the uvs are real.
    if (this.stage >= 0) this.applyStage(this.stage, true);
  }

  /**
   * Show the overlay on a block, or hide it.
   *
   * `stage` below zero hides it, which is what `BreakTracker` reports when nothing is being
   * broken — so "not digging" and "just started" stay distinguishable.
   */
  show(pos: readonly [number, number, number] | null, stage: number): void {
    if (!pos || stage < 0) {
      this.mesh.visible = false;
      this.stage = -1;
      return;
    }
    this.mesh.position.set(pos[0], pos[1], pos[2]);
    this.mesh.visible = true;
    this.applyStage(stage, false);
  }

  private applyStage(stage: number, force: boolean): void {
    if (stage === this.stage && !force) return;
    this.stage = stage;
    const rect: SpriteRect | undefined = this.atlas?.get(destroyStageSprite(stage));
    if (!rect) return;
    const uv = this.geom.getAttribute('uv') as THREE.BufferAttribute;
    // Same rect on all six faces: the crack pattern is the same on every side.
    for (let f = 0; f < 6; f++) {
      const b = f * 4;
      uv.setXY(b, rect.u0, rect.v0);
      uv.setXY(b + 1, rect.u1, rect.v0);
      uv.setXY(b + 2, rect.u1, rect.v1);
      uv.setXY(b + 3, rect.u0, rect.v1);
    }
    uv.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
