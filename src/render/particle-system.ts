/**
 * The particle simulation and its renderer.
 *
 * See `particles.ts` for what emits and why the emitter table is vanilla-only. This file is
 * the part that is generic: given emissions, it simulates and draws them.
 *
 * TWO THINGS ARE DELIBERATE AND BOTH ARE ABOUT NOT GROWING WITHOUT BOUND.
 *
 * **A hard ceiling, not a budget that can be exceeded.** Particles are the classic
 * unbounded-memory feature, and this viewer has already hit a renderer-process OOM once.
 * `MAX_PARTICLES` is a fixed-size pool allocated ONCE; when it is full, new particles are
 * dropped rather than queued, and the geometry never reallocates. A dropped particle is
 * invisible; an unbounded one takes the tab with it.
 *
 * **Sampling near the camera, exactly as the game does.** `ClientLevel.animateTick` does not
 * walk the world — it draws 667 random positions a tick within 16 blocks and another 667
 * within 32, and calls `animateTick` on whatever is there. So the cost is constant regardless
 * of how many emitters the world contains, and a block's emission rate falls out of how often
 * it happens to be sampled. Replicating that gives both properties for free, and it is why
 * 456 bubble columns cost the same as four.
 */

import * as THREE from 'three';
import type { SpriteRect, TextureAtlas } from './atlas.js';
import { emissionsFor, PARTICLES, type Emission } from './particles.js';

/**
 * The ceiling. 4,000 quads is 16,000 vertices rebuilt per frame — well inside what the CPU
 * can do in a millisecond — and about 1.1 MB of buffers, allocated once and never grown.
 */
export const MAX_PARTICLES = 4000;

/** Vanilla samples this many positions per tick, at each of two ranges. */
export const SAMPLES_PER_TICK = 667;
export const SAMPLE_RANGES: readonly number[] = [16, 32];

interface Live {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** ticks lived and ticks to live */
  age: number; life: number;
  size: number; gravity: number; drag: number;
  r: number; g: number; b: number;
  frames: readonly string[];
}

/** `origin + nextInt(range) - nextInt(range)`, vanilla's triangular sample. */
export function samplePos(origin: number, range: number, rnd: () => number): number {
  return origin + Math.floor(rnd() * range) - Math.floor(rnd() * range);
}

/** How many particles a full pool reports; used by the HUD and the tests. */
export interface ParticleStats {
  live: number;
  dropped: number;
}

export class ParticleSystem {
  private pool: Live[] = [];
  private count = 0;
  private mesh: THREE.Mesh;
  private positions: Float32Array;
  private uvs: Float32Array;
  private colours: Float32Array;
  private geom: THREE.BufferGeometry;
  readonly stats: ParticleStats = { live: 0, dropped: 0 };

