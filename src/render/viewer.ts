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

/**
 * How far, in blocks, a meshed section is still drawn. Beyond it sections are hidden and the
 * fog has closed anyway. Sections are only MESHED within main.ts's MESH_RADIUS (256); this
 * is a little wider so terrain meshed on the way somewhere does not pop out at the edge.
 */
export const RENDER_DISTANCE = 384;
/** Beyond this the section is disposed outright; re-meshing on return is ~1 ms. */
export const UNLOAD_DISTANCE = 640;
/** Half the diagonal of a 16-block section: the margin that keeps a partly-visible one drawn. */
const SECTION_HALF_DIAGONAL = 13.9;

/** The world-space centre of a section mesh keyed `cx,cy,cz`; null for entity meshes. */
export function sectionCentre(key: string): [number, number, number] | null {
  const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  return [Number(m[1]) * 16 + 8, Number(m[2]) * 16 + 8, Number(m[3]) * 16 + 8];
}

/** Whether any part of a section centred at `c` can lie within `radius` of `eye`. */
export function sectionWithin(
  c: readonly [number, number, number],
  eye: readonly [number, number, number],
  radius: number,
): boolean {
  const dx = c[0] - eye[0], dy = c[1] - eye[1], dz = c[2] - eye[2];
  const r = radius + SECTION_HALF_DIAGONAL;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export interface ViewerStats {
  sections: number;
  quads: number;
  drawCalls: number;
  triangles: number;
  fps: number;
}

/**
 * How wide the hole around the subject is, in BLOCKS at the subject's own distance.
 *
 * In blocks rather than pixels so the hole is the size of the character at every zoom
 * level — a fixed pixel radius would swallow half the map zoomed out and miss the
 * character's shoulders zoomed in. A player is 0.6 blocks wide and 1.8 tall, so an inner
 * radius of 1.1 around its centre clears the whole model, and the outer ring fades.
 */
const REVEAL_INNER_BLOCKS = 1.1;
const REVEAL_OUTER_BLOCKS = 2.2;
/**
 * How far IN FRONT of the subject a fragment has to be before it counts as an occluder.
 *
 * Not zero: the character's own mesh is drawn with these same materials and its front
 * faces sit a little nearer the camera than its centre. Half a block of body plus margin.
 */
const REVEAL_DEPTH_BIAS = 0.9;

/**
 * Screen-space reveal, injected into every material.
 *
 * A fragment is dropped only when it is BOTH inside a small disc around the subject's
 * screen position AND nearer to the camera than the subject is. Both halves are load
 * bearing and neither works alone: the disc alone would cut a hole through the floor the
 * character stands on, and the depth test alone would strip every wall in the foreground.
 *
 * `ign` is interleaved gradient noise — the dither used for this in real engines. It is a
 * function of `gl_FragCoord` alone, so the pattern is anchored to the SCREEN and stays put
 * while the world moves under it. A hash of world position sparkles instead, which is
 * exactly the "popping as the camera moves" this is meant to avoid.
 */
const REVEAL_FRAGMENT = /* glsl */`
  uniform vec4 mcwvReveal;        // xy screen px, z max view depth to cut, w on/off
  uniform vec2 mcwvRevealRadius;  // inner (gone), outer (kept)
  varying float mcwvViewZ;

  float mcwvIgn(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
`;

const REVEAL_FRAGMENT_BODY = /* glsl */`
  if (mcwvReveal.w > 0.5 && mcwvViewZ < mcwvReveal.z) {
    float keep = smoothstep(mcwvRevealRadius.x, mcwvRevealRadius.y,
                            distance(gl_FragCoord.xy, mcwvReveal.xy));
    if (mcwvIgn(gl_FragCoord.xy) > keep) discard;
  }
`;

/** Everything the reveal needs, in the units the shader reads them in. */
export interface SubjectReveal {
  /** subject's position on the screen, in DEVICE pixels */
  x: number;
  y: number;
  /** a fragment nearer than this view depth is an occluder; farther is not */
  cutViewZ: number;
  /** device-pixel radii: inside `inner` nothing survives, outside `outer` everything does */
  inner: number;
  outer: number;
}

/**
 * Where the subject is on screen, how deep it is, and how big its hole should be.
 *
 * Pulled out of `Viewer` because it is the whole of the model and it is arithmetic: a
 * WebGL context cannot be created in a test, but this can be checked against a real
 * `PerspectiveCamera` with no renderer at all. Returns null when there is nothing to
 * reveal — behind the camera, or on the camera's own plane.
 */
export function subjectReveal(
  camera: THREE.PerspectiveCamera,
  pos: readonly [number, number, number],
  width: number,
  height: number,
): SubjectReveal | null {
  // The subject's BODY, not its feet: the hole is centred on the model, and a hole centred
  // on the feet cuts the floor and leaves the head behind whatever is in front of it.
  const p = new THREE.Vector3(pos[0], pos[1] + 1, pos[2]);
  const viewZ = -p.clone().applyMatrix4(camera.matrixWorldInverse).z;
  if (!(viewZ > 0)) return null;
  const ndc = p.clone().project(camera);
  // Pixels per world unit AT THE SUBJECT'S DISTANCE, from the camera's own frustum — this
  // is what keeps the hole the size of the character at every zoom level.
  const perUnit = height / (2 * viewZ * Math.tan((camera.fov * Math.PI) / 360));
  return {
    x: (ndc.x * 0.5 + 0.5) * width,
    y: (ndc.y * 0.5 + 0.5) * height,
    cutViewZ: viewZ - REVEAL_DEPTH_BIAS,
    inner: REVEAL_INNER_BLOCKS * perUnit,
    outer: REVEAL_OUTER_BLOCKS * perUnit,
  };
}

/**
 * How much of a fragment survives the reveal, 0 (gone) to 1 (untouched).
 *
 * The same predicate the shader runs, in TypeScript, so the rule can be asserted against
 * concrete geometry rather than described in a comment. The shader adds one thing this
 * does not: a dither, which turns a fractional coverage into a per-pixel keep-or-discard.
 * Everything that decides WHETHER a fragment is a candidate at all lives here.
 */
export function revealCoverage(
  reveal: SubjectReveal | null,
  x: number,
  y: number,
  viewZ: number,
): number {
  if (!reveal) return 1;
  // Not in front of the subject: not an occluder, not this feature's business. This is the
  // half a cutaway height cannot express, and the reason a wall beside the player survives.
  if (viewZ >= reveal.cutViewZ) return 1;
  const d = Math.hypot(x - reveal.x, y - reveal.y);
  return smoothstep(reveal.inner, reveal.outer, d);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

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
   * The reveal's uniforms. ONE object per uniform, shared by all three materials, so a
   * per-frame update is two number writes rather than a shader recompile or a walk of the
   * scene graph. `w` is the on/off switch: the branch costs nothing when it is 0 and the
   * shader is identical either way, so first person and isometric run the same program.
   */
  private revealAt = { value: new THREE.Vector4(0, 0, 0, 0) };
  private revealRadius = { value: new THREE.Vector2(0, 0) };
  private reveal: SubjectReveal | null = null;
  private tmpSize = new THREE.Vector2();

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
    // The fog ends where the sections stop being drawn (RENDER_DISTANCE), so the cap is a
    // horizon rather than a cliff of missing terrain.
    this.scene.fog = new THREE.Fog(0x87ceeb, RENDER_DISTANCE * 0.6, RENDER_DISTANCE);
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
    for (const m of Object.values(this.materials)) this.patchReveal(m);
  }

  /**
   * Teach one material to drop the fragments that are between the camera and the subject.
   *
   * Done on the shared materials rather than per mesh, so terrain and entities alike get
   * it with no bookkeeping and no second draw. `onBeforeCompile` runs once per program;
   * the uniform OBJECTS are shared, so writing `.value` afterwards reaches every material
   * that was patched.
   */
  private patchReveal(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.mcwvReveal = this.revealAt;
      shader.uniforms.mcwvRevealRadius = this.revealRadius;
      shader.vertexShader = `varying float mcwvViewZ;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  mcwvViewZ = -mvPosition.z;',
      );
      shader.fragmentShader = `${REVEAL_FRAGMENT}\n${shader.fragmentShader}`.replace(
        'void main() {',
        `void main() {\n${REVEAL_FRAGMENT_BODY}`,
      );
    };
  }

  /**
   * Reveal a subject: hide only what is genuinely in the way of seeing it.
   *
   * REPLACES a global clipping plane at the player's head height, which was wrong in two
   * visible ways. It removed every block above that height ANYWHERE in the scene, so you
   * saw through walls that were never occluding anything and the world read as roofless
   * rather than cut open; and because the height tracked the player, every step up or down
   * moved the cut for the whole world at once, which on stairs and hillsides made distant
   * walls jump up and down. Both are inherent to cutting by height: a height has no idea
   * where the camera is.
   *
   * This asks the actual question instead — is this fragment between the camera and the
   * subject — so a wall beside the character is untouched no matter how tall it is, and
   * the player's Y changes nothing except where the small hole sits.
   *
   * `pos` is the subject's FEET; the hole is centred on its body. Null draws everything.
   */
  setSubject(pos: readonly [number, number, number] | null) {
    const size = this.renderer.getDrawingBufferSize(this.tmpSize);
    const r = pos ? subjectReveal(this.camera, pos, size.width, size.height) : null;
    this.reveal = r;
    if (!r) {
      this.revealAt.value.w = 0;
      return;
    }
    this.revealAt.value.set(r.x, r.y, r.cutViewZ, 1);
    this.revealRadius.value.set(r.inner, r.outer);
  }

  /** What the shader is currently doing, for the tests and the proof harness. */
  get subjectReveal(): SubjectReveal | null {
    return this.revealAt.value.w > 0.5 ? this.reveal : null;
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
   * View-distance culling, per frame. three.js already frustum-culls every section mesh
   * (`frustumCulled = true`, so anything behind or beside the camera costs nothing), but
   * a section meshed while the camera was near it stays in the scene after the camera has
   * flown 800 blocks away; over a long session every draw call ever made is still made.
   * Sections beyond RENDER_DISTANCE are hidden here — cheap, and reversible the moment
   * the camera turns back — and `dropSectionsBeyond` frees the ones far enough away that
   * re-meshing them on return is cheaper than keeping them.
   */
  cullByDistance(): { drawn: number; culled: number } {
    const cam = this.camera.position;
    let drawn = 0;
    let culled = 0;
    for (const [key, meshes] of this.meshes) {
      const c = sectionCentre(key);
      if (!c) continue; // an entity/turtle mesh: never distance-culled here
      const show = sectionWithin(c, [cam.x, cam.y, cam.z], RENDER_DISTANCE);
      for (const m of meshes) m.visible = show;
      if (show) drawn++;
      else culled++;
    }
    return { drawn, culled };
  }

  /** Dispose section meshes further than `radius` from the camera; returns how many went. */
  dropSectionsBeyond(radius: number): number {
    const cam = this.camera.position;
    const gone: string[] = [];
    for (const key of this.meshes.keys()) {
      const c = sectionCentre(key);
      if (c && !sectionWithin(c, [cam.x, cam.y, cam.z], radius)) gone.push(key);
    }
    for (const key of gone) this.removeSection(key);
    return gone.length;
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
