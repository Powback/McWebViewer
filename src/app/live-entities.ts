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
  buildEntityQuads, entityYawDeg, meshEntityQuads,
  type EntityMesh, type EntityModelSet,
} from '../render/entity-geometry.js';
import type { ItemIcons } from '../render/item-icons.js';
import { NameTags } from '../render/name-tags.js';
import type { TrackPose } from './player-tracks.js';
import { EntityTracks, decodeEntities, type EntityPose, type EntitySample } from './entity-tracks.js';
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
  private blockMeshes = new Map<string, BlockSetMesh | null>();
  private billboards: Billboards;
  private tags: NameTags;
  private tagsBroken = false;
  private started = false;

  readonly stats = { entities: 0, items: 0, stale: 0 };

  constructor(private deps: LiveEntitiesDeps) {
    this.regions = new EntityRegions(deps.entityBase, deps.entityRegions);
    this.billboards = new Billboards(deps.viewer.scene);
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
    const named: EntityPose[] = [];
    for (const p of entPoses) this.drawEntity(p, models, aliveMesh, aliveSprite, named);
    for (const p of itemPoses) this.drawItem(p, `save:${p.uuid}`, now, aliveSprite);
    this.retainMeshes(aliveMesh);
    this.billboards.retain(aliveSprite);
    this.updateTags(named);
    this.stats.entities = entPoses.length;
    this.stats.items = itemPoses.length;
    this.stats.stale = entPoses.filter((p) => p.stale).length;
  }

  private drawEntity(
    p: EntityPose,
    models: EntityModelSet | null,
    aliveMesh: Set<string>,
    aliveSprite: Set<string>,
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
    } else if (kind === 'itemframe' && p.item) {
      this.drawItem(p, key, 0, aliveSprite);
    } else {
      this.billboards.place(key, `label:${p.type}`, labelCanvas(shortName(p.type)),
        [p.pos[0], p.pos[1] + LABEL_LIFT, p.pos[2]], LABEL_SIZE);
      aliveSprite.add(key);
    }
  }

  private drawModel(key: string, p: EntityPose, models: EntityModelSet | null): boolean {
    const mesh = this.modelMesh(p.type, models);
    if (!mesh) return false;
    this.placeMesh(key, mesh.layers, p.pos, entityYawDeg(p.yawDeg));
    return true;
  }

  private drawBlock(key: string, p: EntityPose): boolean {
    const mesh = this.blockMesh(p.block!);
    if (!mesh) return false;
    this.placeMesh(key, mesh.layers, p.pos, 0);
    return true;
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
  private modelMesh(type: string, models: EntityModelSet | null): EntityMesh | null {
    const hit = this.modelMeshes.get(type);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    if (!ctx || !models) return null; // not ready — retry next frame, do not cache
    const quads = buildEntityQuads(models, type, ctx.atlas);
    const mesh = quads ? meshEntityQuads(quads, ctx.atlas) : null;
    const usable = mesh && mesh.quadCount ? mesh : null;
    this.modelMeshes.set(type, usable);
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
    this.blockMeshes.clear();
    this.billboards.clear();
    this.tags.clear();
  }

  hudLine(): string {
    const s = this.stats;
    if (!s.entities && !s.items) return '';
    return ` | ${s.entities} entities, ${s.items} items live`
      + (s.stale ? ` (${s.stale} STALE)` : '');
  }
}
