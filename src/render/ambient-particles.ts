/**
 * Driving the particle system from the world, at the game's own tick rate.
 *
 * Holds the three things the simulation itself should not know about: where the camera is,
 * what block is at a sampled position, and how much real time has passed. See
 * `particles.ts` for the emitter table and why it is vanilla-only, and
 * `particle-system.ts` for the pool and its ceiling.
 *
 * The sampling is vanilla's: 667 positions a tick at each of two ranges, drawn triangularly
 * around the camera. That is what makes the cost independent of how many emitters the world
 * holds — 456 bubble columns cost exactly what four do — and it is also what gives each block
 * its emission rate without anyone choosing one.
 *
 * Ticks are accumulated from real time rather than tied to the frame rate, so particles move
 * at the same speed at 30 fps and 140. More than a few ticks of backlog is dropped rather
 * than caught up: a tab that was in the background for a minute should not spawn a minute of
 * smoke in one frame.
 */

import * as THREE from 'three';
import { ParticleSystem, samplePos, SAMPLES_PER_TICK, SAMPLE_RANGES } from './particle-system.js';
import { isEmitter } from './particles.js';
import type { MeshContext } from './mesher.js';
import type { Viewer } from './viewer.js';

const TICK_MS = 50;
/** Never simulate more than this many ticks in one frame; see the header. */
const MAX_CATCHUP_TICKS = 4;

export interface AmbientDeps {
  viewer: Viewer;
  getContext: () => MeshContext | null;
}

export class AmbientParticles {
  private system: ParticleSystem | null = null;
  private carry = 0;
  private last = 0;

  constructor(private deps: AmbientDeps) {}

  /** Advance the simulation and redraw. `now` is `performance.now()`. */
  update(now: number): void {
    const ctx = this.deps.getContext();
    if (!ctx) return;
    const system = this.ensure(ctx);
    if (!system) return;
    if (!this.last) this.last = now;
    this.carry += now - this.last;
    this.last = now;
    let ticks = Math.floor(this.carry / TICK_MS);
    this.carry -= ticks * TICK_MS;
    if (ticks > MAX_CATCHUP_TICKS) ticks = MAX_CATCHUP_TICKS;
    const camera = this.deps.viewer.camera;
    for (let t = 0; t < ticks; t++) {
      this.sample(ctx, system, camera);
      system.tick();
    }
    system.draw(camera);
  }

  /**
   * One tick of vanilla's sampling.
   *
   * `Math.random` rather than a seeded source on purpose: vanilla seeds this per client and
   * nothing downstream depends on the sequence, so a shared generator would only add a
   * coupling for nothing.
   */
  private sample(ctx: MeshContext, system: ParticleSystem, camera: THREE.Camera): void {
    const ox = Math.floor(camera.position.x);
    const oy = Math.floor(camera.position.y);
    const oz = Math.floor(camera.position.z);
    const rnd = Math.random;
    for (let i = 0; i < SAMPLES_PER_TICK; i++) {
      for (const range of SAMPLE_RANGES) {
        const x = samplePos(ox, range, rnd);
        const y = samplePos(oy, range, rnd);
        const z = samplePos(oz, range, rnd);
        const id = ctx.world.getState(x, y, z);
        if (!id) continue; // air, the overwhelmingly common answer
        const key = ctx.world.palette[id];
        if (!key) continue;
        const name = key.split('[')[0];
        // The cheap gate first: almost nothing is an emitter, and parsing properties for
        // every sampled block would cost far more than the sampling itself.
        if (!isEmitter(name)) continue;
        system.sampleBlock(name, propsOf(key), x, y, z, rnd);
      }
    }
  }

  private ensure(ctx: MeshContext): ParticleSystem | null {
    if (this.system) return this.system;
    const canvas = (ctx.atlas as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (!canvas) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.system = new ParticleSystem(this.deps.viewer.scene, ctx.atlas, tex);
    return this.system;
  }

  hud(): string {
    const s = this.system?.stats;
    if (!s || !s.live) return '';
    return ` | ${s.live} particles` + (s.dropped ? ` (${s.dropped} dropped)` : '');
  }

  clear(): void {
    this.system?.clear();
  }
}

/** `minecraft:campfire[lit=true,...]` -> `{lit: 'true', ...}`. */
export function propsOf(stateKey: string): Record<string, string> {
  const i = stateKey.indexOf('[');
  if (i < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of stateKey.slice(i + 1, -1).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
