/**
 * The mob turning inside a spawner cage.
 *
 * A spawner's block model is the cage and nothing else; the mob inside it is drawn by
 * `SpawnerRenderer` from the block entity's `SpawnData`. With no renderer for it, all 47 of
 * this world's spawners were empty boxes — 32 `minecraft:mob_spawner` (12 skeleton, 10
 * zombie, 8 cave spider, 2 spider) and 15 `minecraft:trial_spawner` (9 bogged, 3 breeze,
 * 2 husk, 1 cave spider). Every one of them names a mob, so every one gains something.
 *
 * THE TRANSFORM IS READ OUT OF THE CLIENT, NOT REMEMBERED. `SpawnerRenderer.
 * renderEntityInSpawner` disassembles to exactly:
 *
 *     translate(0.5, 0.4, 0.5)
 *     mulPose(YP.rotationDegrees(lerp(partialTick, oSpin, spin) * 10))
 *     translate(0, -0.2, 0)
 *     mulPose(XP.rotationDegrees(-30))
 *     scale(s, s, s)          s = 0.53125, divided by max(bbWidth, bbHeight) if that > 1
 *
 * and `TrialSpawnerRenderer` calls the same method, so both cages behave identically.
 *
 * Two consequences worth stating. The Y rotation is the only part that changes per frame, so
 * the tilt and the scale are baked into the mesh ONCE per mob type and the spin is just the
 * placement angle — 47 cages cost 47 transform updates a frame, not 47 meshes. And because a
 * Y rotation leaves Y alone, the two translates collapse: the mob sits at
 * (0.5, 0.2, 0.5) within its block.
 *
 * THE SPIN RATE IS VANILLA'S, WITH ONE HONEST APPROXIMATION. `BaseSpawner.serverTick` does
 * `spin = (spin + 1000 / (spawnDelay + 200)) % 360` each tick and the renderer multiplies by
 * 10, so the rate depends on the spawner's countdown — which runs down and resets to a fresh
 * random value continuously. We do not simulate the countdown, so each cage turns at the
 * rate its OWN saved `Delay` implies and then keeps it. Cages therefore turn at slightly
 * different, plausible speeds rather than in lockstep, but a given cage does not speed up and
 * slow down the way the real one does.
 */

import type { BakedQuad } from '../assets/model.js';

export interface SpawnerDisplay {
  /** the entity type the cage shows */
  type: string;
  x: number;
  y: number;
  z: number;
  /** how fast this cage turns, degrees per second */
  degPerSec: number;
}

/** `0.53125` is vanilla's constant; see the header. */
const BASE_SCALE = 0.53125;
/** The cage's mob sits here within the block, after the two translates collapse. */
export const DISPLAY_OFFSET: readonly [number, number, number] = [0.5, 0.2, 0.5];
/** Vanilla tilts the mob back so you see its face rather than its scalp. */
export const DISPLAY_TILT_DEG = -30;

const num = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * The mob a spawner block entity displays, or null.
 *
 * Handles both spellings because the two block entities disagree: `mob_spawner` writes
 * `SpawnData`, `trial_spawner` writes `spawn_data`, and both nest the id under `entity.id`.
 * A spawner with no spawn data shows nothing in vanilla either, so null is correct there.
 */
export function spawnerDisplayOf(be: Record<string, unknown>): SpawnerDisplay | null {
  const data = (be.SpawnData ?? be.spawn_data) as Record<string, unknown> | undefined;
  const entity = data?.entity as Record<string, unknown> | undefined;
  const type = typeof entity?.id === 'string' ? entity.id : null;
  const x = num(be.x);
  const y = num(be.y);
  const z = num(be.z);
  if (!type || x === null || y === null || z === null) return null;
  return { type, x, y, z, degPerSec: spinRate(num(be.Delay) ?? 0) };
}

/**
 * Degrees per second, from vanilla's formula and this spawner's own saved delay.
 *
 * `1000 / (spawnDelay + 200)` degrees a tick, times the renderer's 10, times 20 ticks a
 * second. A delay of 0 — a spawner about to fire — gives the fastest turn, which is what the
 * real one does at that moment too.
 */
export function spinRate(spawnDelay: number): number {
  const safe = Math.max(0, spawnDelay);
  return (1000 / (safe + 200)) * 10 * 20;
}

/** Where this cage's mob has turned to at `nowMs`. */
export function spinDegAt(d: SpawnerDisplay, nowMs: number): number {
  return (nowMs / 1000) * d.degPerSec % 360;
}

/**
 * Vanilla's scale for a display mob.
 *
 * A mob larger than one block in either direction is shrunk to fit; anything smaller is left
 * at the base scale rather than being enlarged. Measured sizes: a skeleton is 0.6 x 1.99 and
 * scales to 0.267, while a cave spider is 0.7 x 0.5 and stays at 0.53125.
 */
export function displayScale(size: { w: number; h: number } | null | undefined): number {
  if (!size) return BASE_SCALE;
  const max = Math.max(size.w, size.h);
  return max > 1 ? BASE_SCALE / max : BASE_SCALE;
}

/**
 * Bake the constant half of the transform into a mob's quads: scale, then tilt about X.
 *
 * Vanilla's `PoseStack` post-multiplies, so `mulPose(Rx)` followed by `scale(s)` means a
 * point is scaled FIRST and then rotated. Doing it in the other order would tilt about the
 * wrong centre and lift the mob out of its cage.
 */
export function tiltAndScale(quads: readonly BakedQuad[], scale: number): BakedQuad[] {
  const a = (DISPLAY_TILT_DEG * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return quads.map((q) => {
    const positions = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      const x = q.positions[i * 3] * scale;
      const y = q.positions[i * 3 + 1] * scale;
      const z = q.positions[i * 3 + 2] * scale;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y * c - z * s;
      positions[i * 3 + 2] = y * s + z * c;
    }
    const [nx, ny, nz] = q.normal;
    return {
      ...q,
      positions,
      normal: [nx, ny * c - nz * s, ny * s + nz * c] as [number, number, number],
    };
  });
}
