/**
 * Save-file entities, drawn live.
 *
 * Live mode used to see blocks, players and turtles — but not the save's own entities, so a
 * cow walking, a creeper wandering, a dropped egg or a falling sand block simply did not
 * move (or, for items, did not appear at all): they were read once at load and never again.
 * This closes that gap by re-reading the parallel `entities/r.X.Z.mca` regions on the same
 * flush signal the block sync uses, decoding each chunk's `Entities` list, and feeding the
 * result through a tracker tuned for the flush cadence (see entity-tracks.ts).
 *
 * Each kind is drawn the way it reads best in a map of a base:
 *
 *   model     mobs/animals/villagers with extracted Java geometry — the SAME mesh path the
 *             static viewer and live players use, one cached mesh per type, moved by a
 *             transform, facing its `Rotation` yaw;
 *   block     falling_block / block_display — their `BlockState` through the block mesher,
 *             centred on the entity like the turtle markers;
 *   item      dropped `minecraft:item`s — the item's baked icon on a bobbing billboard,
 *             occluded by terrain, expired the moment it stops being flushed;
 *   itemframe an item frame's held stack, as that same icon at the frame;
 *   label     a real entity whose Java geometry the extraction could not capture
 *             (e.g. friendsandfoes:crab) — a clean type-labelled billboard, never an
 *             invisible gap.
 *
 * Contraptions are left to the static path (they are big block sets meshed once, not per
 * frame), and the honestly-invisible entities (markers, glue anchors) draw nothing, as they
 * always have. This class NEVER blocks the /live socket: every read is HTTP off the region
 * files, on the flush signal, and a failed read is reported and skipped, not awaited.
 */

import * as THREE from 'three';
import type { Viewer } from '../render/viewer.js';
import type { MeshContext, StateSource } from '../render/mesher.js';
import { meshBlockSet, classifyEntity, type BlockSetMesh } from '../render/entities.js';
import {
  buildEntityQuads, buildPosedParts, poseQuads, entityYawDeg, meshEntityQuads,
  type EntityMesh, type EntityModelSet, type PosedPart,
} from '../render/entity-geometry.js';
import { MotionTracker, partRotation, NO_ROTATION } from '../render/entity-anim.js';
import type { ItemIcons } from '../render/item-icons.js';
import { NameTags } from '../render/name-tags.js';
import type { TrackPose } from './player-tracks.js';
import { EntityTracks, decodeEntities, type EntityPose, type EntitySample } from './entity-tracks.js';
import {
  DISPLAY_OFFSET, displayScale, spawnerDisplayOf, spinDegAt, tiltAndScale,
} from '../render/spawner-display.js';
import { sizeOf } from '../render/entity-sizes.js';
import { armPartOf, handOffset, heldItemPosition } from '../render/mob-held-item.js';
import { WorldItems } from '../render/world-items.js';
import { AmbientParticles } from '../render/ambient-particles.js';
import {
  frameAppearance, isFramedMap, itemRotationDeg, pitchMesh, ITEM_LIFT_FROM_BOARD,
  type FrameAppearance,
} from '../render/item-frames.js';
import { RegionWatcher, httpRangeFetch, regionCoords } from './region-sync.js';
import { RegionFile } from '../core/region.js';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type RenderKind = 'model' | 'block' | 'item' | 'itemframe' | 'label' | 'skip';

/** An item vanishes fast (it was picked up); a mob out of a loaded chunk is held longer. */
const ITEM_HOLD_MS = 700;
const MOB_HOLD_MS = 30000;
/** Item billboard: height in blocks, how high it floats, and the bob. */
const ITEM_SIZE = 0.55;
const ITEM_LIFT = 0.35;
/** A held item reads smaller than a dropped one — it is in a fist, not on the ground. */
const HELD_ITEM_SIZE = 0.4;
/** A framed item fills most of the frame's 10x10-pixel opening. */
const FRAMED_ITEM_SIZE = 0.5;
const ITEM_BOB = 0.11;
const ITEM_BOB_MS = 1400;
/** Fallback type-label billboard. */
const LABEL_SIZE = 0.55;
const LABEL_LIFT = 0.6;

