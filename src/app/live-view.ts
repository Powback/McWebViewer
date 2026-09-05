/**
 * The live tier, assembled.
 *
 * Ties the three pieces together and owns nothing else:
 *
 *   ObserverClient  the bridge socket — player positions, and "the server just flushed"
 *   RegionWatcher   which chunks changed on disk since the last flush
 *   Viewer          the same renderer the static path uses, re-meshing only what moved
 *
 * The re-mesh is drained on a per-frame time budget rather than done in the socket
 * callback, for the same reason the initial load is: a turtle stepping across a chunk
 * boundary can invalidate a dozen sections, and doing all of them between two frames is a
 * visible hitch.
 *
 * Players are drawn as one cached bind-pose mesh per session, moved every FRAME from
 * `PlayerTracks` rather than once per roster poll. They do not animate — there is no
 * `setupAnim` here any more than there is for mobs — so a walking player slides rather
 * than strides. Stated, not hidden.
 */

import { meshSection, type MeshContext } from '../render/mesher.js';
import type { Viewer } from '../render/viewer.js';
import type { ChunkColumn, World } from '../render/world.js';
import { meshBlockSet, type BlockSetMesh } from '../render/entities.js';
import {
  ComputerRegistry, changedSections, headingYawDeg, turtleIdOf, turtleKey,
} from './computer-registry.js';
import {
  buildEntityQuads, entityYawDeg, meshEntityQuads, type EntityMesh, type EntityModelSet,
} from '../render/entity-geometry.js';
import { PLAYER_TYPE } from '../render/player-model.js';
import {
  RegionWatcher, diffSections, httpRangeFetch, invalidatedSections,
} from './region-sync.js';
import {
  ObserverClient, describeControl, describeFlush,
  type ControlState, type LiveComputer, type LivePlayer, type SelfSample,
} from './live.js';
import { LiveControls } from './live-controls.js';
import { IsoView, type CameraMode } from './iso-view.js';
import { navWorld } from './nav-world.js';
import { TouchPad } from './touch-pad.js';
import { PlayHud, type Stack, type Vitals } from './play-hud.js';
import { loadItemIcons, type ItemIcons } from '../render/item-icons.js';
import { PlayerTracks, type RosterEntry, type TrackPose } from './player-tracks.js';
import { NameTags } from '../render/name-tags.js';
import { followPlacement, nextFollowed } from './follow-camera.js';

/** Regions are the overworld's; a player in the nether is tracked but not drawn. */
const DRAWN_DIMENSION = 'minecraft:overworld';
/** A turtle is one block tall; its label floats just clear of it. */
const TURTLE_TAG_LIFT = 1.35;

/**
 * How far ahead of the last sample the camera may dead-reckon, in seconds.
 *
 * Sized at roughly two poll intervals: long enough to bridge a dropped sample, short
 * enough that a stalled bridge stops the camera rather than sending it through a wall.
 */
const MAX_EXTRAPOLATE_S = 0.25;
/** How fast the smoothed position converges on the predicted one. */
const CONVERGE_RATE = 18;

export interface LiveViewDeps {
  world: World;
  viewer: Viewer;
  getContext: () => MeshContext | null;
  getEntityModels: () => EntityModelSet | null;
  regions: readonly string[];
  /** URL prefix the region files are served from, e.g. `/dev/region` */
  regionBase: string;
  /** URL prefix the bake is served from, for the item atlas */
  bakedBase: string;
  /** block atlas + state source, needed to composite block-item icons */
  getAtlas: () => import('../render/atlas.js').TextureAtlas | null;
  getStates: () => import('../render/mesher.js').StateSource | null;
  hudRoot: HTMLElement;
  status: (msg: string) => void;
  /**
   * The ordinary fly camera. Follow needs to SEED its yaw and pitch rather than call
   * `camera.lookAt`, because FlyControls rewrites the camera rotation from its own angles
   * every frame and would undo it before it was ever drawn.
   */
  fly?: { lookAt: (x: number, y: number, z: number) => void };
}

export class LiveView {
  readonly client: ObserverClient;
  readonly controls: LiveControls;
  readonly iso: IsoView;
  readonly pad: TouchPad;
  readonly hud: PlayHud;
  private watcher: RegionWatcher;
  /**
   * Which camera owns the screen. First person is the default because it is what "join a
   * server and play" means; the isometric view is a mode you ask for, from a button.
   */
  private mode: CameraMode = 'first';
  /** The scene key of the character being driven, while it is being drawn. */
  private selfKey: string | null = null;
  private selfYawDeg = 0;
  private icons: ItemIcons | null = null;
  private typing = false;
  private dirty = new Set<string>();
  private playerMesh: EntityMesh | null | undefined;
  private drawn = new Set<string>();
  private syncing = false;