  constructor(private scene: THREE.Scene, private atlas: TextureAtlas, texture: THREE.Texture) {
    this.positions = new Float32Array(MAX_PARTICLES * 4 * 3);
    this.uvs = new Float32Array(MAX_PARTICLES * 4 * 2);
    this.colours = new Float32Array(MAX_PARTICLES * 4 * 3);
    const indices = new Uint32Array(MAX_PARTICLES * 6);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const v = i * 4;
      indices.set([v, v + 1, v + 2, v + 2, v + 3, v], i * 6);
    }
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geom.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.colours, 3));
    this.geom.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geom.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geom, new THREE.MeshBasicMaterial({
      map: texture, transparent: true, alphaTest: 0.05, depthWrite: false,
      side: THREE.DoubleSide, fog: false, vertexColors: true,
    }));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * Add one particle, or drop it when the pool is full.
   *
   * Dropping is the whole safety property, so it is counted rather than silent: a `dropped`
   * that climbs says the ceiling is the thing limiting the effect.
   */
  spawn(e: Emission, bx: number, by: number, bz: number, rnd: () => number): boolean {
    if (this.count >= MAX_PARTICLES) {
      this.stats.dropped++;
      return false;
    }
    const spec = PARTICLES[e.kind];
    const j = e.jitter;
    const p = this.pool[this.count] ?? (this.pool[this.count] = blank());
    p.x = bx + e.at[0] + (rnd() - 0.5) * 2 * j;
    p.y = by + e.at[1] + (rnd() - 0.5) * 2 * j;
    p.z = bz + e.at[2] + (rnd() - 0.5) * 2 * j;
    // SmokeParticle spreads its start velocity by 0.1; the emission's own velocity is the
    // directed part on top of that.
    p.vx = e.vel[0] + (rnd() - 0.5) * 0.02;
    p.vy = e.vel[1] + (rnd() - 0.5) * 0.01;
    p.vz = e.vel[2] + (rnd() - 0.5) * 0.02;
    p.age = 0;
    // Vanilla scales a smoke particle's life by 1/(rand*0.8 + 0.2); the same shape keeps a
    // plume from dying all at once.
    p.life = Math.max(2, Math.round(spec.lifetime * (0.5 + rnd() * 0.8)));
    p.size = spec.size * (0.7 + rnd() * 0.6);
    p.gravity = spec.gravity;
    p.drag = spec.drag;
    p.frames = spec.frames;
    // BaseAshSmokeParticle: `rCol = gCol = bCol = nextFloat() * scale`. Jitter 1 reproduces
    // that; 0 keeps a type's colour exact, which is what the flame and bubble want.
    const k = 1 - spec.colourJitter * rnd();
    p.r = spec.colour[0] * k;
    p.g = spec.colour[1] * k;
    p.b = spec.colour[2] * k;
    this.count++;
    return true;
  }

  /** Emit for one sampled block, if it has an emitter and its gates pass. */
  sampleBlock(
    name: string, props: Record<string, string>,
    bx: number, by: number, bz: number, rnd: () => number,
  ): void {
    for (const e of emissionsFor(name, props)) {
      if (e.chance < 1 && rnd() >= e.chance) continue;
      this.spawn(e, bx, by, bz, rnd);
    }
  }

  /** Advance every particle one tick and retire the dead by swapping the tail down. */
  tick(): void {
    for (let i = 0; i < this.count; i++) {
      const p = this.pool[i];
      p.age++;
      if (p.age >= p.life) {
        this.pool[i] = this.pool[this.count - 1];
        this.pool[this.count - 1] = p;
        this.count--;
        i--;
        continue;
      }
      p.vy += p.gravity;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.vz *= p.drag;
      p.x += p.vx;
      p.y += p.vy;
      p.z += p.vz;
    }
    this.stats.live = this.count;
  }

  /** Rebuild the quads facing the camera. Called once a frame. */
  draw(camera: THREE.Camera): void {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.pool[i];
      const rect = this.atlas.get(frameOf(p));
      if (!rect) continue;
      const h = p.size / 2;
      const rx = right.x * h;
      const ry = right.y * h;
      const rz = right.z * h;
      const ux = up.x * h;
      const uy = up.y * h;
      const uz = up.z * h;
      const o = n * 12;
      // corners: -r-u, -r+u, +r+u, +r-u — the winding the shared index buffer expects
      this.writeCorner(o + 0, p.x - rx - ux, p.y - ry - uy, p.z - rz - uz);
      this.writeCorner(o + 3, p.x - rx + ux, p.y - ry + uy, p.z - rz + uz);
      this.writeCorner(o + 6, p.x + rx + ux, p.y + ry + uy, p.z + rz + uz);
      this.writeCorner(o + 9, p.x + rx - ux, p.y + ry - uy, p.z + rz - uz);
      writeUv(this.uvs, n * 8, rect);
      // Fade out over the last third of the life, so a plume thins instead of blinking off.
      const fade = Math.min(1, (1 - p.age / p.life) * 3);
      writeColour(this.colours, n * 12, p.r * fade, p.g * fade, p.b * fade);
      n++;
    }
    this.geom.setDrawRange(0, n * 6);
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private writeCorner(o: number, x: number, y: number, z: number): void {
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
  }

  /** Live count, for tests and the HUD. */
  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.stats.live = 0;
    this.geom.setDrawRange(0, 0);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Which animation frame a particle is showing, by how much of its life has run. */
export function frameOf(p: { age: number; life: number; frames: readonly string[] }): string {
  const n = p.frames.length;
  if (n === 1) return p.frames[0];
  const i = Math.min(n - 1, Math.floor((p.age / p.life) * n));
  return p.frames[i];
}

function writeUv(uvs: Float32Array, o: number, r: SpriteRect): void {
  uvs[o] = r.u0; uvs[o + 1] = r.v1;
  uvs[o + 2] = r.u0; uvs[o + 3] = r.v0;
  uvs[o + 4] = r.u1; uvs[o + 5] = r.v0;
  uvs[o + 6] = r.u1; uvs[o + 7] = r.v1;
}

function writeColour(a: Float32Array, o: number, r: number, g: number, b: number): void {
  for (let i = 0; i < 4; i++) {
    a[o + i * 3] = r;
    a[o + i * 3 + 1] = g;
    a[o + i * 3 + 2] = b;
  }
}

function blank(): Live {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1,
    size: 0.2, gravity: 0, drag: 1, r: 1, g: 1, b: 1, frames: [],
  };
}