/** Strategies whose entities LiveEntities deliberately draws nothing for. */
const SKIP_STRATEGIES = new Set(['contraption', 'invisible', 'unhandled']);
const ITEM_FRAMES = new Set(['minecraft:item_frame', 'minecraft:glow_item_frame']);

/** How each entity type is drawn — computed per sample because it depends on the extraction. */
function renderKind(type: string, hasBlock: boolean, models: EntityModelSet | null): RenderKind {
  if (type === 'minecraft:item') return 'item';
  if (ITEM_FRAMES.has(type)) return 'itemframe';
  const strat = classifyEntity(type, models ?? undefined);
  if (strat === 'extracted-model') return 'model';
  if (strat === 'block-model') return hasBlock ? 'block' : 'skip';
  if (SKIP_STRATEGIES.has(strat)) return 'skip';
  return 'label';
}

/** `friendsandfoes:copper_golem` -> `copper golem`. */
function shortName(type: string): string {
  return type.replace(/^[^:]*:/, '').replace(/_/g, ' ');
}

/** A stable per-uuid phase so a shelf of items does not bob in lockstep. */
function bobPhase(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) h = (h * 31 + uuid.charCodeAt(i)) & 0xffff;
  return (h / 0xffff) * Math.PI * 2;
}

function toTagPose(p: EntityPose): TrackPose {
  return { name: p.name ?? '', pos: p.pos, yawDeg: p.yawDeg, dimension: '', ageMs: 0, stale: p.stale };
}

// ---------------------------------------------------------------------------
// Billboards: camera-facing sprites for items, item frames and fallback labels.

interface Billboard {
  sprite: THREE.Sprite;
  key: string;
  aspect: number;
}

class Billboards {
  private sprites = new Map<string, Billboard>();
  private textures = new Map<string, THREE.Texture>();

  constructor(private scene: THREE.Scene) {}

  get size(): number {
    return this.sprites.size;
  }

  /** Ensure a sprite for `id` showing `canvas` (cached by `texKey`), at `pos`, `height` tall. */
  place(id: string, texKey: string, canvas: Canvas, pos: readonly [number, number, number], height: number): void {
    const tex = this.texture(texKey, canvas);
    const image = tex.image as { width: number; height: number };
    const aspect = image.height ? image.width / image.height : 1;
    let bb = this.sprites.get(id);
    if (!bb) {
      const material = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      bb = { sprite: new THREE.Sprite(material), key: texKey, aspect };
      this.scene.add(bb.sprite);
      this.sprites.set(id, bb);
    } else if (bb.key !== texKey) {
      (bb.sprite.material as THREE.SpriteMaterial).map = tex;
      bb.sprite.material.needsUpdate = true;
      bb.key = texKey;
      bb.aspect = aspect;
    }
    bb.sprite.position.set(pos[0], pos[1], pos[2]);
    bb.sprite.scale.set(height * bb.aspect, height, 1);
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

  /** Drop every sprite whose id is not in `alive`. */
  retain(alive: ReadonlySet<string>): void {
    for (const [id, bb] of this.sprites) {
      if (alive.has(id)) continue;
      this.scene.remove(bb.sprite);
      bb.sprite.material.dispose();
      this.sprites.delete(id);
    }
  }

  clear(): void {
    for (const bb of this.sprites.values()) {
      this.scene.remove(bb.sprite);
      bb.sprite.material.dispose();
    }
    this.sprites.clear();
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
  }
}

/** Paint a short label onto a card, sized so its aspect is stable. Cached by the Billboards. */
function labelCanvas(text: string): Canvas {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  const font = '600 26px ui-monospace, Menlo, monospace';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 20;
  canvas.width = w;
  canvas.height = 44;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.roundRect(0, 0, w, 44, 8);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#000';
  g.lineJoin = 'round';
  g.strokeText(text, w / 2, 22);
  g.fillStyle = '#fff';
  g.fillText(text, w / 2, 22);
  return canvas;
}

// ---------------------------------------------------------------------------
// Reading the entity regions off the HTTP mount.

/**
 * Keeps every watched `entities/` region's current per-chunk entity lists, seeded by a full
 * read and then kept current by the same header-range diff the block sync uses. Returns the
 * whole current roster each time, so the tracker sees departures as absences.
 */
class EntityRegions {
  private byChunk = new Map<string, EntitySample[]>();
  private watcher: RegionWatcher;

