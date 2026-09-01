/**
 * three.js renderer.
 *
 * One BufferGeometry per (section, layer). Sections are 16^3 rather than full columns
 * so frustum culling has something useful to reject — a 24-section column is almost
 * always partly on screen, whereas individual sections cull well.
 *
 * Materials: three shared materials, differing only in transparency/alphaTest, so all
 * solid geometry batches against one material and three.js can sort by it.
 */

import * as THREE from 'three';
import type { Layer, SectionMesh } from './mesher.js';
import type { TextureAtlas } from './atlas.js';

export interface ViewerStats {
  sections: number;
  quads: number;
  drawCalls: number;
  triangles: number;
  fps: number;
}

/** Shared so that turning the cutaway off does not allocate a new array every frame. */
const EMPTY_PLANES: THREE.Plane[] = [];

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private materials!: Record<Layer, THREE.Material>;
  private meshes = new Map<string, THREE.Mesh[]>();
  private texture!: THREE.Texture;

  quads = 0;
  private frameTimes: number[] = [];
  /**
   * The isometric mode's cutaway. Kept as one long-lived plane in one long-lived array:
   * three.js compiles clipping into the shader from `clippingPlanes.length`, so swapping
   * the array's identity every frame is free but changing its LENGTH recompiles every
   * material. Mutating the constant does not.
   */
  private cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private cutPlanes = [this.cutPlane];

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x87ceeb);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
    this.camera.position.set(0, 100, 0);
    this.scene.fog = new THREE.Fog(0x87ceeb, 300, 900);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setAtlas(atlas: TextureAtlas) {
    const tex = new THREE.CanvasTexture(atlas.canvas as unknown as HTMLCanvasElement);
    // NEAREST is what makes it look like Minecraft rather than a blurry approximation.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // The atlas is built in canvas coordinates (origin top-left, y down) and the sprite
    // rects are derived from those same coordinates, so the texture must NOT be flipped
    // on upload. three.js defaults flipY to true, which mirrors every sprite's V into
    // the atlas's unused lower half and samples fully transparent texels.
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.texture = tex;

    const common = { map: tex, vertexColors: true, side: THREE.FrontSide } as const;
    this.materials = {
      // A tiny alphaTest on the solid layer discards fully transparent texels. Vanilla's
      // solid layer has no alpha test, but it also never samples a transparent texel
      // there; modded models coincident-overlay freely, and without this those texels
      // write black over the base face.
      solid: new THREE.MeshBasicMaterial({ ...common, alphaTest: 0.02 }),
      cutout: new THREE.MeshBasicMaterial({ ...common, alphaTest: 0.5, transparent: false }),
      translucent: new THREE.MeshBasicMaterial({
        ...common,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    };
  }

  addSection(mesh: SectionMesh) {
    const key = `${mesh.cx},${mesh.cy},${mesh.cz}`;
    this.removeSection(key);
    const created: THREE.Mesh[] = [];
    for (const layer of ['solid', 'cutout', 'translucent'] as Layer[]) {
      const buf = mesh.layers[layer];
      if (!buf) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(buf.uvs, 2));
      geom.setAttribute('color', new THREE.BufferAttribute(buf.colors, 4));
      geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
      geom.computeBoundingSphere();
      const m = new THREE.Mesh(geom, this.materials[layer]);
      m.position.set(mesh.cx * 16, mesh.cy * 16, mesh.cz * 16);
      m.frustumCulled = true;
      // Translucent last so three.js depth-sorts it after opaque geometry.
      m.renderOrder = layer === 'translucent' ? 2 : layer === 'cutout' ? 1 : 0;
      this.scene.add(m);
      created.push(m);
    }
    this.meshes.set(key, created);
    this.quads += mesh.quadCount;
  }

  hasSection(key: string): boolean {
    return this.meshes.has(key);
  }

  /**
   * Add a free-standing mesh with its own transform — used for contraption entities,
   * which are ordinary blocks placed under one entity-level rotation.
   */
  addEntityMesh(
    key: string,
    layers: Partial<Record<Layer, {
      positions: Float32Array; normals: Float32Array; uvs: Float32Array;
      colors: Float32Array; indices: Uint32Array;
    }>>,
    transform: { pos: [number, number, number]; angleDeg: number; axis: 'X' | 'Y' | 'Z' | null },
  ) {
    this.removeSection(key);
    const created: THREE.Mesh[] = [];
    for (const layer of ['solid', 'cutout', 'translucent'] as Layer[]) {
      const buf = layers[layer];
      if (!buf) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(buf.uvs, 2));
      geom.setAttribute('color', new THREE.BufferAttribute(buf.colors, 4));
      geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
      geom.computeBoundingSphere();
      const m = new THREE.Mesh(geom, this.materials[layer]);
      m.position.set(transform.pos[0], transform.pos[1], transform.pos[2]);
      if (transform.axis) {
        const r = (transform.angleDeg * Math.PI) / 180;
        if (transform.axis === 'X') m.rotation.x = r;
        else if (transform.axis === 'Y') m.rotation.y = r;
        else m.rotation.z = r;
      }
      m.renderOrder = layer === 'translucent' ? 2 : layer === 'cutout' ? 1 : 0;
      this.scene.add(m);
      created.push(m);
    }
    this.meshes.set(key, created);
  }

  /**
   * Move an entity mesh already in the scene, without rebuilding it.
   *
   * `addEntityMesh` disposes and re-uploads every buffer, which is right once per roster
   * poll and ruinous once per frame. The isometric view needs the character it is
   * following to move at frame rate rather than in 1 Hz steps, and a transform is the only
   * thing that changes between those steps.
   */
  setEntityTransform(key: string, pos: readonly [number, number, number], angleDeg?: number) {
    const meshes = this.meshes.get(key);
    if (!meshes) return;
    for (const m of meshes) {
      m.position.set(pos[0], pos[1], pos[2]);
      if (angleDeg !== undefined) m.rotation.y = (angleDeg * Math.PI) / 180;
    }
  }

  /**
   * Cut the world off above `y`, or `null` to draw all of it.
   *
   * A global clipping plane rather than hiding sections: sections are 16 blocks tall, so
   * the coarsest honest cut they can express leaves up to 15 blocks of ceiling still on
   * top of the player. This clips per fragment, at exactly the height asked for, on the
   * GPU, and costs one plane test — and because it is set on the renderer rather than on
   * each material, it applies to terrain and entities alike with no bookkeeping.
   */
  setCutawayY(y: number | null) {
    if (y === null) {
      this.renderer.clippingPlanes = EMPTY_PLANES;
      return;
    }
    // Plane(normal, constant) keeps points where normal·p + constant >= 0. With normal
    // -Y that is `-p.y + y >= 0`, i.e. everything at or below `y` survives.
    this.cutPlane.constant = y;
    this.renderer.clippingPlanes = this.cutPlanes;
  }

  removeSection(key: string) {
    const existing = this.meshes.get(key);
    if (!existing) return;
    for (const m of existing) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.meshes.delete(key);
  }

  clear() {
    for (const key of [...this.meshes.keys()]) this.removeSection(key);
    this.quads = 0;
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): ViewerStats {
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const dt = performance.now() - t0;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const info = this.renderer.info.render;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return {
      sections: this.meshes.size,
      quads: this.quads,
      drawCalls: info.calls,
      triangles: info.triangles,
      fps: avg > 0 ? 1000 / avg : 0,
    };
  }

  /**
   * The same figures `render()` reports, without drawing. Used when the WebGPU shaderpack
   * path owns the screen: the scene graph is still the source of truth for section and
   * quad counts, but issuing a WebGL draw as well would burn a whole frame's GPU time
   * rendering an image nobody sees.
   */
  statsOnly(): ViewerStats {
    const info = this.renderer.info.render;
    return {
      sections: this.meshes.size,
      quads: this.quads,
      drawCalls: info.calls,
      triangles: info.triangles,
      fps: 0,
    };
  }

  dispose() {
    this.clear();
    this.texture?.dispose();
    this.renderer.dispose();
  }
}