  /** 1 Hz samples in, per-frame poses out. See player-tracks.ts. */
  private tracks = new PlayerTracks(DRAWN_DIMENSION);
  private tags: NameTags;
  /** Latched when a label throws, so one broken canvas cannot stop the frame loop forever. */
  private tagsBroken = false;
  /** The poses drawn this frame, kept so follow and the HUD read the same numbers. */
  private lastPoses: TrackPose[] = [];
  /** The last set of unreadable dimensions reported, so it is said once and not every poll. */
  private reportedUnknownDim = '';
  private following: string | null = null;
  /** Where the followed player was last frame; the camera moves by the difference. */
  private followAnchor: [number, number, number] | null = null;

  // --- turtles, live -----------------------------------------------------------------
  /** What the save files know about each computer id: kind, label, saved block, facing. */
  private computers = new ComputerRegistry();
  /** The players' tracker, but a turtle that leaves the dump is HELD, not dropped. */
  private turtleTracks = new PlayerTracks(DRAWN_DIMENSION, { holdLost: true });
  private turtleTags: NameTags;
  /** Last live block and heading per id — the dump has no facing, so it comes from motion. */
  private liveHeading = new Map<number, { pos: readonly [number, number, number]; yaw: number }>();
  /** One mesh per turtle block state, built about the block's bottom centre; null = not in the bake. */
  private turtleMeshes = new Map<string, BlockSetMesh | null>();
  private turtlesDrawn = new Set<string>();
  private lastTurtlePoses: TrackPose[] = [];
  /** Region-drawn turtle blocks hidden because their computer has a live track; see mesher.ts. */
  private hidden: ReadonlyMap<string, ReadonlySet<number>> = new Map();

  /** Counters the HUD reports, so "it is connected" and "it is working" stay separable. */
  readonly stats = { chunksChanged: 0, sectionsRemeshed: 0, syncMs: 0, players: 0, computers: 0 };

  private lastSample: { pos: [number, number, number]; t: number } | null = null;
  private velocity: [number, number, number] = [0, 0, 0];
  private smoothed: [number, number, number] | null = null;

  constructor(url: string, private deps: LiveViewDeps) {
    this.watcher = new RegionWatcher(httpRangeFetch(deps.regionBase), deps.regions);
    this.tags = new NameTags(deps.viewer.scene);
    this.turtleTags = new NameTags(deps.viewer.scene, undefined, TURTLE_TAG_LIFT);
    this.client = new ObserverClient(url, {
      status: deps.status,
      onPlayers: (list) => this.onPlayers(list),
      onComputers: (list) => this.onComputers(list),
      onReload: () => void this.sync(),
      onControl: (c) => this.onControl(c),
      onSelf: (s) => this.onSelf(s),
      onVitals: (v) => this.hud.setVitals(v as unknown as Vitals),
      onInventory: (stacks) => this.hud.setInventory(stacks as Stack[]),
      onBlock: (b) => this.onBlock(b),
      onChat: (m) => this.hud.addChat(m),
    });
    this.hud = new PlayHud({
      root: deps.hudRoot,
      icons: () => this.icons,
      onSelectSlot: (slot) => this.client.send({ t: 'hotbar', slot }),
      onChat: (message) => this.client.send({ t: 'say', message }),
      onTypingChange: (t) => {
        this.typing = t;
        if (t) this.controls.releaseAll();
      },
    });
    this.controls = new LiveControls({
      viewer: deps.viewer,
      world: deps.world,
      send: (msg) => this.client.send(msg),
      isTyping: () => this.typing,
      onInventory: () => this.hud.toggleInventory(),
      onChat: () => this.hud.openChat(),
      onUseBlock: (pos) => this.client.send({ t: 'openBlock', x: pos[0], y: pos[1], z: pos[2] }),
    });
    this.iso = new IsoView({
      canvas: deps.viewer.renderer.domElement,
      camera: deps.viewer.camera,
      world: deps.world,
      // The same chunks the renderer holds, asked what a walking body needs to know. The
      // planner is CLIENT-SIDE for exactly this reason: the data is already here.
      nav: navWorld(deps.world),
      send: (msg) => this.client.send(msg),
      setSubject: (pos) => deps.viewer.setSubject(pos),
    });
    // The pad drives the SAME entry points the mouse and keyboard drive, so a phone and a
    // desktop cannot drift apart in what they are able to do.
    this.pad = new TouchPad({
      root: deps.hudRoot,
      onDig: (down) => this.controls.touchDig(down),
      onUse: () => this.controls.touchUse(),
      onJump: () => this.controls.touchJump(),
      onInventory: () => this.hud.toggleInventory(),
    });
  }

  // -------------------------------------------------------------------------
  // Camera mode

  get cameraMode(): CameraMode {
    return this.mode;
  }

  toggleCameraMode(): CameraMode {
    this.setCameraMode(this.mode === 'iso' ? 'first' : 'iso');
    return this.mode;
  }