  constructor(private base: string, private names: readonly string[]) {
    this.watcher = new RegionWatcher(httpRangeFetch(base), names);
  }

  async prime(): Promise<EntitySample[]> {
    for (const name of this.names) await this.readFull(name);
    await this.watcher.prime();
    return this.all();
  }

  async poll(): Promise<EntitySample[]> {
    for (const c of await this.watcher.poll()) {
      this.byChunk.set(`${c.cx},${c.cz}`, decodeEntities(c.root));
    }
    return this.all();
  }

  private all(): EntitySample[] {
    const out: EntitySample[] = [];
    for (const list of this.byChunk.values()) for (const e of list) out.push(e);
    return out;
  }

  private async readFull(name: string): Promise<void> {
    const r = await fetch(`${this.base}/${encodeURIComponent(name)}`, { cache: 'no-store' })
      .catch(() => null);
    if (!r?.ok) return;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < 8192) return; // empty region file; nothing to read
    const [rx, rz] = regionCoords(name);
    const region = new RegionFile(buf, rx, rz);
    for (const e of region.entries()) this.readChunk(region, rx, rz, e.localX, e.localZ);
  }

  private readChunk(region: RegionFile, rx: number, rz: number, lx: number, lz: number): void {
    let root;
    try {
      root = region.chunk(lx, lz);
    } catch {
      return; // half-written, or stored externally as .mcc — the next flush re-reports it
    }
    if (root) this.byChunk.set(`${rx * 32 + lx},${rz * 32 + lz}`, decodeEntities(root));
  }
}

// ---------------------------------------------------------------------------

export interface LiveEntitiesDeps {
  viewer: Viewer;
  getContext: () => MeshContext | null;
  getStates: () => StateSource | null;
  getEntityModels: () => EntityModelSet | null;
  getIcons: () => ItemIcons | null;
  entityRegions: readonly string[];
  entityBase: string;
  status: (msg: string) => void;
}

export class LiveEntities {
  private regions: EntityRegions;
  private entityTracks = new EntityTracks({ holdMs: MOB_HOLD_MS });
  private itemTracks = new EntityTracks({ holdMs: ITEM_HOLD_MS });
  private meshDrawn = new Set<string>();
  private modelMeshes = new Map<string, EntityMesh | null>();
  /** part trees per type, so a pose can be rebuilt without re-baking any cube */
  private posedParts = new Map<string, PosedPart[] | null>();
  /** one motion tracker per entity, so the gait has a phase that survives bursty samples */
  private motion = new Map<string, MotionTracker>();
  /** the last pose drawn per entity, so an unchanged pose costs nothing */
  private posedMeshes = new Map<string, { key: string; mesh: EntityMesh }>();
  private blockMeshes = new Map<string, BlockSetMesh | null>();
  /** one tilted+scaled mesh per mob type shown in a spawner cage */
  private spawnerMeshes = new Map<string, EntityMesh | null>();
  /** one mesh per item-frame appearance (state plus baked pitch) */
  private frameMeshes = new Map<string, BlockSetMesh | null>();
  private billboards: Billboards;
  /** held items, which unlike dropped ones have a real orientation */
  private heldItems: WorldItems;
  /** ambient block particles — torch smoke, campfire plumes, bubbles, spores */
  private particles: AmbientParticles;
  private tags: NameTags;
  private tagsBroken = false;
  private started = false;

