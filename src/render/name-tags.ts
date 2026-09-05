/**
 * Who that Steve is.
 *
 * Every live player is drawn with the same bind-pose model and the same default skin (see
 * player-model.ts for why no skin is fetched), so without a label a fleet of drones is a
 * crowd of identical figures and the viewer cannot answer the first question anyone asks
 * of it: which one is that. The label is the presence.
 *
 * Built from a canvas texture on a `THREE.Sprite`, which costs no new dependency — sprites
 * and canvas textures are both three core. Two properties are deliberate:
 *
 *  - `depthTest: false`. A name tag behind a hill still tells you where its owner is, and
 *    that is the whole point of watching a server from above. Vanilla hides tags behind
 *    walls because it is a first-person game; this is a map.
 *  - the scale grows with distance past `TAG_FULL_SIZE_M`, so the label never falls below
 *    the on-screen size it has at that distance. A plain world-space sprite is unreadable
 *    at a hundred blocks, which is exactly where you most need to know who is who.
 *
 * A STALE pose — one the tracker is holding because samples stopped arriving — is drawn
 * amber and marked. That is not decoration: a player drawn at a stale position looks
 * exactly like a player standing still, and the two are the difference between "he is
 * afk" and "the bridge is broken".
 */

import * as THREE from 'three';
import type { TrackPose } from '../app/player-tracks.js';

/** World height of the label at TAG_FULL_SIZE_M and closer, in blocks. */
const TAG_HEIGHT = 0.45;
/** Past this distance the label stops shrinking on screen. */
const TAG_FULL_SIZE_M = 24;
/** A player is 1.8 blocks tall; the tag floats just clear of the head. */
const TAG_LIFT = 2.15;
/** Canvas text metrics. Kept at a fixed height so every tag shares an aspect formula. */
const FONT_PX = 44;
const CANVAS_H = 72;
const PAD_PX = 14;
/** Drawn over everything, including the translucent layer (renderOrder 2). */
const TAG_RENDER_ORDER = 10;

const STALE_TINT = 0xffb347;

/**
 * How tall the sprite must be, in world units, to hold its apparent size.
 *
 * Below `full` the label is anchored to the world and grows as you approach, like the
 * player it names. Past it the size is pinned to the screen instead. Split out and
 * exported because it is the whole of the "readable at distance AND up close" claim and it
 * is arithmetic — no WebGL context can exist in a test, but this can be asserted directly.
 */
export function tagScale(distance: number, full = TAG_FULL_SIZE_M): number {
  return TAG_HEIGHT * Math.max(1, distance / full);
}

/**
 * A stable colour per player, so the same drone is the same colour every session.
 *
 * FNV-1a over the name rather than an index into the roster: roster order changes whenever
 * somebody logs in, and a marker whose colour moves between players is worse than no
 * colour at all. Fixed saturation and lightness keep every result legible on the dark
 * label background.
 */
export function nameColor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hsl(${h % 360}, 85%, 62%)`;
}

interface Tag {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  aspect: number;
}

export class NameTags {
  private tags = new Map<string, Tag>();

  constructor(
    private scene: THREE.Scene,
    /** Injected so the geometry can be exercised without a DOM. */
    private makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
    /** How far above `pos` the label floats: a player is 1.8 blocks tall, a turtle is one. */
    private lift: number = TAG_LIFT,
  ) {}

  /**
   * Reconcile the labels with the poses being drawn this frame.
   *
   * Takes the whole set rather than one at a time so that a player who is no longer in it
   * loses their label in the SAME frame their model is removed. A label outliving its owner
   * by even one frame is a name floating over empty ground.
   */
  update(poses: readonly TrackPose[], camera: THREE.Camera): void {
    const alive = new Set<string>();
    for (const pose of poses) {
      alive.add(pose.name);
      const tag = this.tags.get(pose.name) ?? this.create(pose.name);
      this.place(tag, pose, camera);
    }
    for (const name of [...this.tags.keys()]) {
      if (!alive.has(name)) this.remove(name);
    }
  }

  private place(tag: Tag, pose: TrackPose, camera: THREE.Camera): void {
    const x = pose.pos[0];
    const y = pose.pos[1] + this.lift;
    const z = pose.pos[2];
    tag.sprite.position.set(x, y, z);
    const d = camera.position.distanceTo(tag.sprite.position);
    const h = tagScale(d);
    tag.sprite.scale.set(h * tag.aspect, h, 1);
    // The tint IS the staleness indicator; the text itself is white so it multiplies clean.
    tag.material.color.setHex(pose.stale ? STALE_TINT : 0xffffff);
    tag.material.opacity = pose.stale ? 0.75 : 1;
  }

  private create(name: string): Tag {
    const canvas = this.makeCanvas();
    const aspect = drawTag(canvas, name);
    const texture = new THREE.CanvasTexture(canvas);
    // Stated explicitly because the block atlas sets the OPPOSITE (viewer.ts) and the
    // difference is not obvious: the atlas derives its own UVs in canvas coordinates and so
    // must not be flipped, whereas a sprite uses three's default quad UVs, which assume the
    // flip. Copying `flipY = false` across from the atlas draws every name upside down.
    texture.flipY = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = TAG_RENDER_ORDER;
    this.scene.add(sprite);
    const tag: Tag = { sprite, texture, material, aspect };
    this.tags.set(name, tag);
    return tag;
  }

  private remove(name: string): void {
    const tag = this.tags.get(name);
    if (!tag) return;
    this.scene.remove(tag.sprite);
    tag.texture.dispose();
    tag.material.dispose();
    this.tags.delete(name);
  }

  clear(): void {
    for (const name of [...this.tags.keys()]) this.remove(name);
  }

  get count(): number {
    return this.tags.size;
  }
}

/**
 * Paint one label and return its aspect ratio.
 *
 * The outline is drawn as a stroke UNDER the fill rather than as four offset copies: it has
 * to survive being scaled down to a few pixels tall, and at that size an offset shadow
 * turns into a smear on one side while a stroke stays a halo.
 */
function drawTag(canvas: HTMLCanvasElement, name: string): number {
  const ctx = canvas.getContext('2d');
  // No 2D context is a real failure, not a reason to draw a blank label that looks like a
  // player with no name. Let it bubble: live-view has somewhere to report it.
  if (!ctx) throw new Error(`no 2d context for the name tag of ${name}`);
  const font = `700 ${FONT_PX}px ui-monospace, Menlo, monospace`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + PAD_PX * 2;
  canvas.width = w;
  canvas.height = CANVAS_H;
  // Resizing the canvas resets the context, so everything below has to be set again.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, CANVAS_H - 8, 10);
  ctx.fill();
  // The per-player colour, as a bar under the name: a coloured NAME would fight the stale
  // tint, which needs white text to multiply against.
  ctx.fillStyle = nameColor(name);
  ctx.fillRect(PAD_PX, CANVAS_H - 8, w - PAD_PX * 2, 6);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.strokeText(name, w / 2, (CANVAS_H - 8) / 2);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, w / 2, (CANVAS_H - 8) / 2);
  return w / CANVAS_H;
}
