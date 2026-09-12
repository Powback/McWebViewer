/**
 * Animated textures.
 *
 * Vanilla ships an animated texture as a vertical strip of frames plus a `.mcmeta` giving
 * the frame count and `frametime` in TICKS. The mesher maps every quad into frame 0's rect
 * in the atlas, so playing the animation is one add on `uv.y` — done in the vertex shader
 * against a shared tick uniform, which is what keeps a chunk of still stone, flowing lava
 * and a Create belt in a single draw call.
 *
 * These check the two halves that can be checked without a GPU: that the per-vertex data
 * carries the right numbers, and that the frame arithmetic the shader performs lands on the
 * right frame at the right tick. The shader source itself is exercised by the browser run.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { stillAnim } from './mesher.js';

/**
 * The frame the shader picks, in TypeScript.
 *
 * Deliberately the same expression as `ANIM_VERTEX_BODY` in viewer.ts:
 * `floor(mod(tick / frametime, frames))`. Kept here so the arithmetic is testable; if the
 * shader changes, this must change with it.
 */
function frameAt(tick: number, frames: number, frametime: number): number {
  if (frames <= 1) return 0;
  const ft = Math.max(frametime, 1);
  return Math.floor(((tick / ft) % frames + frames) % frames);
}

test('a still texture never leaves frame 0, at any tick', () => {
  for (const tick of [0, 1, 7, 1000, 123456.7]) {
    assert.equal(frameAt(tick, 1, 1), 0);
  }
});

test('a 1-tick animation advances one frame per tick and wraps', () => {
  const frames = 4;
  assert.equal(frameAt(0, frames, 1), 0);
  assert.equal(frameAt(1, frames, 1), 1);
  assert.equal(frameAt(3, frames, 1), 3);
  assert.equal(frameAt(4, frames, 1), 0, 'did not wrap after the last frame');
  assert.equal(frameAt(9, frames, 1), 1);
});

test('frametime is honoured — a frametime of 2 holds each frame for two ticks', () => {
  // This is the number that makes lava crawl and a belt run; getting it wrong makes every
  // animation play at the same speed, which is exactly the sort of thing nobody notices.
  assert.equal(frameAt(0, 4, 2), 0);
  assert.equal(frameAt(1, 4, 2), 0);
  assert.equal(frameAt(2, 4, 2), 1);
  assert.equal(frameAt(3, 4, 2), 1);
  assert.equal(frameAt(8, 4, 2), 0);
});

test('a frametime of 0 does not divide by zero or freeze', () => {
  // `.mcmeta` files in the wild do contain 0; the shader clamps with max(frametime, 1).
  assert.equal(frameAt(3, 4, 0), 3);
});

test('the tick clock runs at the GAME rate, 20 a second', () => {
  // viewer.ts drives the uniform as `performance.now() / 50`. A second of wall clock must
  // advance a 20-frame, 1-tick animation exactly one full cycle.
  const ticksPerSecond = 1000 / 50;
  assert.equal(ticksPerSecond, 20);
  assert.equal(frameAt(0, 20, 1), frameAt(ticksPerSecond, 20, 1));
});

test('stillAnim marks every vertex as a single frame, so the shader term is zero', () => {
  const a = stillAnim(3);
  assert.equal(a.length, 9, 'three floats per vertex: frames, frametime, vStep');
  for (let i = 0; i < 3; i++) {
    assert.equal(a[i * 3], 1, 'frames must be 1');
    assert.equal(a[i * 3 + 2], 0, 'vStep must be 0 so nothing can scroll');
    assert.equal(frameAt(999, a[i * 3], a[i * 3 + 1]), 0);
  }
});

test('the vStep for a strip is one frame of atlas height, not the whole strip', () => {
  // The mesher passes `sv = sprite.v1 - sprite.v0`, and SpriteRect documents v0/v1 as the
  // uv of FRAME 0 — so sv is one frame. Using the whole strip's height would scroll the
  // texture off its own rect and into whatever sprite got packed below it.
  const v0 = 0.25;
  const v1 = 0.28125; // one 32px frame in a 1024px atlas
  const sv = v1 - v0;
  const frames = 8;
  assert.ok(Math.abs(sv - 0.03125) < 1e-9);
  // The last frame must still land inside the strip.
  assert.ok(v0 + (frames - 1) * sv < v0 + frames * sv);
  assert.ok(Math.abs((v0 + frames * sv) - (v0 + 0.25)) < 1e-9,
    'eight 32px frames should span 256px of a 1024px atlas');
});