  readonly stats = { entities: 0, items: 0, stale: 0, spawners: 0, held: 0, frames: 0 };

  constructor(private deps: LiveEntitiesDeps) {
    this.regions = new EntityRegions(deps.entityBase, deps.entityRegions);
    this.billboards = new Billboards(deps.viewer.scene);
    this.heldItems = new WorldItems(deps.viewer.scene);
    this.particles = new AmbientParticles(deps);
    this.tags = new NameTags(deps.viewer.scene, undefined, 1.0);
  }

  /** Full read of every entity region, then draw the first frame's worth. */
  async start(): Promise<void> {
    try {
      this.ingest(await this.regions.prime());
      this.started = true;
    } catch (e) {
      this.deps.status(`live entities: initial read failed — ${(e as Error).message}`);
    }
  }

  /** The server flushed: re-read the changed entity chunks. */
  async onReload(): Promise<void> {
    if (!this.started) return;
    try {
      this.ingest(await this.regions.poll());
    } catch (e) {
      this.deps.status(`live entities: refresh failed — ${(e as Error).message}`);
    }
  }

  /**
   * Feed a roster that did NOT come from the region files.
   *
   * The spacetime source (a real protocol client mirroring the server into SpacetimeDB)
   * produces exactly the same `EntitySample`s at packet rate instead of at flush rate. It
   * enters here so that everything downstream — interpolation, meshes, billboards, name
   * tags — is the identical code in both modes. Swapping the source must not fork the
   * renderer, or only one of the two paths stays correct.
   */
  ingestExternal(roster: EntitySample[]): void {
    this.started = true;
    this.ingest(roster);
  }

  private ingest(roster: EntitySample[]): void {
    const now = performance.now();
    const models = this.deps.getEntityModels();
    const items: EntitySample[] = [];
    const others: EntitySample[] = [];
    for (const s of roster) {
      const kind = renderKind(s.type, s.block !== null, models);
      if (kind === 'skip') continue;
      (kind === 'item' ? items : others).push(s);
    }
    this.itemTracks.ingest(items, now);
    this.entityTracks.ingest(others, now);
  }

  /** One frame: interpolate, draw, label. Called every frame from LiveView. */
  update(): void {
    if (!this.started) return;
    const now = performance.now();
    const models = this.deps.getEntityModels();
    const entPoses = this.entityTracks.poses(now);
    const itemPoses = this.itemTracks.poses(now);
    const aliveMesh = new Set<string>();
    const aliveSprite = new Set<string>();
    // Oriented world items have their own retain set: framed stacks and held stacks both
    // live in `heldItems`, and sweeping one against the other's set deletes it the same
    // frame it is placed.
    const aliveHeld = new Set<string>();
    const named: EntityPose[] = [];
    this.stats.frames = 0;
    for (const p of entPoses) this.drawEntity(p, models, aliveMesh, aliveSprite, aliveHeld, named);
    for (const p of itemPoses) this.drawItem(p, `save:${p.uuid}`, now, aliveSprite);
    this.stats.spawners = this.drawSpawnerMobs(models, now, aliveMesh);
    this.stats.held = 0;
    for (const p of entPoses) this.stats.held += this.drawHeldItems(p, models, aliveHeld);
    this.heldItems.retain(aliveHeld);
    this.retainMeshes(aliveMesh);
    this.billboards.retain(aliveSprite);
    this.updateTags(named);
    this.particles.update(now);
    this.stats.entities = entPoses.length;
    this.stats.items = itemPoses.length;
    this.stats.stale = entPoses.filter((p) => p.stale).length;
  }

