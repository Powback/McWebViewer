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
  ComputerRegistry, changedSections, headingYawDeg, turtleIdOf, turtleKey, turtleTagText, turtleActivity, turtleStateColor,
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
import { blockShapes } from './block-shapes.js';
import { PredictedBody, type PredictIntent } from './predict.js';
import {
  FALLBACK_MOTION, loadPhysics, motionFrom, type MotionConstants, type PhysicsData,
} from './physics.js';
import { TouchPad } from './touch-pad.js';
import { PlayHud, type Stack, type Vitals } from './play-hud.js';
import { loadItemIcons, type ItemIcons } from '../render/item-icons.js';
import { PlayerTracks, type RosterEntry, type TrackPose } from './player-tracks.js';
import { NameTags } from '../render/name-tags.js';
import { LiveEntities } from './live-entities.js';
import { SpacetimeEntities, connect as connectSpacetime } from './spacetime-entities.js';
import { SpacetimeTerrain } from './spacetime-sections.js';
import { SpacetimeNative } from './spacetime-native.js';
import { SourceToggle } from './source-toggle.js';
import { Joystick } from './joystick.js';
import { RecipeBook, type RecipeBundleView } from './recipe-book.js';
import { HeldItems, handsFrom } from '../render/held-item.js';
import { BreakOverlay } from '../render/break-overlay.js';
import { BreakTracker, breakSeconds, type TagIndex } from './break-progress.js';
import { SoundEngine } from '../render/sound.js';
import {
  Footsteps, eventForChange, soundFor, eventsForPalette, allBlockEvents,
} from './block-sounds.js';
import { loadSource, describeSource, type WorldSourceConfig } from './world-source.js';
import { MonitorScreens } from './monitor-screens.js';
import { ScreenFiles } from './screen-files.js';
import type { LiveMonitor } from './live.js';
import { hasCellColour } from './monitor-screens.js';
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
  /** the parallel `entities/` regions to watch for mobs, items and falling blocks */
  entityRegions: readonly string[];
  /**
   * Every canonical state key the baked bundle can render.
   *
   * Only the spacetime terrain path uses it, to recover the block properties the wire omits
   * (see spacetime-sections.ts). Optional: without it that path still runs, it just cannot
   * pin down a default and says so on the HUD instead of drawing the wrong thing.
   */
  bakedKeys?: () => Iterable<string>;
  /** URL prefix the entity regions are served from, e.g. `/dev/entities` */
  entityBase: string;
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
  /**
   * Chunk streaming hooks. `chunkFilter` limits a flush's re-reads to the chunks that are
   * loaded; `onSynced` runs after each sync so the streamer can re-read its index (a saved
   * chunk moves in the file); `onIngest` reports a chunk this view loaded on its own (a
   * turtle's chunk read on demand) so the streamer counts it as loaded.
   */
  chunkFilter?: (cx: number, cz: number) => boolean;
  onSynced?: () => void;
  onIngest?: (cx: number, cz: number) => void;
}

/** How long a turtle missing from the dump is still drawn (stale) before it is forgotten. */
const TURTLE_HOLD_MS = 60_000;

export class LiveView {
  readonly client: ObserverClient;
  readonly controls: LiveControls;
  readonly iso: IsoView;
  readonly pad: TouchPad;
  readonly hud: PlayHud;
  private watcher: RegionWatcher;
  /** Save-file mobs, items and falling blocks, re-read on the same flush and interpolated. */
  private entities: LiveEntities;
  /**
   * The spacetime entity feed, when that source is selected. Null on the bridge path, which
   * is the default and is deliberately left exactly as it was.
   */
  private spacetime: SpacetimeEntities | null = null;
  private stTerrain: SpacetimeTerrain | null = null;
  private stNative: SpacetimeNative | null = null;
  private sourceToggle: SourceToggle | null = null;
  private stick: Joystick | null = null;
  private sound: SoundEngine | null = null;
  private recipes: RecipeBook | null = null;
  private hands: HeldItems;
  private breaking = new BreakTracker();
  private breakOverlay: BreakOverlay | null = null;
  /** Block tags, for tool-vs-block matching. Named apart from the `tags` name-plate layer. */
  private blockTags: TagIndex | null = null;
  private heldMain: string | null = null;
  /** the last inventory seen, so a hotbar change can re-read the held stack */
  private stacks: Array<{ slot: number; id: string; count: number }> = [];
  private selectedSlot = 0;
  private footsteps = new Footsteps();
  private source: WorldSourceConfig | null = null;
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
  // Held while out of the dump (an unloaded chunk), but not for ever: a removed turtle drops
  // out too, and after a minute the world's silence is the answer.
  private turtleTracks = new PlayerTracks(DRAWN_DIMENSION, { holdLost: true, holdLostMs: TURTLE_HOLD_MS });
  private turtleTags: NameTags;
  /** Last live block and heading per id — the dump has no facing, so it comes from motion. */
  private liveHeading = new Map<number, { pos: readonly [number, number, number]; yaw: number }>();
  /** One mesh per turtle block state, built about the block's bottom centre; null = not in the bake. */
  private turtleMeshes = new Map<string, BlockSetMesh | null>();
  private turtlesDrawn = new Set<string>();
  private screens: MonitorScreens;
  private lastTurtlePoses: TrackPose[] = [];
  /** Region-drawn turtle blocks hidden because their computer has a live track; see mesher.ts. */
  private hidden: ReadonlyMap<string, ReadonlySet<number>> = new Map();
  /** HQ's name and activity line per computer id — what the drone is DOING, not where. */
  private hqLabels = new Map<number, { name: string | null; activity: string | null }>();
  /** whether the dump last saw each computer switched on — the state word when HQ is silent */
  private liveOn = new Map<number, boolean>();
  /** when each unknown computer's chunk was last read on demand (see describe) */
  private describedAt = new Map<number, number>();
  /** monitor text from the computers' own save files; the bridge feed fills panels it lacks */
  private screenFiles: ScreenFiles;
  private fileScreens: LiveMonitor[] = [];
  private feedScreens: LiveMonitor[] = [];