  /**
   * Switch camera modes.
   *
   * The two input paths are mutually exclusive on purpose: first person binds mouselook,
   * WASD and a dig on the left button, and the isometric view binds a drag that pans and a
   * tap that walks. Leaving both bound would make a tap on the ground both a destination
   * and a dig, and a pan both a camera move and a turn.
   */
  setCameraMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Whatever the old mode had the character doing, it is not doing any more.
    this.controls.releaseAll();
    this.pad.release();
    this.applyInputMode();
  }

  /** Bind exactly the one input path the current mode and control state call for. */
  private applyInputMode(): void {
    const joined = this.client.control?.joined === true;
    if (!joined) {
      this.controls.unbind();
      this.iso.unbind();
      this.pad.setVisible(false);
      return;
    }
    if (this.mode === 'iso') {
      this.controls.unbind();
      this.iso.bind();
    } else {
      this.iso.unbind();
      this.controls.bind();
    }
    this.pad.setVisible(true);
    // The crosshair is what MINE and PLACE aim with, and only first person aims that way;
    // the isometric view aims by tapping the ground.
    this.pad.setCrosshair(this.mode === 'first');
  }

  /**
   * A container's contents, read from the block. Only shown when the block actually has an
   * inventory — right-clicking a door must not pop an empty chest panel.
   */
  private onBlock(raw: unknown): void {
    const b = raw as { id?: string; items?: Stack[] | null; pos?: [number, number, number] };
    if (!b || !Array.isArray(b.items)) return;
    this.hud.setContainer({ id: b.id ?? null, items: b.items, pos: b.pos ?? [0, 0, 0] });
  }

  /**
   * Bind or unbind the browser's controls to match what the server can actually honour.
   *
   * This is the only place controls are ever bound. A server without the fake-player mod
   * leaves them unbound, so the page behaves as a viewer and the HUD says why — rather
   * than accepting WASD and quietly dropping it, which is what the previous version did.
   */
  private onControl(control: ControlState): void {
    this.applyInputMode();
    this.hud.setVisible(control.joined === true);
    // Taking control takes the camera. A follow lock left running would fight the driven
    // camera for the same position every frame.
    if (control.joined) this.stopFollow('follow released: you are driving now');
    if (!control.joined) {
      this.smoothed = null;
      this.selfKey = null;
    }
    this.onControlChange?.(control);
  }

  /**
   * Position samples, and the prediction that hides the gap between them.
   *
   * Samples arrive at ~10 Hz and the frame loop runs at 60+. Without prediction the camera
   * steps; with naive smoothing it lags by a whole sample. So each sample also yields a
   * VELOCITY, and between samples the camera dead-reckons along it — then converges back
   * onto the next real sample rather than trusting the extrapolation. Extrapolation is
   * capped: when samples stop arriving the camera must coast to a halt, not fly off.
   */
  private onSelf(sample: SelfSample): void {
    const prev = this.lastSample;
    this.lastSample = { pos: sample.pos, t: performance.now() };
    if (prev) {
      const dt = (this.lastSample.t - prev.t) / 1000;
      if (dt > 0.001) {
        for (let i = 0; i < 3; i++) {
          this.velocity[i] = (sample.pos[i] - prev.pos[i]) / dt;
        }
      }
    }
    if (!this.smoothed) this.smoothed = [...sample.pos] as [number, number, number];
    this.controls.setBotPose(sample.pos);
  }

  /** Set by the app so the Join button can re-render whenever the state moves. */
  onControlChange: ((control: ControlState) => void) | null = null;

  join(): void {
    this.client.join();
  }

  leave(): void {
    this.client.leave();
  }

  /** The item atlas is fetched only here, so `?auto=1` never pays for it. */
  async loadIcons(): Promise<void> {
    const atlas = this.deps.getAtlas();
    const states = this.deps.getStates();
    if (!atlas || !states) return;
    this.icons = await loadItemIcons(this.deps.bakedBase, atlas, states).catch(() => null);
    if (!this.icons) this.deps.status('live: no item icons baked — run npm run bake-assets');
  }

  async start(): Promise<void> {
    // Prime BEFORE connecting: a flush landing between the initial full region load and
    // the first header read would otherwise be folded into the baseline and never seen.
    await this.watcher.prime();
    await this.loadIcons();
    // What the save files already say about every computer — labels, kinds, saved blocks —
    // BEFORE the first dump arrives, so the first turtle drawn has its name.
    for (const col of this.deps.world.chunks.values()) this.absorbComputers(col);
    this.client.connect();
  }

  // -------------------------------------------------------------------------
  // Block changes

  private async sync(): Promise<void> {
    // A flush faster than a sync takes must not stack two syncs on the same files.
    if (this.syncing) return;
    this.syncing = true;
    const t0 = performance.now();
    try {
      const changed = await this.watcher.poll();
      this.stats.chunksChanged = changed.length;
      for (const c of changed) this.ingest(c.cx, c.cz, c.root);
    } finally {
      this.syncing = false;
      this.stats.syncMs = performance.now() - t0;
    }
  }

  /**
   * Replace one chunk column and mark only the sections whose blocks actually differ.
   *
   * `world.addChunk` builds a fresh column and swaps it into the map, leaving the old
   * object intact — which is what makes the before/after comparison possible at all.
   */
  private ingest(cx: number, cz: number, root: Parameters<World['addChunk']>[0]): void {
    const before = this.deps.world.getChunk(cx, cz);
    const after = this.deps.world.addChunk(root);
    // The re-read chunk may have moved a turtle's SAVED block: the old one must un-hide
    // and the new one hide, or the region draws a turtle where it no longer is.
    this.absorbComputers(after);
    for (const y of diffSections(before, after)) {
      for (const key of invalidatedSections(cx, y, cz)) this.dirty.add(key);
    }
  }

  /** Re-mesh changed sections on a frame budget, nearest first is not worth the sort. */
  pump(budgetMs = 6): void {
    const ctx = this.deps.getContext();
    if (!ctx || !this.dirty.size) return;
    const deadline = performance.now() + budgetMs;
    for (const key of this.dirty) {
      if (performance.now() > deadline) break;
      this.dirty.delete(key);
      const [cx, cy, cz] = key.split(',').map(Number);
      // A section only exists in the scene if it has geometry; one that just became all
      // air must be removed, not left as the last mesh that happened to work.
      const mesh = this.deps.world.getChunk(cx, cz) ? meshSection(ctx, cx, cy, cz) : null;
      if (mesh) this.deps.viewer.addSection(mesh);
      else this.deps.viewer.removeSection(key);
      this.stats.sectionsRemeshed++;
    }
  }

  get pending(): number {
    return this.dirty.size;
  }

  /**
   * The atlas was replaced — a fresh bake was adopted in place — so every mesh built
   * against the old one now samples the wrong texels: sprite rects move between bakes.
   * Drop the cached player model and forget which players are drawn; the next frame
   * rebuilds both from the new context. The dirty set goes too, because the caller is
   * re-meshing the entire scene and a partial re-mesh on top of that is wasted work.
   */
  invalidateMeshes(): void {
    this.playerMesh = undefined;
    this.drawn.clear();
    this.dirty.clear();
    this.turtleMeshes.clear();
    this.turtlesDrawn.clear();
  }

  // -------------------------------------------------------------------------
  // Turtles, live

  /**
   * A `computercraft dump` arrived: every loaded computer and the block it occupies.
   *
   * Stationary computers are already drawn by the region and never move, so they are only
   * counted. Turtles — and any id the save files have not described yet, which is what a
   * turtle that has moved into a chunk we have not re-read looks like — go to the tracker
   * and are drawn from there. The dump has no facing, so heading comes from motion: a
   * turtle moves along one axis at a time and its last horizontal step is the way it faces.
   * A turtle that has not moved since the page loaded faces the way its saved block does.
   *
   * The dump has no dimension either. Every computer is assumed to be in the dimension this
   * viewer shows; a turtle in the nether would be drawn at its nether coordinates here. The
   * reference fleet is entirely overworld, and this is stated rather than papered over.
   */
  private onComputers(list: LiveComputer[]): void {
    this.stats.computers = list.length;
    const roster: RosterEntry[] = [];
    for (const c of list) {
      if (this.computers.kindOf(c.id) === 'computer') continue;
      const prev = this.liveHeading.get(c.id);
      const yaw = headingYawDeg(prev?.pos, c.pos)
        ?? prev?.yaw
        ?? this.computers.get(c.id)?.facingYawDeg
        ?? 0;
      this.liveHeading.set(c.id, { pos: c.pos, yaw });
      roster.push({ name: turtleKey(c.id), pos: c.pos, yawDeg: yaw, dimension: DRAWN_DIMENSION });
    }
    this.turtleTracks.ingest(roster, performance.now());
    this.refreshHidden();
  }

  /** One frame of turtles: interpolate, draw, label. Called from `updatePlayers`. */
  private updateTurtles(): void {
    const ctx = this.deps.getContext();
    // The context is replaced when a fresh bake is adopted; the hidden set must follow it.
    if (ctx && ctx.hidden !== this.hidden) ctx.hidden = this.hidden;
    const poses = this.turtleTracks.poses(performance.now());
    this.lastTurtlePoses = poses;
    this.drawTurtles(poses);
    this.labelWith(
      this.turtleTags,
      poses.map((p) => ({ ...p, name: this.computers.labelFor(turtleIdOf(p.name)) })),
    );
  }

  private drawTurtles(poses: readonly TrackPose[]): void {
    const alive = new Set<string>();
    for (const pose of poses) {
      const id = turtleIdOf(pose.name);
      const key = `turtle:${id}`;
      alive.add(key);
      const mesh = this.turtleMesh(this.computers.markerState(id));
      if (!mesh) continue;
      // The mesh is built about the block's bottom centre, so the heading turns the turtle
      // on its own axis; the position is therefore the centre of the block it occupies.
      const pos: [number, number, number] = [pose.pos[0] + 0.5, pose.pos[1], pose.pos[2] + 0.5];
      if (this.turtlesDrawn.has(key)) {
        this.deps.viewer.setEntityTransform(key, pos, pose.yawDeg);
      } else {
        this.deps.viewer.addEntityMesh(key, mesh.layers, { pos, angleDeg: pose.yawDeg, axis: 'Y' });
        this.turtlesDrawn.add(key);
      }
    }
    for (const key of this.turtlesDrawn) {
      if (alive.has(key)) continue;
      this.deps.viewer.removeSection(key);
      this.turtlesDrawn.delete(key);
    }
  }

  /**
   * The turtle's own block model, meshed once per state about (−0.5, 0, −0.5) and reused for
   * every turtle of that kind. Null when the bake has no model for it — the label is still
   * drawn, and the NOT IN BAKE count on the HUD says why the body is missing.
   */
  private turtleMesh(stateKey: string): BlockSetMesh | null {
    const hit = this.turtleMeshes.get(stateKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    const states = this.deps.getStates();
    if (!ctx || !states) return null; // not ready; not cached, so it is retried next frame
    const mesh = meshBlockSet([{ x: -0.5, y: 0, z: -0.5, stateKey }], states, ctx.atlas);
    const usable = mesh.quadCount ? mesh : null;
    if (!usable) {
      this.deps.status(`live: no model for ${stateKey} in the bake — that turtle is a label until it is re-baked`);
    }
    this.turtleMeshes.set(stateKey, usable);
    return usable;
  }

  /** Read a column's computer block entities; a changed record re-plans what is hidden. */
  private absorbComputers(col: ChunkColumn): void {
    const w = this.deps.world;
    const changed = this.computers.absorb(col, (x, y, z) => w.palette[w.getState(x, y, z)]);
    if (changed.length) this.refreshHidden();
  }

  /**
   * Hide the region-drawn block of every turtle that has a live track, so each turtle is on
   * screen once — where the bridge says it is — and not also where the last flush left it.
   * Only the sections whose hidden set changed are re-meshed (with their neighbours, for
   * the face culling that reads across section boundaries).
   */
  private refreshHidden(): void {
    const next = this.computers.hiddenBlocks(this.turtleTracks.names().map(turtleIdOf));
    for (const key of changedSections(this.hidden, next)) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (const k of invalidatedSections(cx, cy, cz)) this.dirty.add(k);
    }
    this.hidden = next;
  }

  private turtleLine(): string {
    const t = this.client.turtles;
    if (t && t.available === false) return ' | turtles: unavailable';
    const poses = this.lastTurtlePoses;
    if (!this.stats.computers && !poses.length) return '';
    const stale = poses.filter((p) => p.stale).length;
    return ` | ${poses.length} turtles live of ${this.stats.computers} computers`
      + (stale ? ` (${stale} STALE)` : '');
  }

  // -------------------------------------------------------------------------
  // Players

  /**
   * A roster poll arrived. NOTHING IS DRAWN HERE.
   *
   * This used to transform every player's mesh straight from the poll, which is a player
   * that jumps once a second and stands still in between — and, because `addEntityMesh`
   * disposes and re-uploads every buffer, it also re-uploaded the whole player model per
   * player per second for the privilege. The poll now only feeds the tracker; the drawing
   * happens per frame in `updatePlayers`.
   */
  private onPlayers(list: LivePlayer[]): void {
    this.stats.players = list.length;
    this.followBot(list);
    this.tracks.ingest(
      list.map((p) => ({
        name: p.name,
        pos: p.pos,
        yawDeg: entityYawDeg(p.yaw),
        dimension: p.dimension,
      })),
      performance.now(),
    );
    this.reportUnreadableDimensions();
  }

  /**
   * Say which players are being withheld, and why.
   *
   * A player whose `Dimension` read failed is NOT drawn — putting them in the overworld
   * because that is the dimension on screen would be inventing a fact to fill a gap, and it
   * would look exactly like a successful read. Said once per change rather than once per
   * poll, so it is a report and not a flood.
   */
  private reportUnreadableDimensions(): void {
    const names = [...this.tracks.unknownDimension].sort().join(',');
    if (names === this.reportedUnknownDim) return;
    this.reportedUnknownDim = names;
    if (!names) return;
    this.deps.status(
      `live: NOT drawing ${this.tracks.unknownDimension.size} player(s) — the bridge could` +
        ` not read their Dimension: ${names}`,
    );
  }

  /**
   * One frame of players: interpolate, draw, label, follow.
   *
   * Called every frame from the app loop, AFTER the fly controls have moved the camera —
   * the follow lock adds the followed player's movement on top of whatever the user just
   * did, and running it first would have the controls overwrite it.
   */
  updatePlayers(): void {
    const poses = this.tracks.poses(performance.now());
    this.lastPoses = poses;
    const visible = poses.filter((p) => !this.hidesSelf(p.name));
    this.drawPlayers(visible);
    this.label(visible);
    this.updateFollow(poses);
    this.updateTurtles();
  }

  /**
   * Name tags, and the one thing that must not happen if they fail.
   *
   * This runs inside the frame loop, so an exception here does not merely lose the labels —
   * it takes `requestAnimationFrame` with it and the whole viewer stops. The label is the
   * least important thing on screen; the world is the most. So the failure is caught HERE,
   * where there is something to do about it: labels off, world still rendering, and the
   * reason on screen. Silently drawing no labels would be the other, worse answer.
   */
  private label(poses: readonly TrackPose[]): void {
    this.labelWith(this.tags, poses);
  }

  private labelWith(tags: NameTags, poses: readonly TrackPose[]): void {
    if (this.tagsBroken) return;
    try {
      tags.update(poses, this.deps.viewer.camera);
    } catch (e) {
      this.tagsBroken = true;
      this.tags.clear();
      this.turtleTags.clear();
      this.deps.status(`live: name tags are OFF — ${(e as Error).message}`);
    }
  }

  private drawPlayers(poses: readonly TrackPose[]): void {
    const mesh = this.ensurePlayerMesh();
    const alive = new Set<string>();
    this.selfKey = null;
    for (const pose of poses) {
      const key = `player:${pose.name}`;
      alive.add(key);
      if (this.isBot(pose.name)) {
        this.selfKey = key;
        this.selfYawDeg = pose.yawDeg;
      }
      if (!mesh) continue;
      this.placePlayer(key, pose);
    }
    for (const key of this.drawn) {
      if (alive.has(key)) continue;
      this.deps.viewer.removeSection(key);
      this.drawn.delete(key);
    }
  }

  /**
   * Upload the model ONCE per player and move it with a transform thereafter.
   *
   * The isometric view is the one exception: there the character being driven is placed
   * from the 10 Hz self poll in `frameIso`, which is strictly better data than the 1 Hz
   * roster, and two writers of one transform would fight at frame rate.
   */
  private placePlayer(key: string, pose: TrackPose): void {
    const mesh = this.playerMesh;
    if (!mesh) return;
    if (!this.drawn.has(key)) {
      this.deps.viewer.addEntityMesh(key, mesh.layers, {
        pos: pose.pos,
        angleDeg: pose.yawDeg,
        axis: 'Y',
      });
      this.drawn.add(key);
      return;
    }
    if (this.iso.active && this.isBot(pose.name)) return;
    this.deps.viewer.setEntityTransform(key, pose.pos, pose.yawDeg);
  }

  // -------------------------------------------------------------------------
  // Following

  get followingName(): string | null {
    return this.following;
  }

  /**
   * Follow the next player on screen; from the last one, release.
   *
   * Deliberately a cycle that ends in "nobody": the key that starts it also stops it, which
   * matters because a locked pointer can make an on-screen button unreachable (that is why
   * the camera-mode toggle is also on a key — see main.ts).
   */
  followNext(): string | null {
    if (this.controls.active || this.iso.active) {
      this.deps.status('follow is for watching — the camera is being driven right now');
      return null;
    }
    const next = nextFollowed(this.lastPoses.map((p) => p.name), this.following);
    if (next === null) {
      this.stopFollow(this.lastPoses.length ? 'follow released' : 'nobody to follow');
      return null;
    }
    const pose = this.lastPoses.find((p) => p.name === next)!;
    this.following = next;
    // Null so the first locked frame does not translate the camera by the whole snap.
    this.followAnchor = null;
    const [x, y, z] = followPlacement(pose.pos, pose.yawDeg);
    this.deps.viewer.camera.position.set(x, y, z);
    this.deps.fly?.lookAt(pose.pos[0], pose.pos[1] + 1, pose.pos[2]);
    this.deps.status(`following ${next} — F for the next player, Esc to release`);
    return next;
  }

  stopFollow(reason = 'follow released'): void {
    if (this.following === null) return;
    this.following = null;
    this.followAnchor = null;
    this.deps.viewer.setSubject(null);
    this.deps.status(reason);
  }

  /**
   * Keep the camera with the followed player.
   *
   * Translation only, so mouse-look and WASD keep working — see follow-camera.ts. The
   * subject reveal is asked for as well, because a followed player who walks behind a hill
   * and is never seen again is a follow that has failed in the least obvious way.
   */
  private updateFollow(poses: readonly TrackPose[]): void {
    if (this.following === null) return;
    const pose = poses.find((p) => p.name === this.following);
    if (!pose) {
      this.stopFollow(`stopped following ${this.following}: they are no longer on screen`);
      return;
    }
    const cam = this.deps.viewer.camera.position;
    if (this.followAnchor) {
      cam.x += pose.pos[0] - this.followAnchor[0];
      cam.y += pose.pos[1] - this.followAnchor[1];
      cam.z += pose.pos[2] - this.followAnchor[2];
    }
    this.followAnchor = [...pose.pos] as [number, number, number];
    this.deps.viewer.setSubject(pose.pos);
  }

  /**
   * Point the camera at the fake player, if one is being driven.
   *
   * The fake player is a real player, so it arrives in the ordinary roster — no second
   * poll and no separate code path. The comparison is case-INSENSITIVE because
   * `/player WebViewer spawn` produces a player that `list` reports as `webviewer`; an
   * exact match silently never fires, which presents as "the camera does not follow" and
   * nothing else. Verified against the live server.
   */
  private followBot(list: LivePlayer[]): void {
    const botName = this.client.control?.name?.toLowerCase();
    if (!botName) return;
    const bot = list.find((p) => p.name.toLowerCase() === botName);
    if (bot) this.controls.setBotPose(bot.pos);
  }

  /**
   * Is this roster entry the player this page is driving?
   *
   * Only while actually driving: when you are merely watching, the bot is somebody else's
   * avatar and must be drawn like anybody else. Case-INSENSITIVE for the same reason
   * `followBot` is — `/player WebViewer spawn` is reported by `list` as `webviewer`.
   */
  private isBot(name: string): boolean {
    if (this.client.control?.joined !== true) return false;
    const bot = this.client.control?.name?.toLowerCase();
    return !!bot && name.toLowerCase() === bot;
  }

  /** Only first person hides your own body; every other camera is looking at it. */
  private hidesSelf(name: string): boolean {
    return this.mode === 'first' && this.controls.active && this.isBot(name);
  }

  /** Built once. `undefined` means "not tried yet"; `null` means "tried, no geometry". */
  private ensurePlayerMesh(): EntityMesh | null {
    if (this.playerMesh !== undefined) return this.playerMesh;
    const ctx = this.deps.getContext();
    const models = this.deps.getEntityModels();
    if (!ctx || !models) return null; // not ready yet; retry on the next poll
    const quads = buildEntityQuads(models, PLAYER_TYPE, ctx.atlas);
    const mesh = quads ? meshEntityQuads(quads, ctx.atlas) : null;
    this.playerMesh = mesh && mesh.quadCount ? mesh : null;
    if (!this.playerMesh) {
      this.deps.status('live: no player geometry — is the bake older than this build?');
    }
    return this.playerMesh;
  }

  // -------------------------------------------------------------------------

  /**
   * Drive the camera from the server when a bot is being controlled.
   *
   * Returns false when it is not, so the caller leaves the ordinary fly controls alone —
   * "watching" and "playing" are the same page with the camera owned by different things.
   */
  updateCamera(dt: number): boolean {
    // A device that claimed a fine pointer but is being driven by a finger reveals the pad
    // the moment a real touch lands. `(pointer: coarse)` is a good guess and not a
    // guarantee, and the cost of guessing wrong is a player with no mine button.
    if (this.controls.diag.touches > 0 && this.controls.active && !this.pad.visible) {
      this.pad.setVisible(true, true);
      this.pad.setCrosshair(this.mode === 'first');
    }
    if (!this.controls.active && !this.iso.active) return false;
    // Owed look intents go out here rather than from the input handlers, so the last
    // fraction of a gesture is not lost to the throttle. Cheap and idempotent.
    this.controls.flushLook();
    if (!this.lastSample || !this.smoothed) return false;
    const age = (performance.now() - this.lastSample.t) / 1000;
    // Dead-reckon, but only for as long as a sample could plausibly still be in flight.
    // Past that the server has gone quiet and coasting is a guess, not a prediction.
    const lead = Math.min(age, MAX_EXTRAPOLATE_S);
    const target: [number, number, number] = [
      this.lastSample.pos[0] + this.velocity[0] * lead,
      this.lastSample.pos[1] + this.velocity[1] * lead,
      this.lastSample.pos[2] + this.velocity[2] * lead,
    ];
    const k = 1 - Math.exp(-CONVERGE_RATE * dt);
    for (let i = 0; i < 3; i++) this.smoothed[i] += (target[i] - this.smoothed[i]) * k;
    if (this.iso.active) this.frameIso(this.smoothed);
    else this.controls.setCameraTo(this.smoothed);
    return true;
  }

  /**
   * One isometric frame.
   *
   * The character's mesh is moved here rather than left where the 1 Hz roster poll put it:
   * in first person nobody sees their own body, but this mode is entirely about watching
   * it, and a subject that teleports once a second is the most visible thing on screen.
   * The same smoothed position that drives the camera drives the model, so they cannot
   * disagree.
   */
  private frameIso(pos: [number, number, number]): void {
    if (this.selfKey) this.deps.viewer.setEntityTransform(this.selfKey, pos, this.selfYawDeg);
    this.iso.update(pos);
  }

  hudLine(): string {
    const c = this.client;
    const age = c.lastReloadAt ? (performance.now() - c.lastReloadAt) / 1000 : null;
    return ` | ${describeControl(c.control)}`
      + ` | LIVE ${c.connected ? describeFlush(c.flush) : 'offline'}`
      + ` | ${this.playerLine()}`
      + this.turtleLine()
      + (age === null ? '' : ` | flushed ${age.toFixed(0)}s ago (${c.flush?.lastDurationMs ?? 0}ms)`)
      + (this.stats.chunksChanged ? ` | ${this.stats.chunksChanged} chunks changed` : '')
      + (this.dirty.size ? ` | ${this.dirty.size} to re-mesh` : '')
      + `\n${this.inputLine()}`;
  }

  /**
   * What the players on screen actually are.
   *
   * The delay is stated because it is real: poses are interpolated between samples, which
   * means they are drawn about one poll behind live. A viewer that quietly showed
   * second-old positions as if they were current would be the same class of lie as a stale
   * position drawn as fresh — so the number is on screen next to the count.
   *
   * `STALE` is the load-bearing word. A held pose and a player standing still are identical
   * on screen, and only one of them means the bridge has stopped answering.
   */
  private playerLine(): string {
    const stale = this.lastPoses.filter((p) => p.stale).length;
    const hidden = this.tracks.unknownDimension.size;
    return `${this.stats.players} players (${this.lastPoses.length} drawn`
      + `, ${(this.tracks.delayMs / 1000).toFixed(1)}s behind)`
      + (stale ? ` | ${stale} STALE` : '')
      + (hidden ? ` | ${hidden} not drawn: no Dimension read` : '')
      + (this.following ? ` | FOLLOWING ${this.following} (F next, Esc release)` : '');
  }

  /**
   * THE LINE YOU READ WHEN "THE CONTROLS DO NOTHING".
   *
   * Every layer a keypress has to survive, counted separately, because they all fail the
   * same silent way and the only thing that distinguishes them is which counter stopped
   * moving. Reading left to right is reading the path a keystroke takes:
   *
   *   bound   are the listeners attached at all (i.e. did Join succeed)
   *   lock    does THIS canvas hold the pointer — mouse-look is dead without it
   *   fine    does this device even have a lockable pointer; `no` means touch, and touch
   *           has no keyboard either, so `raw` will also be 0 and that is not a fault
   *   touch   touch points seen, which says the same thing from the other direction
   *   keys    what is held right now, key names and stick alike
   *   raw     keydowns the window saw AT ALL — 0 while you are pressing keys means the
   *           page does not have the keyboard, and nothing downstream can fix that
   *   try     intents built and handed to the socket
   *   sent    frames that actually went out on the wire
   *   drop    intents refused, because the bridge has not said a bot is joined
   *   ack     the last frame the BRIDGE said it handled, and whether it could act
   *
   * `raw` climbing while `try` does not is a filter bug here. `try` climbing while `sent`
   * does not is the join gate. `sent` climbing with no `ack` is the socket or the bridge.
   * `ack ... idle` is the bridge receiving input it is not in a position to act on.
   */
  private inputLine(): string {
    const c = this.client;
    const d = this.controls.diag;
    const ack = c.lastAck
      ? `${c.lastAck.of} ${((performance.now() - c.lastAck.at) / 1000).toFixed(1)}s`
        + (c.lastAck.driving ? ' driving' : ' IDLE')
      : 'none';
    const walk = this.iso.active
      ? ` walk=${this.iso.walkStatus.replace(' ', '-')}(${this.iso.plannedPath.length})` : '';
    return `input: mode=${this.mode}${this.iso.active ? '(bound)' : ''}${walk}`
      + ` pad=${yn(this.pad.visible)}`
      + ` bound=${yn(this.controls.active)} lock=${yn(this.controls.pointerLocked)}`
      + ` fine=${yn(this.controls.pointerFine)} touch=${d.touches}`
      + ` keys=${this.controls.heldNames.join(',') || '-'}`
      + ` raw=${d.rawKeys} try=${d.tried} sent=${c.sent} drop=${c.dropped} ack=${ack}`
      + (d.lockError ? ` | POINTER LOCK REFUSED: ${d.lockError}` : '');
  }
}

const yn = (b: boolean) => (b ? 'yes' : 'no');