  private drawEntity(
    p: EntityPose,
    models: EntityModelSet | null,
    aliveMesh: Set<string>,
    aliveSprite: Set<string>,
    aliveHeld: Set<string>,
    named: EntityPose[],
  ): void {
    const key = `save:${p.uuid}`;
    const kind = renderKind(p.type, p.block !== null, models);
    if (kind === 'model' && this.drawModel(key, p, models)) {
      aliveMesh.add(key);
      if (p.name) named.push(p);
    } else if (kind === 'block' && p.block && this.drawBlock(key, p)) {
      aliveMesh.add(key);
      if (p.name) named.push(p);
    } else if (kind === 'itemframe') {
      this.drawItemFrame(p, key, aliveMesh, aliveHeld);
    } else {
      this.billboards.place(key, `label:${p.type}`, labelCanvas(shortName(p.type)),
        [p.pos[0], p.pos[1] + LABEL_LIFT, p.pos[2]], LABEL_SIZE);
      aliveSprite.add(key);
    }
  }

  private drawModel(key: string, p: EntityPose, models: EntityModelSet | null): boolean {
    const mesh = this.animatedMesh(key, p, models) ?? this.modelMesh(p, models);
    if (!mesh) return false;
    this.placeMesh(key, mesh.layers, p.pos, entityYawDeg(p.yawDeg));
    return true;
  }

  /**
   * A mesh posed for THIS entity's current gait, or null to fall back to the shared rest
   * pose.
   *
   * Per-entity rather than per-type, because two cows are rarely mid-stride together — but
   * the pose is QUANTISED and the mesh cached against it, so a mob that is standing still
   * (by far the common case) rebuilds nothing and a walking one rebuilds only when its limbs
   * have actually moved a visible amount. A mob whose model has no animatable part is left
   * on the shared mesh entirely.
   */
  private animatedMesh(
    key: string, p: EntityPose, models: EntityModelSet | null,
  ): EntityMesh | null {
    const parts = this.partsFor(p, models);
    if (!parts) return null;
    let tracker = this.motion.get(key);
    if (!tracker) { tracker = new MotionTracker(); this.motion.set(key, tracker); }
    const now = performance.now();
    tracker.update(p.pos, now);
    const state = tracker.state(now / 1000, 0, 0);
    // Nothing to draw differently: a still mob IS its rest pose, so share it.
    if (state.speed < 0.05) return null;

    const rots = new Map<string, { x: number; y: number; z: number }>();
    const poseKey = this.poseKeyFor(parts, state, rots);
    const cached = this.posedMeshes.get(key);
    if (cached && cached.key === poseKey) return cached.mesh;

    const ctx = this.deps.getContext();
    if (!ctx) return null;
    const quads = poseQuads(parts, (part) => rots.get(part.name) ?? NO_ROTATION);
    const mesh = meshEntityQuads(quads, ctx.atlas);
    if (!mesh.quadCount) return null;
    this.posedMeshes.set(key, { key: poseKey, mesh });
    // The geometry changed, not just the transform, so it has to be re-added.
    this.meshDrawn.delete(key);
    return mesh;
  }

  /**
   * The quantised pose, as a string, and the rotations that produced it.
   *
   * Quantising is what keeps this affordable: without it every frame is a new pose and every
   * frame rebuilds the mesh. A twentieth of a radian is well under what the eye resolves on a
   * limb at any distance you can see one.
   */
  private poseKeyFor(
    parts: readonly PosedPart[],
    state: ReturnType<MotionTracker['state']>,
    into: Map<string, { x: number; y: number; z: number }>,
  ): string {
    const bits: string[] = [];
    const walk = (list: readonly PosedPart[]): void => {
      for (const part of list) {
        const r = partRotation(part.role, state);
        into.set(part.name, r);
        if (part.role !== 'static') {
          bits.push(`${part.name}:${q(r.x)},${q(r.y)},${q(r.z)}`);
        }
        if (part.children.length) walk(part.children);
      }
    };
    walk(parts);
    return bits.join('|');
  }

