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
 * Players are drawn as one cached bind-pose mesh per session, re-transformed each poll.
 * They do not animate — there is no `setupAnim` here any more than there is for mobs —
 * so a walking player slides rather than strides. Stated, not hidden.
 */

import { meshSection, type MeshContext } from '../render/mesher.js';
import type { Viewer } from '../render/viewer.js';
import type { World } from '../render/world.js';
import {
  buildEntityQuads, entityYawDeg, meshEntityQuads, type EntityMesh, type EntityModelSet,
} from '../render/entity-geometry.js';
import { PLAYER_TYPE } from '../render/player-model.js';
import {
  RegionWatcher, diffSections, httpRangeFetch, invalidatedSections,
} from './region-sync.js';
import { ObserverClient, describeControl, describeFlush, type ControlState, type LivePlayer, type SelfSample } from './live.js';
import { LiveControls } from './live-controls.js';
import { IsoView, type CameraMode } from './iso-view.js';
import { TouchPad } from './touch-pad.js';
import { PlayHud, type Stack, type Vitals } from './play-hud.js';
import { loadItemIcons, type ItemIcons } from '../render/item-icons.js';

/** Regions are the overworld's; a player in the nether is tracked but not drawn. */
const DRAWN_DIMENSION = 'minecraft:overworld';

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

  /** Counters the HUD reports, so "it is connected" and "it is working" stay separable. */
  readonly stats = { chunksChanged: 0, sectionsRemeshed: 0, syncMs: 0, players: 0 };

  private lastSample: { pos: [number, number, number]; t: number } | null = null;
  private velocity: [number, number, number] = [0, 0, 0];
  private smoothed: [number, number, number] | null = null;

  constructor(url: string, private deps: LiveViewDeps) {
    this.watcher = new RegionWatcher(httpRangeFetch(deps.regionBase), deps.regions);
    this.client = new ObserverClient(url, {
      status: deps.status,
      onPlayers: (list) => this.onPlayers(list),
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
      send: (msg) => this.client.send(msg),
      setCutaway: (y) => deps.viewer.setCutawayY(y),
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

  // -------------------------------------------------------------------------
  // Players

  private onPlayers(list: LivePlayer[]): void {
    this.stats.players = list.length;
    const mesh = this.ensurePlayerMesh();
    const alive = new Set<string>();
    this.followBot(list);
    this.selfKey = null;
    for (const p of list) {
      if (p.dimension !== null && p.dimension !== DRAWN_DIMENSION) continue;
      // NEVER draw the player you ARE — in FIRST PERSON. The camera sits at that bot's eye
      // height, inside its head, so drawing it puts the inside of a Steve skull across the
      // view. A real client does the same: your own model is drawn in third person and
      // skipped in first. The isometric camera is third person, and the character is the
      // entire subject of that mode, so there it MUST be drawn.
      if (this.hidesSelf(p.name)) continue;
      const key = `player:${p.name}`;
      alive.add(key);
      if (this.isBot(p.name)) {
        this.selfKey = key;
        this.selfYawDeg = entityYawDeg(p.yaw);
      }
      if (!mesh) continue;
      this.deps.viewer.addEntityMesh(key, mesh.layers, {
        pos: p.pos,
        angleDeg: entityYawDeg(p.yaw),
        axis: 'Y',
      });
      this.drawn.add(key);
    }
    for (const key of this.drawn) {
      if (alive.has(key)) continue;
      this.deps.viewer.removeSection(key);
      this.drawn.delete(key);
    }
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
      + ` | ${this.stats.players} players`
      + (age === null ? '' : ` | flushed ${age.toFixed(0)}s ago (${c.flush?.lastDurationMs ?? 0}ms)`)
      + (this.stats.chunksChanged ? ` | ${this.stats.chunksChanged} chunks changed` : '')
      + (this.dirty.size ? ` | ${this.dirty.size} to re-mesh` : '')
      + `\n${this.inputLine()}`;
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
    return `input: mode=${this.mode}${this.iso.active ? '(bound)' : ''}`
      + ` pad=${yn(this.pad.visible)}`
      + ` bound=${yn(this.controls.active)} lock=${yn(this.controls.pointerLocked)}`
      + ` fine=${yn(this.controls.pointerFine)} touch=${d.touches}`
      + ` keys=${this.controls.heldNames.join(',') || '-'}`
      + ` raw=${d.rawKeys} try=${d.tried} sent=${c.sent} drop=${c.dropped} ack=${ack}`
      + (d.lockError ? ` | POINTER LOCK REFUSED: ${d.lockError}` : '');
  }
}

const yn = (b: boolean) => (b ? 'yes' : 'no');