  /** Counters the HUD reports, so "it is connected" and "it is working" stay separable. */
  readonly stats = { chunksChanged: 0, sectionsRemeshed: 0, syncMs: 0, players: 0, computers: 0 };

  private lastSample: { pos: [number, number, number]; t: number } | null = null;
  private velocity: [number, number, number] = [0, 0, 0];
  private smoothed: [number, number, number] | null = null;
  /**
   * The locally-simulated body. Everything the camera shows while you are driving comes
   * from here; `smoothed` became the thing it is RECONCILED AGAINST rather than the thing
   * that is drawn. See predict.ts and PARITY-AUDIT.md §2.
   */
  private body: PredictedBody;
  /**
   * The constants the body is running on, kept so the PLANNER can be asked the same thing.
   *
   * The body owns them, but it does not hand them back, and a second copy of "what gravity
   * is" is exactly how a planner ends up plotting a jump the simulation cannot make.
   */
  private motion: MotionConstants = FALLBACK_MOTION;
  private physics: PhysicsData | null = null;

  constructor(url: string, private deps: LiveViewDeps) {
    this.watcher = new RegionWatcher(httpRangeFetch(deps.regionBase), deps.regions, deps.chunkFilter);
    this.tags = new NameTags(deps.viewer.scene);
    // Turtle bars are STATE colours (green working, grey idle, red off); the word says the same.
    this.turtleTags = new NameTags(deps.viewer.scene, undefined, TURTLE_TAG_LIFT, turtleStateColor);
    // Text on the monitors: the computers' own screen.json files first, the bridge feed for
    // any panel those do not cover; blank until one of them says otherwise.
    this.screens = new MonitorScreens(deps.viewer.scene);
    this.screenFiles = new ScreenFiles({
      computers: () => [...this.computers.known.values()].map((k) => ({ id: k.id, pos: k.pos })),
      stateAt: (x, y, z) => deps.world.palette[deps.world.getState(x, y, z)],
      onMonitors: (list) => { this.fileScreens = list; this.paintScreens(); },
    });
    this.entities = new LiveEntities({
      viewer: deps.viewer,
      getContext: deps.getContext,
      getStates: deps.getStates,
      getEntityModels: deps.getEntityModels,
      getIcons: () => this.icons,
      entityRegions: deps.entityRegions,
      entityBase: deps.entityBase,
      status: deps.status,
    });
    this.client = new ObserverClient(url, {
      status: deps.status,
      onPlayers: (list) => this.onPlayers(list),
      onComputers: (list) => this.onComputers(list),
      onMonitors: (list) => { this.feedScreens = list; this.paintScreens(); },
      onReload: () => {
        void this.sync();
        // On the spacetime path entities arrive continuously, so the flush must not also
        // re-read them from disk — that would overwrite fresh packet-rate positions with
        // whatever the last save happened to hold.
        if (!this.spacetime) void this.entities.onReload();
      },
      onControl: (c) => this.onControl(c),
      onSelf: (s) => this.onSelf(s),
      onVitals: (v) => this.onVitals(v),
      onInventory: (stacks) => this.onInventory(stacks),
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
      isTyping: () => this.typing || this.recipes?.typing === true,
      onInventory: () => this.hud.toggleInventory(),
      onChat: () => this.hud.openChat(),
      onUseBlock: (pos) => this.client.send({ t: 'openBlock', x: pos[0], y: pos[1], z: pos[2] }),
    });
    // Real collision shapes where we have them, the mod's own model where we do not, the
    // old name heuristic last — see block-shapes.ts. `physics` is null until the fetch
    // below lands, which only costs accuracy, never correctness.
    this.body = new PredictedBody(blockShapes(deps.world, navWorld(deps.world), null));
    this.hands = this.makeHands();
    void this.loadPhysicsTable();
    this.iso = new IsoView({
      canvas: deps.viewer.renderer.domElement,
      camera: deps.viewer.camera,
      world: deps.world,
      // The same chunks the renderer holds, asked what a walking body needs to know. The
      // planner is CLIENT-SIDE for exactly this reason: the data is already here.
      nav: navWorld(deps.world),
      // What the cutaway has taken out of the picture, so a click into a revealed room does not
      // resolve to the roof that was removed to show it.
      revealHides: (x, y, z) => deps.viewer.revealHides(x, y, z),
      send: (msg) => this.client.send(msg),
      setSubject: (pos) => deps.viewer.setSubject(pos),
      // The planner works out how far a jump carries the body from the SAME constants the
      // body is running on this frame, and from the speed it has actually measured — see
      // IsoViewDeps.motion. Read through a callback because both keep changing after the
      // page loads.
      motion: () => ({ motion: this.motion, speed: this.body.stats().speed }),
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
    // Raw samples, not the smoothed estimate: the calibration is measuring what the SERVER
    // actually did, and smoothing it first would measure our own filter instead.
    // The ACTIVE intent, not the keyboard's: walking speed is measured from sample pairs
    // taken while exactly one direction was held, and in the isometric view the keyboard is
    // unbound and holding nothing — so measuring against it meant a click-to-move walk
    // never calibrated and the planner kept sizing its jumps off the seed speed.
    this.body.observe(sample.pos, sample.at, this.activeIntent());
    if (!this.body.active) this.body.reset(sample.pos);
    this.controls.setBotPose(sample.pos);
  }

  /**
   * Fetch the extracted physics table and hand its constants to the body.
   *
   * Failure is not fatal and is not silent: without the table the body keeps FALLBACK_MOTION
   * and `stats().measured` stays false, which the HUD prints — so "the movement feels off"
   * and "the physics table never loaded" cannot look the same on screen.
   */
  private async loadPhysicsTable(): Promise<void> {
    const data = await loadPhysics();
    if (!data) {
      this.deps.status('live: physics.json not loaded — movement uses FALLBACK constants and'
        + ' collision falls back to whole blocks (run harness/run.sh to bake it)');
      return;
    }
    this.physics = data;
    this.refreshHands();
    const motion = motionFrom(data.player);
    this.motion = motion;
    this.body.setMotion(motion);
    // The crosshair's reach is the game's, not the 5 this used to assume.
    this.controls.setReach(motion.reach);
    this.body.setShapes(blockShapes(this.deps.world, navWorld(this.deps.world), data));
  }

  /**
   * Bring up the SpacetimeDB entity feed.
   *
   * A failure here falls back to the save-file path rather than leaving the viewer with no
   * entities at all: a degraded view that says so beats an empty one that does not.
   */
  private async startSpacetime(): Promise<void> {
    const cfg = this.source;
    if (!cfg) return;
    const feed = new SpacetimeEntities({
      onRoster: (roster) => this.entities.ingestExternal(roster),
      // Panels go into the same slot the bridge's screen.json feed uses, so the painter does
      // not know or care which source drew them — and the per-cell colour the bridge can
      // never supply simply arrives filled in. See spacetime-monitors.ts.
      onMonitors: (panels) => { this.feedScreens = panels; this.paintScreens(); },
      status: (m) => this.deps.status(m),
    });
    try {
      const conn = await connectSpacetime(cfg.stdbUri, cfg.database, (m) => this.deps.status(m));
      feed.attach(conn);
      this.spacetime = feed;
      this.startSpacetimeTerrain(conn, cfg.stdbUri, cfg.database);
      // Players and computers natively, so nothing here needs the bridge.
      const native = new SpacetimeNative({
        onPlayers: (list) => this.onPlayers(list),
        onComputers: (list) => this.onComputers(list),
        status: (m) => this.deps.status(m),
      });
      native.attach(conn as never);
      this.stNative = native;
    } catch (e) {
      this.deps.status(
        `spacetime: entity feed unavailable (${(e as Error).message}) — falling back to the save files`);
      await this.entities.start();
    }
  }

  /**
   * Terrain over the same connection.
   *
   * Sections go into the very same `World.addLiveSection` the save-file live path uses and
   * are marked dirty through the very same `invalidatedSections`, so `pump()` re-meshes them
   * without knowing or caring where they came from.
   *
   * `bakedKeys` hands the namer the bundle's canonical keys, which is how it recovers the
   * properties the wire leaves out — see spacetime-sections.ts.
   */
  private startSpacetimeTerrain(conn: unknown, uri: string, database: string): void {
    const base = uri.replace(/\/$/, '');
    this.stTerrain = new SpacetimeTerrain({
      world: this.deps.world,
      sql: async (query) => {
        try {
          const res = await fetch(`${base}/v1/database/${database}/sql`, {
            method: 'POST', headers: { 'content-type': 'text/plain' }, body: query,
          });
          if (!res.ok) return null;
          const body = (await res.json()) as Array<{ rows?: unknown[][] }>;
          return body[0]?.rows ?? [];
        } catch {
          return null;
        }
      },
      bakedKeys: () => this.deps.bakedKeys?.() ?? [],
      onSection: (cx, cy, cz) => {
        for (const key of invalidatedSections(cx, cy, cz)) this.dirty.add(key);
      },
      onBlockChange: (pos, oldKey, newKey) => this.blockChanged(pos, oldKey, newKey),
      status: (m) => this.deps.status(m),
    });
    this.stTerrain.attach(conn as never);
  }

  /**
   * Block tags, for working out whether the held tool is the right one.
   *
   * A separate bake from `physics.json` because the harness CANNOT resolve them: a
   * registry-only boot loads no datapack tags, so every tag it sees is empty. See
   * server/tag-bake.ts.
   */
  private async loadTags(): Promise<void> {
    try {
      const res = await fetch(`${this.deps.bakedBase}/tags.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.blockTags = (await res.json()) as TagIndex;
    } catch {
      // Without tags every tool reads as the wrong one, so mining times come out at
      // bare-hand speed. Said rather than silently slow.
      this.deps.status('break progress: no tags.json — tool speeds will read as bare hands');
    }
  }

  /**
   * Advance the mining overlay.
   *
   * The tracker is keyed on the block's POSITION as well as its state, so two adjacent
   * stone blocks do not share progress; looking away and back starts again, as in vanilla.
   */
  private updateBreaking(dt: number): void {
    if (!this.breakOverlay) {
      this.breakOverlay = new BreakOverlay(this.deps.viewer.scene);
      const atlas = this.deps.getAtlas();
      if (atlas) this.breakOverlay.setAtlas(atlas);
    }
    const hit = this.controls.isDigging ? this.controls.targetBlock() : null;
    if (!hit) {
      this.breaking.update(null, null, dt);
      this.breakOverlay.show(null, -1);
      return;
    }
    const [bx, by, bz] = hit.block;
    const id = this.deps.world.getState(bx, by, bz);
    const stateKey = this.deps.world.palette[id] ?? '';
    const seconds = breakSeconds(
      { physics: this.physics, tags: this.blockTags, tool: this.heldMain }, stateKey);
    this.breaking.update(`${stateKey}@${bx},${by},${bz}`, seconds, dt);
    this.breakOverlay.show([bx, by, bz], this.breaking.stage);
  }

  /** Vitals also carry the selected hotbar slot, which decides the main hand. */
  private onVitals(v: Record<string, unknown>): void {
    this.hud.setVitals(v as unknown as Vitals);
    const slot = v.selectedSlot;
    if (typeof slot === 'number') {
      this.selectedSlot = slot;
      this.refreshHands();
    }
  }

  private onInventory(stacks: Array<{ slot: number; id: string; count: number }>): void {
    this.hud.setInventory(stacks as Stack[]);
    this.stacks = stacks;
    this.refreshHands();
  }

  /** The two in-hand view models, drawn through the ordinary block mesher. */
  private makeHands(): HeldItems {
    return new HeldItems({
      camera: this.deps.viewer.camera,
      getStates: () => this.deps.getStates(),
      getAtlas: () => this.deps.getAtlas(),
      getIcons: () => this.icons,
    });
  }

  /**
   * Put the selected hotbar stack in the main hand and slot 40 in the off hand.
   *
   * `data get entity <name> Inventory` returns EVERY compartment in one list keyed by slot,
   * so the off hand is in there already — it just needed identifying, and the slot number is
   * a Java constant (`Inventory.SLOT_OFFHAND`) the harness now extracts rather than this
   * guessing at 40.
   */
  private refreshHands(): void {
    const { main, off } = handsFrom(
      this.stacks, this.selectedSlot, this.physics?.player.offhandSlot);
    this.heldMain = main;
    this.hands.set('main', main);
    this.hands.set('off', off);
  }

  /**
   * The recipe browser: every mod's recipes, from the bake.
   *
   * Fetched lazily and gzip-served alongside the other baked artifacts (338 KB on the wire).
   * A failure here costs the panel, not the page.
   */
  private startRecipes(): void {
    const book = new RecipeBook({
      root: this.deps.hudRoot,
      getIcons: () => this.icons,
    });
    this.recipes = book;
    void (async () => {
      try {
        const res = await fetch(`${this.deps.bakedBase}/recipes.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bundle = (await res.json()) as RecipeBundleView;
        book.setBundle(bundle);
        this.deps.status(
          `recipes: ${bundle.stats.parsed} from ${bundle.stats.types} types`
          + ` (${bundle.stats.unreadable} unreadable) — press R`);
      } catch (e) {
        this.deps.status(`recipes: not available (${(e as Error).message})`
          + ' — run `npm run bake-assets`');
      }
    })();
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyR' || this.typing || book.typing) return;
      // R is also "respawn" while driving a fake player; the browser only takes it when
      // nothing is being driven, so the two cannot fight over the key.
      if (this.client.control?.joined === true) return;
      e.preventDefault();
      book.toggle();
    });
  }

  /**
   * Tell the server where the body actually is.
   *
   * The browser's local simulation integrates REAL SECONDS against the game's own extracted
   * constants, so it is the thing that knows the right answer. The server's own movement
   * command is applied per TICK, and this world runs at a 200/s target (about 145 in
   * practice) against vanilla's 20 — measured on the dev replica, a one-second walk covered
   * 4.17 blocks at 20 ticks and 16.70 at 200. Driving the body by position instead makes the
   * distance travelled per real second the simulation's, whatever the tick rate is doing.
   *
   * Only while a fake player is joined: with nobody joined there is no body to place.
   * Rate-limiting lives in the bridge, next to the RCON connection it protects.
   */
  private pushPosition(pos: readonly [number, number, number]): void {
    if (this.client.control?.joined !== true) return;
    // NEVER TELEPORT THE BOT OUT OF THE WORLD, whatever the local simulation believes.
    //
    // This is the guard that makes a bad fall survivable rather than terminal. The local
    // body dropping below the build height is always a bug — it used to be a hitched frame
    // sweeping it straight through the floor (see `moveAxis` in predict.ts) — and pushing
    // that position on was what turned a client-side glitch into a server-side one: the bot
    // ends up under the world, where nothing is solid, so nothing stops it and nothing
    // reports it. Held back here, the bot stays where it was and the HUD says why, which
    // leaves the walk recoverable and the cause visible.
    if (pos[1] < this.deps.world.minY) {
      this.deps.status('live: the local body is below the world — not moving the bot.'
        + ' Press R to respawn it');
      return;
    }
    this.client.send({ t: 'goto', x: pos[0], y: pos[1], z: pos[2] });
  }

  /**
   * Point the listener where the camera is looking, once a frame.
   *
   * Taken from the camera rather than from the player body so that panning is right in
   * every mode — fly, isometric and first person — since the camera is the only thing all
   * three agree on. Also resets the per-frame sound budget.
   */
  private updateListener(): void {
    if (!this.sound) return;
    const cam = this.deps.viewer.camera;
    // The camera's forward is the negated third column of its world matrix. Read straight
    // out of the matrix rather than allocating a Vector3 every frame for one direction.
    const m = cam.matrixWorld.elements;
    this.sound.setListener(
      [cam.position.x, cam.position.y, cam.position.z],
      [-m[8], -m[9], -m[10]],
    );
  }

  /**
   * Bring up audio.
   *
   * The manifest loads immediately; the AudioContext cannot, because every browser refuses
   * to start one until the user has interacted with the page — and refuses SILENTLY. So the
   * context is created on the first click or keypress, and until then the HUD says audio is
   * waiting rather than letting it look broken.
   */
  private async startSound(): Promise<void> {
    const engine = new SoundEngine({ base: '/sounds', status: (m) => this.deps.status(m) });
    if (!await engine.load()) return;
    this.sound = engine;
    const wake = () => {
      void engine.resume().then(async () => {
        // Warm what this world can actually make, BEFORE the first block breaks: a lazy
        // cache alone means the first break of every material is silent.
        // This world's own blocks first, with a couple of variants each, so the sounds
        // most likely to happen are the ones ready soonest.
        const events = eventsForPalette(this.physics, this.deps.world.palette);
        await engine.preload(events);
        this.deps.status(
          `sound: ${engine.state}, ${events.length} events for this world`
          + `, ${engine.stats.preloaded} files ready`);
        // Then every block sound the game has, one variant each, in the background: a block
        // can be placed that this world has never contained, and that first break was
        // measurably being dropped.
        const all = allBlockEvents(this.physics);
        await engine.preload(all, 1, 6);
        this.deps.status(`sound: ${engine.stats.preloaded} files ready (${all.length} events)`);
      });
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
  }

  /**
   * One block changed: play its break or place sound where it happened.
   *
   * The sound belongs to the block that LEFT on a break and the one that ARRIVED on a
   * place — getting that backwards makes mining stone sound like air.
   */
  blockChanged(pos: readonly [number, number, number], oldKey: string | null, newKey: string | null): void {
    if (!this.sound) return;
    const ev = eventForChange(this.physics, oldKey, newKey);
    if (!ev) return;
    // Block centre, so the pan matches where the block visibly is.
    this.sound.play(ev.event, [pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5],
      { volume: ev.volume, pitch: ev.pitch });
  }

  /** Footsteps for the locally-simulated body, paced by distance walked. */
  private stepSound(pos: readonly [number, number, number], onGround: boolean): void {
    if (!this.sound) return;
    if (!this.footsteps.update(pos, onGround)) return;
    const below: [number, number, number] = [
      Math.floor(pos[0]), Math.floor(pos[1] - 0.1), Math.floor(pos[2]),
    ];
    const id = this.deps.world.getState(below[0], below[1], below[2]);
    const key = this.deps.world.palette[id];
    if (!key) return;
    const sound = soundFor(this.physics, key);
    if (!sound?.stepSound) return;
    // Vanilla plays footsteps well below the SoundType's nominal volume.
    this.sound.play(sound.stepSound, pos, { volume: sound.volume * 0.3, pitch: sound.pitch });
  }

  /** Everything the spacetime path contributes, or nothing at all on the bridge path. */
  private spacetimeLine(): string {
    return (this.spacetime ? this.spacetime.hudLine() : '')
      + (this.stTerrain ? this.stTerrain.hudLine() : '')
      + (this.stNative ? this.stNative.hudLine() : '')
      + this.unavailableLine();
  }

  /**
   * What this mode genuinely cannot show, named on screen.
   *
   * The rule the whole source seam turns on: anything that cannot be served from the chosen
   * source must be VISIBLY absent, never silently backfilled from the other one. Each of
   * these is a property of the transport rather than unfinished work:
   *
   *   chat          the bridge reads it by tailing the server log; the Minecraft protocol
   *                 does carry chat, but the module does not yet have a table for it
   *   controls      the fake player is driven by RCON commands, which is a bridge facility
   *   screen text   NOT on the network protocol at all, so no protocol client can ever see
   *                 it — it comes from each computer's own `screen.json` in the save, which
   *                 is a separate channel and is labelled as one rather than dressed up as
   *                 a spacetime feed
   */
  private unavailableLine(): string {
    if (!this.bridgeless) return '';
    const screens = this.fileScreens.length;
    return ' | NOT IN SPACETIME: chat, controls'
      + ` | screens: ${screens} from screen.json (save file, not the protocol)`;
  }

  /** Which world source won, so the Join button can explain itself honestly. */
  get sourceKind(): 'bridge' | 'spacetime' {
    return this.source?.kind ?? 'bridge';
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
    this.screenFiles.start();
    // Read and draw the save's own entities (mobs, items, falling blocks) before connecting,
    // so they are on screen at load and the first flush's re-read has a baseline to diff.
    this.source = await loadSource();
    this.deps.status(describeSource(this.source));
    // The movement joystick: bottom LEFT, its own circle, pointer events so a trackpad
    // drives it as well as a finger. The action pad owns the bottom right and the iso view
    // owns a primary drag anywhere else, so none of the three can take another's press.
    this.stick = new Joystick({
      root: this.deps.hudRoot,
      onChange: (v) => this.controls.setAnalog(v),
    });
    this.sourceToggle = new SourceToggle({ root: this.deps.hudRoot });
    this.sourceToggle.setSource(this.source);
    // The Join button's reason depends on the source, and in spacetime mode no control
    // state will ever arrive to trigger a re-render — so push one now.
    // A null control is exactly what the button needs to see in spacetime mode: it is the
    // absence of a control channel, which is the true reason it is disabled.
    this.onControlChange?.(this.client.control as never);
    await this.startSound();
    this.startRecipes();
    void this.loadTags();
    if (this.source.kind === 'spacetime') {
      // THE BRIDGE IS NOT OPENED AT ALL in spacetime mode.
      //
      // Not "opened and ignored" — a bridge socket keeps polling the server and, worse,
      // keeps the `save-all flush` running, so the viewer would still be leaning on the
      // save files while claiming to be native. Everything the bridge used to supply is
      // either served from the module (players, computers, terrain, light, entities) or is
      // honestly absent and named as such on the HUD (chat, the fake player, monitor text).
      await this.startSpacetime();
    } else {
      await this.entities.start();
      this.client.connect();
    }
  }

  /** True when no bridge socket exists, so callers do not send into a dead client. */
  private get bridgeless(): boolean {
    return this.source?.kind === 'spacetime';
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
      this.deps.onSynced?.();
    } finally {
      this.syncing = false;
      this.stats.syncMs = performance.now() - t0;
    }
  }

  /**
   * A chunk the streaming loader just added. Its computers (labels, kinds, saved blocks)
   * are absorbed exactly as `start()` absorbs those of the chunks loaded before it ran —
   * on the streaming path most of the world arrives after that.
   */
  noteColumn(col: ChunkColumn): void {
    this.absorbComputers(col);
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
    this.deps.onIngest?.(cx, cz);
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
    this.entities.invalidate();
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
      this.noteHqLabel(c);
      this.liveOn.set(c.id, c.on);
      if (this.computers.kindOf(c.id) === 'unknown') void this.describe(c);
      if (this.computers.kindOf(c.id) === 'computer') continue;
      roster.push({
        name: turtleKey(c.id),
        pos: c.pos,
        yawDeg: this.headingFor(c),
        dimension: DRAWN_DIMENSION,
      });
    }
    this.turtleTracks.ingest(roster, performance.now());
    this.refreshHidden();
  }

  /**
   * A computer the dump lists but no loaded chunk has described: read its chunk now. The
   * region watcher only re-reads chunks whose header changed, and a turtle placed into a
   * chunk that was saved before the page loaded sits in one that never does — so without
   * this it would draw as a bare default turtle (no block entity: no label, no upgrades)
   * until a reload. One read per id per minute at most.
   */
  private async describe(c: LiveComputer): Promise<void> {
    const now = performance.now();
    const last = this.describedAt.get(c.id) ?? -Infinity;
    if (now - last < 60_000) return;
    this.describedAt.set(c.id, now);
    const chunk = await this.watcher.readAt(c.pos[0] >> 4, c.pos[2] >> 4).catch(() => null);
    if (chunk) this.ingest(chunk.cx, chunk.cz, chunk.root);
  }

  /**
   * Keep HQ's last-known name and activity for a computer. The bridge sends them every
   * tick, so a tick that omitted them (HQ briefly unreachable) must not blank a tag that
   * had one — hence the fall back to what was stored.
   */
  private noteHqLabel(c: LiveComputer): void {
    if (!c.name && !c.label) return;
    const prev = this.hqLabels.get(c.id);
    this.hqLabels.set(c.id, {
      name: c.name ?? prev?.name ?? null,
      activity: c.label ?? prev?.activity ?? null,
    });
  }

  /**
   * A turtle's heading: its last horizontal step, else the heading it kept (vertical move),
   * else its saved block's facing, else north. Stored so a vertical-only move holds facing.
   */
  private headingFor(c: LiveComputer): number {
    const prev = this.liveHeading.get(c.id);
    const yaw = headingYawDeg(prev?.pos, c.pos)
      ?? prev?.yaw
      ?? this.computers.get(c.id)?.facingYawDeg
      ?? 0;
    this.liveHeading.set(c.id, { pos: c.pos, yaw });
    return yaw;
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
      poses.map((p) => ({ ...p, name: this.turtleTag(turtleIdOf(p.name)) })),
    );
  }

  /**
   * The tag for one turtle: HQ's name and activity when it has them, the region label or id
   * otherwise. `D37 · fetching wood`, `D4 · depositing`, `#57` for a drone HQ does not list.
   */
  private turtleTag(id: number): string {
    const hq = this.hqLabels.get(id);
    const name = hq?.name ?? this.computers.get(id)?.label ?? null;
    return turtleTagText(name, id, turtleActivity(hq?.activity, this.liveOn.get(id) ?? true));
  }

  private drawTurtles(poses: readonly TrackPose[]): void {
    const alive = new Set<string>();
    for (const pose of poses) {
      const id = turtleIdOf(pose.name);
      const key = `turtle:${id}`;
      alive.add(key);
      const mesh = this.turtleMesh(this.computers.markerStates(id));
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
  private turtleMesh(stateKeys: readonly string[]): BlockSetMesh | null {
    const cacheKey = stateKeys.join('|');
    const hit = this.turtleMeshes.get(cacheKey);
    if (hit !== undefined) return hit;
    const ctx = this.deps.getContext();
    const states = this.deps.getStates();
    if (!ctx || !states) return null; // not ready; not cached, so it is retried next frame
    // The body and its upgrades occupy the same block; meshBlockSet draws them all there.
    const blocks = stateKeys.map((stateKey) => ({ x: -0.5, y: 0, z: -0.5, stateKey }));
    const mesh = meshBlockSet(blocks, states, ctx.atlas);
    const usable = mesh.quadCount ? mesh : null;
    if (!usable) {
      this.deps.status(`live: no model for ${stateKeys[0]} in the bake — that turtle is a label until it is re-baked`);
    }
    this.turtleMeshes.set(cacheKey, usable);
    return usable;
  }

  /** Files win per panel; the bridge feed covers the rest. */
  /**
   * Choose a screen source, rather than merging two descriptions of the same wall.
   *
   * Two routes can describe the same panel: a computer's `screen.json` — a save file that
   * lags and carries `lines` and nothing else — and the live feed. Merging them by position
   * does not work, because they do not agree on the origin: the file route derives it by
   * walking the monitor blocks around the computer, while the feed reports the panel's own
   * origin block. Measured on the live server, that disagreement drew the MapServer log
   * TWICE on one wall, offset by about fifteen rows.
   *
   * So when the feed is supplying panels with per-character colour it is used ALONE. It is a
   * superset by construction — every panel on the server, from the protocol, with colours
   * the save file cannot represent — and mixing in a lagged partial copy can only make the
   * wall worse.
   */
  private paintScreens(): void {
    const rich = this.feedScreens.some(hasCellColour);
    if (rich) {
      this.screens.update(this.feedScreens);
      return;
    }
    const key = (m: LiveMonitor) => `${m.x},${m.y},${m.z},${m.facing}`;
    const seen = new Set(this.fileScreens.map(key));
    const rest = this.feedScreens.filter((m) => !seen.has(key(m)));
    this.screens.update([...this.fileScreens, ...rest]);
  }

  /** Read a column's computer block entities; a changed record re-plans what is hidden. */
  private absorbComputers(col: ChunkColumn): void {
    const w = this.deps.world;
    const changed = this.computers.absorb(col, (x, y, z) => w.palette[w.getState(x, y, z)]);
    // A computer the re-read column no longer contains is gone from the world: its live
    // marker must not outlive its block.
    for (const id of changed) {
      if (!this.computers.get(id)) this.turtleTracks.forget(turtleKey(id));
    }
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
    this.entities.update();
    this.updateListener();
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
    this.revealPadOnTouch();
    if (!this.controls.active && !this.iso.active) return false;
    // Owed look intents go out here rather than from the input handlers, so the last
    // fraction of a gesture is not lost to the throttle. Cheap and idempotent.
    this.controls.flushLook();
    if (!this.lastSample || !this.smoothed) return false;
    const target = this.serverEstimate();
    const k = 1 - Math.exp(-CONVERGE_RATE * dt);
    for (let i = 0; i < 3; i++) this.smoothed[i] += (target[i] - this.smoothed[i]) * k;
    // `smoothed` is now the best estimate of where the server has us, and the thing the
    // prediction is corrected TOWARD — not the thing drawn. Drawing it was the input lag.
    if (!this.body.active) this.body.reset(this.smoothed);
    // THE ORDER IS THE FIX. The isometric view decides what the body should do from where
    // the body IS, the simulation is stepped with that, and only then is the camera placed
    // at where it ENDED UP. This mode used to send `input` frames straight at the bridge
    // and never touch the simulation at all — so the body stood still, and `pushPosition`
    // below teleported the server's bot onto a position that was never going anywhere.
    if (this.iso.active) this.iso.steer(this.body.position);
    this.body.step(dt, this.activeIntent(), this.activeYaw());
    this.body.reconcile(this.smoothed, dt);
    const shown = this.body.position;
    this.stepSound(shown, this.body.stats().onGround);
    this.updateBreaking(dt);
    this.pushPosition(shown);
    if (this.iso.active) this.frameIso(shown);
    else this.controls.setCameraTo(shown);
    return true;
  }

  /**
   * Who is driving the body right now.
   *
   * Exactly one of the two input paths is bound at a time (`applyInputMode`), and this is
   * the one place that says which — so the simulation, the speed calibration and the
   * server's own copy of the movement can never be fed by different halves of the app.
   */
  private activeIntent(): PredictIntent {
    return this.iso.active ? this.iso.intent() : this.controls.intent();
  }

  /** Which way "forward" is for whoever is driving. */
  private activeYaw(): number {
    return this.iso.active ? this.iso.walkYaw : this.controls.lookYaw;
  }

  /**
   * A device that claimed a fine pointer but is being driven by a finger reveals the pad
   * the moment a real touch lands. `(pointer: coarse)` is a good guess and not a guarantee,
   * and the cost of guessing wrong is a player with no mine button.
   */
  private revealPadOnTouch(): void {
    if (this.controls.diag.touches > 0 && this.controls.active && !this.pad.visible) {
      this.pad.setVisible(true, true);
      this.pad.setCrosshair(this.mode === 'first');
    }
  }

  /**
   * Where the SERVER most likely has us right now.
   *
   * Dead-reckoned from the newest sample along its measured velocity, but only for as long
   * as a sample could plausibly still be in flight. Past that the server has gone quiet and
   * coasting is a guess, not a prediction — so the estimate stops moving and the local body
   * is reconciled toward a stationary point rather than being dragged off after a stale
   * velocity.
   */
  private serverEstimate(): [number, number, number] {
    const sample = this.lastSample!;
    const age = (performance.now() - sample.t) / 1000;
    const lead = Math.min(age, MAX_EXTRAPOLATE_S);
    return [
      sample.pos[0] + this.velocity[0] * lead,
      sample.pos[1] + this.velocity[1] * lead,
      sample.pos[2] + this.velocity[2] * lead,
    ];
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
    // `frame`, not `update`: the steering for this frame already ran, before the body was
    // stepped. All that is left is to put the camera on the result.
    this.iso.frame(pos);
  }

  hudLine(): string {
    const c = this.client;
    const age = c.lastReloadAt ? (performance.now() - c.lastReloadAt) / 1000 : null;
    return ` | ${describeControl(c.control)}`
      + ` | LIVE ${c.connected ? describeFlush(c.flush) : 'offline'}`
      + ` | ${this.playerLine()}`
      + this.turtleLine()
      + this.entities.hudLine()
      + this.hands.hudLine()
      + this.spacetimeLine()
      + (this.sound ? this.sound.hudLine() : ' | sound: off')
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
      + this.predictLine()
      + (d.lockError ? ` | POINTER LOCK REFUSED: ${d.lockError}` : '');
  }

  /**
   * What the local prediction is doing, and how far it disagrees with the server.
   *
   * `drift` is the number that matters. In steady state it sits near zero; it rises during
   * the round trip after a keypress (that IS the hidden latency, made visible) and it stays
   * risen if the local collision model is wrong about some block — which is the one failure
   * mode of this whole feature and must not be silent. `phys=FALLBACK` says the extracted
   * constants never loaded, so nobody mistakes guessed movement for the game's.
   */
  private predictLine(): string {
    // The ISOMETRIC view counts too. This used to check only the first-person controls, so
    // the one number that says whether the simulation and the server agree went blank in
    // the mode where the character is being driven by a planner rather than by a hand on
    // the keys — which is the mode where you can least afford to guess.
    // WHO IS DRIVING, SAID OUT LOUD. When neither driver is bound, `updateCamera` returns false
    // and main.ts falls through to `FlyControls` — a free-fly camera with NO COLLISION of any kind.
    // That is correct for looking around a save file and indistinguishable, from the keyboard,
    // from playing badly: "theres nothing preventing me from walking through walls in 1p" (the
    // user, 2026-09-11), when the simulation that does the colliding was not driving at all. The
    // body's own collision is sound -- a body walked into a wall stops at 65.700 against a wall at
    // 66, exactly its half-width -- so the only question this line has to answer is which of the
    // two is on, and a blank HUD answered it by omission.
    if (!this.controls.active && !this.iso.active) return ' | camera: FREE-FLY (no collision)';
    const p = this.body.stats();
    const cov = this.physics ? 'exact' : 'heuristic';
    return ` | drive=${this.iso.active ? 'iso' : '1p'} predict: drift=${p.drift.toFixed(2)}b`
      + ` speed=${p.speed.toFixed(2)}${p.calibrations ? `(${p.calibrations})` : '(seed)'}`
      + ` ground=${yn(p.onGround)}`
      + (p.resyncs ? ` resync=${p.resyncs}` : '')
      + ` phys=${p.measured ? 'game' : 'FALLBACK'}/${cov}`
      // The server's clock, named when it disagrees with ours. This world runs a 200/s tick
      // target and manages about 145 against vanilla's 20, so its idea of how far a player
      // moves in a second is wrong — movement comes from the local simulation instead, and
      // that has to be visible rather than a silent divergence.
      + (p.serverPlausible
        ? ''
        : ` | SERVER CLOCK ${(p.serverSpeed / Math.max(p.speed, 0.01)).toFixed(1)}x`
          + ' — movement is local, not reconciled');
  }
}

const yn = (b: boolean) => (b ? 'yes' : 'no');