  /** The part tree for a type, baked once. */
  private partsFor(p: EntityPose, models: EntityModelSet | null): PosedPart[] | null {
    const cacheKey = p.appearance.key || p.type;
    const hit = this.posedParts.get(cacheKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    if (!ctx || !models) return null; // not ready — retry next frame, do not cache
    const parts = buildPosedParts(models, p.type, ctx.atlas, p.appearance);
    // A model with nothing to animate is cached as null so it never costs anything again.
    const usable = parts && parts.some(hasAnimatable) ? parts : null;
    this.posedParts.set(cacheKey, usable);
    return usable;
  }

  private drawBlock(key: string, p: EntityPose): boolean {
    const mesh = this.blockMesh(p.block!);
    if (!mesh) return false;
    this.placeMesh(key, mesh.layers, p.pos, 0);
    return true;
  }

  /**
   * What a mob is carrying, at its hand.
   *
   * Measured: 30 of this world's 801 entities hold something — 23 bows, 4 golden swords,
   * 3 crossbows, all in the main hand. It rides the billboard path dropped items already
   * use, because the item atlas is canvas-backed rather than part of the block atlas, and
   * because a camera-facing sprite is the honest choice while the bake carries no
   * `thirdperson_righthand` transform to orient it by. See render/mob-held-item.ts.
   */
  private drawHeldItems(
    p: EntityPose, models: EntityModelSet | null, aliveHeld: Set<string>,
  ): number {
    const held = p.held;
    if (!held.length || !models) return 0;
    const geom = models.geometryFor(p.type);
    if (!geom) return 0;
    let drawn = 0;
    const icons = this.deps.getIcons();
    const yaw = entityYawDeg(p.yawDeg);
    for (const item of held) {
      const hand = item.slot === 0 ? 'right' : 'left';
      // The item model's own held transform, from its `display` block — applied in full,
      // rotation included, because a held item is real oriented geometry rather than a
      // camera-facing sprite. `item/handheld` rolls a sword 55 degrees, and that roll is the
      // difference between a sword in a fist and a sword lying flat in mid-air.
      const t = icons?.transformFor(item.id, hand === 'left'
        ? 'thirdperson_lefthand' : 'thirdperson_righthand');
      const offset = handOffset(armPartOf(geom.model.parts, hand), hand, t?.translation);
      if (!offset) continue; // a model with no arm holds nothing, as vanilla does
      const icon = icons?.get(item.id) ?? null;
      if (!icon) continue;
      const key = `held:${p.uuid}:${item.slot}`;
      this.heldItems.place(key, `item:${item.id}`, icon,
        heldItemPosition(p.pos, yaw, offset), HELD_ITEM_SIZE * (t?.scale[0] ?? 1),
        yaw, t?.rotation ?? [0, 0, 0]);
      aliveHeld.add(key);
      drawn++;
    }
    return drawn;
  }

  /**
   * An item frame: its BLOCK model, plus the stack it holds standing off the board.
   *
   * The frame has no `EntityModel` and never needed one — vanilla draws it with
   * `renderSingleBlock` on `block/item_frame`, which is a model this renderer already bakes.
   * See render/item-frames.ts for the orientation and for what this world does and does not
   * contain.
   */
  private drawItemFrame(
    p: EntityPose, key: string, aliveMesh: Set<string>, aliveHeld: Set<string>,
  ): void {
    const look = frameAppearance(p.facing ?? 3, isFramedMap(p.item?.id), p.type.includes('glow'));
    const mesh = this.frameMesh(look);
    if (mesh) {
      this.placeMesh(key, mesh.layers, p.pos, look.yawDeg);
      aliveMesh.add(key);
      this.stats.frames++;
    }
    if (!p.item) return;
    // The stack, lifted just clear of the backing board so it does not z-fight it, and
    // turned by the frame's own `ItemRotation`. Drawn through the oriented world-item path
    // rather than the sprite one: a framed item faces the way the frame does.
    const icons = this.deps.getIcons();
    const icon = icons?.get(p.item.id) ?? null;
    if (!icon) return;
    const pos = heldItemPosition(p.pos, look.yawDeg, [0, 0, ITEM_LIFT_FROM_BOARD]);
    this.heldItems.place(`${key}:item`, `item:${p.item.id}`, icon, pos, FRAMED_ITEM_SIZE,
      look.yawDeg, [look.pitchDeg, 0, itemRotationDeg(p.rotation)]);
    aliveHeld.add(`${key}:item`);
  }

  /** One mesh per frame appearance — every south-facing frame shares it. */
  private frameMesh(look: FrameAppearance): BlockSetMesh | null {
    const cacheKey = `${look.stateKey}|${look.pitchDeg}`;
    const hit = this.frameMeshes.get(cacheKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    const states = this.deps.getStates();
    if (!ctx || !states) return null; // not ready — retry next frame, do not cache
    // Centred on the origin so the entity position means the frame's centre, as it does in
    // the save: a frame at TileZ 120 sits at z 120.03, a thirty-second of a block proud.
    const mesh = meshBlockSet([{ x: -0.5, y: -0.5, z: -0.5, stateKey: look.stateKey }], states, ctx.atlas);
    const usable = mesh.quadCount ? pitchMesh(mesh, look.pitchDeg) : null;
    this.frameMeshes.set(cacheKey, usable);
    return usable;
  }

  /** Draw one item / item-frame stack as its baked icon, bobbing when `bobMs` is non-zero. */
  private drawItem(p: EntityPose, key: string, bobMs: number, aliveSprite: Set<string>): void {
    if (!p.item) return;
    const icons = this.deps.getIcons();
    const icon = icons?.get(p.item.id) ?? null;
    const canvas = icon ?? labelCanvas(shortName(p.item.id));
    const texKey = icon ? `item:${p.item.id}` : `label:item:${p.item.id}`;
    const bob = bobMs ? ITEM_BOB * Math.sin((bobMs / ITEM_BOB_MS) + bobPhase(p.uuid)) : 0;
    this.billboards.place(key, texKey, canvas,
      [p.pos[0], p.pos[1] + ITEM_LIFT + bob, p.pos[2]], ITEM_SIZE);
    aliveSprite.add(key);
  }

  /**
   * The mob turning inside every spawner cage in the loaded world.
   *
   * It rides this loop rather than the section mesher because it TURNS: the geometry is
   * constant per mob type and only the placement angle changes, so one mesh per type is
   * shared by every cage showing that mob and each cage costs one transform a frame. See
   * render/spawner-display.ts for the transform, which is vanilla's disassembled.
   */
  private drawSpawnerMobs(
    models: EntityModelSet | null, now: number, alive: Set<string>,
  ): number {
    const ctx = this.deps.getContext();
    if (!ctx || !models) return 0;
    let drawn = 0;
    for (const col of ctx.world.chunks.values()) {
      for (const be of col.blockEntities.values()) {
        const d = spawnerDisplayOf(be as Record<string, unknown>);
        if (!d) continue;
        const mesh = this.spawnerMesh(d.type, models, ctx);
        if (!mesh) continue;
        const key = `spawner:${d.x},${d.y},${d.z}`;
        this.placeMesh(key, mesh.layers, [
          d.x + DISPLAY_OFFSET[0], d.y + DISPLAY_OFFSET[1], d.z + DISPLAY_OFFSET[2],
        ], spinDegAt(d, now));
        alive.add(key);
        drawn++;
      }
    }
    return drawn;
  }

  /** One tilted, scaled mesh per mob type — every cage showing a skeleton shares it. */
  private spawnerMesh(
    type: string, models: EntityModelSet, ctx: MeshContext,
  ): EntityMesh | null {
    const hit = this.spawnerMeshes.get(type);
    if (hit !== undefined) return hit;
    const quads = buildEntityQuads(models, type, ctx.atlas);
    const scaled = quads ? tiltAndScale(quads, displayScale(sizeOf(type))) : null;
    const mesh = scaled ? meshEntityQuads(scaled, ctx.atlas) : null;
    const usable = mesh && mesh.quadCount ? mesh : null;
    this.spawnerMeshes.set(type, usable);
    return usable;
  }

  private placeMesh(key: string, layers: EntityMesh['layers'], pos: readonly [number, number, number], yaw: number): void {
    if (this.meshDrawn.has(key)) {
      this.deps.viewer.setEntityTransform(key, pos, yaw);
    } else {
      this.deps.viewer.addEntityMesh(key, layers, {
        pos: [pos[0], pos[1], pos[2]], angleDeg: yaw, axis: 'Y',
      });
      this.meshDrawn.add(key);
    }
  }

  /** Per-type mesh from the extraction, built once against the current atlas. */
  private modelMesh(p: EntityPose, models: EntityModelSet | null): EntityMesh | null {
    // Keyed by APPEARANCE, not by type: a white sheep and a black one are the same model
    // and must not share a mesh. `appearance.key` is '' for a mob with nothing special
    // about it, so the ordinary case still meshes once for the whole world.
    const cacheKey = p.appearance.key || p.type;
    const hit = this.modelMeshes.get(cacheKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    if (!ctx || !models) return null; // not ready — retry next frame, do not cache
    const quads = buildEntityQuads(models, p.type, ctx.atlas, p.appearance);
    const mesh = quads ? meshEntityQuads(quads, ctx.atlas) : null;
    const usable = mesh && mesh.quadCount ? mesh : null;
    this.modelMeshes.set(cacheKey, usable);
    return usable;
  }

  /** Per-state block mesh, centred on the entity like the turtle markers. */
  private blockMesh(stateKey: string): BlockSetMesh | null {
    const hit = this.blockMeshes.get(stateKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    const states = this.deps.getStates();
    if (!ctx || !states) return null;
    const mesh = meshBlockSet([{ x: -0.5, y: 0, z: -0.5, stateKey }], states, ctx.atlas);
    const usable = mesh.quadCount ? mesh : null;
    this.blockMeshes.set(stateKey, usable);
    return usable;
  }

  private retainMeshes(alive: ReadonlySet<string>): void {
    for (const key of this.meshDrawn) {
      if (alive.has(key)) continue;
      this.deps.viewer.removeSection(key);
      this.meshDrawn.delete(key);
    }
  }

  private updateTags(named: readonly EntityPose[]): void {
    if (this.tagsBroken) return;
    try {
      this.tags.update(named.map(toTagPose), this.deps.viewer.camera);
    } catch (e) {
      this.tagsBroken = true;
      this.tags.clear();
      this.deps.status(`live entities: name tags OFF — ${(e as Error).message}`);
    }
  }

  /**
   * A fresh bake was adopted in place: every mesh and sprite was built against the old
   * atlas, whose sprite rects have moved. Drop them all and let the next frame rebuild from
   * the trackers, whose positions are unaffected.
   */
  invalidate(): void {
    for (const key of this.meshDrawn) this.deps.viewer.removeSection(key);
    this.meshDrawn.clear();
    this.modelMeshes.clear();
    this.spawnerMeshes.clear();
    this.frameMeshes.clear();
    this.posedParts.clear();
    this.posedMeshes.clear();
    this.motion.clear();
    this.blockMeshes.clear();
    this.billboards.clear();
    this.heldItems.clear();
    this.particles.clear();
    this.tags.clear();
  }

  hudLine(): string {
    const s = this.stats;
    if (!s.entities && !s.items) return '';
    return ` | ${s.entities} entities, ${s.items} items live`
      + (s.stale ? ` (${s.stale} STALE)` : '')
      + (s.spawners ? ` | ${s.spawners} spawner mobs` : '')
      + (s.held ? ` | ${s.held} held` : '')
      + (s.frames ? ` | ${s.frames} frames` : '')
      + (this.particles.hud());
  }
}

/** A twentieth of a radian — below what the eye resolves on a limb. */
function q(v: number): number {
  return Math.round(v * 20);
}

/** Does this part, or any of its descendants, animate at all? */
function hasAnimatable(part: PosedPart): boolean {
  return part.role !== 'static' || part.children.some(hasAnimatable);
}
