/**
 * App entry: load asset packs + a region file, mesh it, fly around it.
 *
 * Two input paths:
 *  - production: drag-and-drop / File System Access API. No server component.
 *  - dev: `?auto=1` pulls the reference world and mod jars through the Vite dev
 *    server's read-only mount, so the renderer can be exercised without hand-dropping
 *    128 jars every reload.
 */

import { PackStack, ZipPack } from '../assets/pack.js';
import { TextureAtlas } from '../render/atlas.js';
import { BiomeColors } from '../render/biome.js';
import { BlockRegistry } from '../render/registry.js';
import {
  makeContext, meshSection, type MeshContext, type StateSource,
} from '../render/mesher.js';
import { UNLOAD_DISTANCE, Viewer } from '../render/viewer.js';
import { World } from '../render/world.js';
import { RegionFile } from '../core/region.js';
import { decodeContraption, isContraptionId, meshBlockSet, classifyEntity } from '../render/entities.js';
import {
  buildEntityQuads, entityYawDeg, loadEntityModels, meshEntityQuads,
  type EntityMesh, type EntityModelSet,
} from '../render/entity-geometry.js';
import type { NbtCompound, NbtList } from '../core/nbt.js';
import { FlyControls } from './controls.js';
import { ShaderView } from './shader-view.js';
import { loadServedAssets, type ServedAssets } from '../render/served-assets.js';
import { BakeRefresh } from './bake-refresh.js';
import { PLAYER_TYPE, withPlayerModel } from '../render/player-model.js';
import { JoinButton } from './join-button.js';
import { LiveView } from './live-view.js';
import { fetchSpawn, type SpawnPoint } from './world-spawn.js';
import { ChunkStreamer, parseStreamParam } from './chunk-stream.js';
import { httpRangeFetch } from './region-sync.js';
import type { ChunkColumn } from '../render/world.js';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const joinButton = new JoinButton({
  button: document.getElementById('join') as HTMLButtonElement,
  why: document.getElementById('join-why') as HTMLDivElement,
  onJoin: () => live?.join(),
  onLeave: () => live?.leave(),
});

/**
 * The camera-mode toggle.
 *
 * Deliberately a BUTTON and not a URL flag: it is a way to look at the world, not a
 * deployment choice, and a flag would mean reloading the page — which on this app means
 * re-fetching the bake, re-meshing a region and re-joining the server — to change your
 * mind about a camera angle.
 *
 * Only shown while a character is actually being driven. There is nothing for an
 * isometric camera to centre on otherwise, and a button that frames empty air is the same
 * kind of lie as controls that accept input and drop it.
 */
const modeButton = document.getElementById('mode') as HTMLButtonElement;
modeButton.addEventListener('click', () => toggleCamera());

/**
 * V also toggles it, because on a desktop THE BUTTON IS UNREACHABLE EXACTLY WHEN YOU WANT
 * IT. Playing in first person means the canvas holds the pointer lock, and a locked
 * pointer is captured by the canvas — measured here: with the lock held, a click on this
 * button never reaches it. You would have to press Escape, leave the game, then click. A
 * key is delivered either way.
 *
 * Bound on the window rather than inside LiveControls because LiveControls is UNBOUND in
 * isometric mode, and a shortcut that only works in one direction is worse than none.
 */
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat) return;
  if (live?.hud.typing) return;   // "v" belongs to the chat box while it is open
  toggleCamera();
});

/**
 * Follow a player: F cycles through everyone on screen and off the end again, Escape lets
 * go. Two ways out rather than one, because this is a camera lock and a camera lock you
 * cannot escape is the worst thing on this page — and Escape is also what a browser hands
 * you when it drops the pointer lock, so the two gestures already mean "give me the view
 * back".
 *
 * Bound on the window, next to the camera toggle, for the same reason that one is: the
 * canvas may hold the pointer lock, and a locked pointer never delivers a click to a button.
 */
addEventListener('keydown', (e) => {
  if (!live || live.hud.typing || e.repeat) return;
  if (e.code === 'KeyF') live.followNext();
  else if (e.code === 'Escape') live.stopFollow();
});

function toggleCamera() {
  live?.toggleCameraMode();
  renderModeButton();
}

function renderModeButton() {
  const joined = live?.client.control?.joined === true;
  modeButton.hidden = !joined;
  const iso = live?.cameraMode === 'iso';
  modeButton.textContent = iso ? 'First person' : 'Isometric';
  modeButton.classList.toggle('iso', iso);
}

function status(msg: string) {
  console.log('[mcwv]', msg);
  log.textContent = msg;
}

const viewer = new Viewer(canvas);
const controls = new FlyControls(viewer.camera, canvas);
const world = new World();
let ctx: MeshContext | null = null;
let stack: PackStack | null = null;
/**
 * Widened to the capability the renderer actually needs, because it is satisfied either by
 * a `BlockRegistry` built from jars in the browser or by a bundle baked on the server.
 */
let registry: StateSource | null = null;
let live: LiveView | null = null;
/**
 * True once live mode is starting. It moves save-file entity drawing off the static path
 * (which draws mobs ONCE, at their load positions) and onto `LiveEntities`, which re-reads
 * and interpolates them — so the two must not both draw, or every mob is on screen twice.
 */
let observing = false;
/**
 * Looks for a newer bake while the one on screen lacks states the world has. Null on the
 * jar path, where there is no bake to refresh.
 */
let bakeRefresh: BakeRefresh | null = null;
/**
 * WebGPU shaderpack path. Null until `?shaders=<pack>` asks for it AND it initialises;
 * everything downstream checks `shaders?.active`, so a failure anywhere leaves the
 * ordinary three.js renderer on screen rather than a black page.
 */
let shaders: ShaderView | null = null;
let shaderBundle: import('../shaders/bundle.js').ShaderBundle | null = null;

/**
 * Chunk streaming (chunk-stream.ts): the world arrives nearest-first around the camera
 * over Range requests instead of as whole region files. ON by default; `?stream=0` restores
 * the whole-region load (which drag-and-drop and the jar path still use), `?stream=<n>`
 * sets the load radius in chunks. Null when streaming is off or has not started.
 */
let streamer: ChunkStreamer | null = null;
const streamParam = parseStreamParam(new URLSearchParams(location.search).get('stream'));

/**
 * Bring up the shaderpack path if `?shaders=<pack>` asked for it.
 *
 * Deliberately never throws: the pack is an enhancement, and every failure mode here
 * (no bundle served, no WebGPU, a pack that will not compile) has to leave the world
 * viewer working.
 */
async function startShaders(): Promise<void> {
  const want = new URLSearchParams(location.search).get('shaders');
  if (want === null) return;
  const id = want || 'sildurs-lite';
  status(`loading shaderpack ${id}...`);
  shaderBundle = await ShaderView.fetchBundle(id);
  if (!shaderBundle) {
    status(`shaderpack ${id} not served — run 'npm run build-shaderpack'`);
    shaderBundle = null;
    return;
  }
  shaders = await ShaderView.create(shaderBundle, canvas);
  if (!shaders.active) status(`shaderpack inactive: ${shaders.reason}`);
  // Escape hatch: a pipeline that builds but renders wrongly must not trap the viewer
  // behind a broken canvas with no way back to the renderer that works.
  addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') shaders?.toggle();
  });
}
/** The offline Java-model extraction, once fetched. Null means "no mob geometry". */
let entityModels: EntityModelSet | null = null;

/** Diagnostics surfaced in the HUD and reused by the coverage report. */
const diag = {
  packs: 0,
  chunks: 0,
  sections: 0,
  meshMs: 0,
  atlasSprites: 0,
  atlasMissing: 0,
  unresolved: 0,
  biomes: 0,
  queued: 0,
  /** queued sections within NEAR_BLOCKS of the camera; 0 means the near view is complete */
  nearQueued: 0,
  /** queued sections not buried below the surface; 0 means everything in view is meshed */
  visibleQueued: 0,
  entities: 0,
  contraptions: 0,
  contraptionBlocks: 0,
  /** entity instances drawn from extracted Java models (mobs), and how many types that is */
  entitiesDrawn: 0,
  entityTypesDrawn: 0,
  entityQuads: 0,
  entitiesByStrategy: {} as Record<string, number>,
};

async function buildPacks(files: Array<{ name: string; data: Uint8Array }>) {
  const s = new PackStack();
  // Vanilla first (lowest priority), then mods, then resource packs.
  const vanilla = files.filter((f) => /client.*\.jar$/i.test(f.name));
  const mods = files.filter((f) => !vanilla.includes(f) && f.name.endsWith('.jar'));
  const packs = files.filter((f) => f.name.endsWith('.zip'));
  let n = 0;
  for (const group of [vanilla, mods, packs]) {
    for (const f of group) {
      try {
        s.add(ZipPack.fromZip(f.name, f.data));
        n++;
      } catch (e) {
        console.warn(`skipped ${f.name}: ${(e as Error).message}`);
      }
    }
  }
  diag.packs = n;
  return s;
}

/** Region files actually ingested, whichever path got them here. Live mode watches these. */
const loadedRegions = new Set<string>();

async function loadRegion(data: Uint8Array, name: string) {
  const coords = RegionFile.parseName(name) ?? { x: 0, z: 0 };
  const region = new RegionFile(data, coords.x, coords.z);
  loadedRegions.add(name);
  let loaded = 0;
  for (const e of region.entries()) {
    try {
      const root = region.chunk(e.localX, e.localZ);
      if (!root) continue;
      world.addChunk(root);
      loaded++;
    } catch (err) {
      console.warn(`chunk ${e.localX},${e.localZ}:`, (err as Error).message);
    }
  }
  diag.chunks += loaded;
  status(`loaded ${loaded} chunks from ${name} (${world.palette.length} distinct states)`);
  return coords;
}

/**
 * Only the states this world actually contains need baking; that keeps startup
 * proportional to the world, not to the 128-jar asset surface.
 *
 * Contraption blocks live ONLY inside entity NBT and never appear in a chunk section
 * palette, so they must be collected here too — otherwise their sprites are missing
 * from the atlas and every contraption quad is silently dropped at mesh time.
 */
function collectStateKeys(): Set<string> {
  const stateKeys = new Set<string>(world.palette);
  for (const ent of pendingEntities) {
    if (!isContraptionId((ent.id as string) ?? '')) continue;
    const c = decodeContraption(ent);
    if (!c) continue;
    for (const b of c.blocks) stateKeys.add(b.stateKey);
  }
  return stateKeys;
}

/** Block names the loaded chunks have block entities for — the painted-surface rule's input. */
function blockEntityBlocksInWorld(): Set<string> {
  const out = new Set<string>();
  for (const col of world.chunks.values()) {
    for (const be of col.blockEntities.values()) if (typeof be.id === 'string') out.add(be.id);
  }
  return out;
}

async function prepare() {
  if (!stack) throw new Error('no asset packs loaded');
  status('resolving block models...');
  const reg = new BlockRegistry(stack, { blockEntityBlocks: blockEntityBlocksInWorld() });
  registry = reg;

  const sprites = reg.spritesFor(collectStateKeys());
  diag.unresolved = reg.unresolved.size;

  // Same reason for mobs: their textures live under textures/entity/, so no block state
  // ever names them and they would be absent from the atlas at mesh time.
  for (const s of entityModels?.spriteIds(entityTypesInWorld()) ?? []) sprites.add(s);

  status(`building atlas (${sprites.size} sprites)...`);
  const atlas = await TextureAtlas.build(stack, sprites);
  diag.atlasSprites = atlas.sprites.size;
  diag.atlasMissing = atlas.missing.size;
  viewer.setAtlas(atlas);

  // Only now is it known which entity textures actually resolved. A type whose texture no
  // jar supplies must keep counting as NOT rendered rather than drawing invisible quads.
  entityModels?.useTextureFilter((id) => atlas.sprites.has(id));

  status('loading biome colours...');
  const biomes = await BiomeColors.load(stack);
  diag.biomes = biomes.count;

  ctx = makeContext(world, registry, atlas, biomes);
  // `mc_Entity.x` is a PACK-defined id, so the mesher can only emit it once the pack is
  // known — which is why the bundle is fetched before anything is meshed.
  if (shaderBundle) ctx.blockIdOf = ShaderView.blockIds(shaderBundle);
  shaders?.setAtlas(atlas);
  (globalThis as Record<string, unknown>).__mcwv = {
    world, registry, atlas, biomes, diag, viewer, controls, pendingEntities,
    shaders: () => shaders?.status(),
  };
}

/**
 * Streaming mesher.
 *
 * Meshing every section of a region up front costs ~18s and produces millions of quads
 * that are underground and will never be seen. Instead we keep a work queue sorted by
 * distance to the camera and spend a fixed time budget per frame on it, so the first
 * visible geometry appears almost immediately and the rest fills in while you fly.
 */
interface MeshJob { cx: number; cy: number; cz: number; d2: number }
const pending: MeshJob[] = [];
/** `cx,cy,cz` of every job in `pending`, so a section is never queued twice */
const pendingKeys = new Set<string>();
/** set when jobs were pushed out of order; sorted once, at the next pump */
let pendingUnsorted = false;
let queueBuiltFor = { x: Infinity, z: Infinity };
const MESH_BUDGET_MS = 8;
/**
 * While sections THIS close to the camera are still waiting, the budget triples. The
 * streaming load is judged by when the view around the camera is complete, and 8 ms a
 * frame is a fine steady-state rate that makes a poor opening one.
 */
const NEAR_BLOCKS = 96;
const NEAR_BUDGET_MS = 24;
/** sections further than this (in blocks) are not meshed at all */
const MESH_RADIUS = 256;
/**
 * Added to the sort key of a section buried under its column's surface while the camera is
 * above that surface. Larger than MESH_RADIUS squared, so every section that could be in
 * view is meshed before any that cannot: from the air, the 15 underground sections of a
 * column are three quarters of the meshing work and none of the picture. They still mesh
 * (caves seen through an opening fill in last), and a camera that goes underground
 * re-queues without the penalty on its next rebuild.
 */
const BURIED_PENALTY = 400 * 400;

function sectionD2(cx: number, cy: number, cz: number): number {
  const cam = viewer.camera.position;
  const dx = cx * 16 + 8 - cam.x;
  const dy = cy * 16 + 8 - cam.y;
  const dz = cz * 16 + 8 - cam.z;
  return dx * dx + dy * dy + dz * dz;
}

function pushJob(cx: number, cy: number, cz: number, d2: number): void {
  const key = `${cx},${cy},${cz}`;
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);
  pending.push({ cx, cy, cz, d2 });
  pendingUnsorted = true;
}

function rebuildQueue() {
  if (!ctx) return;
  const cam = viewer.camera.position;
  pending.length = 0;
  pendingKeys.clear();
  for (const col of world.chunks.values()) enqueueColumn(col, false);
  pending.sort((a, b) => b.d2 - a.d2); // pop() takes the nearest
  pendingUnsorted = false;
  queueBuiltFor = { x: cam.x, z: cam.z };
  // The camera has moved: sections it left far behind are disposed, and will be re-queued
  // by a later rebuild if it comes back within MESH_RADIUS of them.
  viewer.dropSectionsBeyond(UNLOAD_DISTANCE);
}

/**
 * Queue a column's unmeshed sections. Called for every column on a rebuild and, on the
 * streaming path, for each column as it arrives — so meshing starts the moment the first
 * chunk lands rather than after the last one.
 *
 * `withNeighbours` also re-queues the ALREADY MESHED sections of the eight surrounding
 * columns at the same heights. They were built while this column was absent, so their
 * faces toward it were left uncovered and lit as open sky; a column arriving at the edge
 * of the load radius would otherwise leave a bright seam that never heals.
 */
function enqueueColumn(col: ChunkColumn, withNeighbours: boolean): void {
  const r2 = MESH_RADIUS * MESH_RADIUS;
  const top = topSection(col);
  const camY = viewer.camera.position.y;
  for (const sy of col.sections.keys()) {
    const d2 = sectionD2(col.x, sy, col.z);
    if (d2 > r2) continue;
    const buried = sy < top - 1 && camY > (sy + 1) * 16;
    if (!viewer.hasSection(`${col.x},${sy},${col.z}`)) pushJob(col.x, sy, col.z, buried ? d2 + BURIED_PENALTY : d2);
    if (!withNeighbours) continue;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nx = col.x + dx;
        const nz = col.z + dz;
        if (viewer.hasSection(`${nx},${sy},${nz}`)) pushJob(nx, sy, nz, sectionD2(nx, sy, nz));
      }
    }
  }
}

/** The highest section of a column holding anything but air; -Infinity for an empty column. */
function topSection(col: ChunkColumn): number {
  let top = -Infinity;
  for (const s of col.sections.values()) if ((s.ids || s.uniform !== 0) && s.y > top) top = s.y;
  return top;
}

/**
 * Whether a section may be meshed yet. Face culling, AO and smooth lighting all read the
 * neighbouring columns, so on the streaming path a section waits until the eight around
 * it have either arrived or are known not to be coming (absent, out of range, unreadable).
 * Without streaming everything is loaded up front and nothing waits.
 */
function neighboursSettled(cx: number, cz: number): boolean {
  if (!streamer) return true;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if ((dx || dz) && !streamer.isSettled(cx + dx, cz + dz)) return false;
    }
  }
  return true;
}

/** Follow the camera: tell the streamer, re-sort a queue pushed to out of order, rebuild a stale one. */
function maintainQueue(): void {
  const cam = viewer.camera.position;
  streamer?.setCamera(cam.x, cam.z);
  // Re-sort when the camera has moved far enough that the ordering is stale.
  const moved = Math.hypot(cam.x - queueBuiltFor.x, cam.z - queueBuiltFor.z);
  if (moved > 48) rebuildQueue();
  else if (pendingUnsorted) {
    pending.sort((a, b) => b.d2 - a.d2);
    pendingUnsorted = false;
  }
}

function meshBudgetMs(): number {
  const nearest = pending[pending.length - 1];
  return nearest && nearest.d2 < NEAR_BLOCKS * NEAR_BLOCKS ? NEAR_BUDGET_MS : MESH_BUDGET_MS;
}

function pumpMeshing() {
  if (!ctx) return;
  maintainQueue();
  const start = performance.now();
  const deadline = start + meshBudgetMs();
  const deferred: MeshJob[] = [];
  let done = 0;
  while (pending.length && performance.now() < deadline) {
    const job = pending.pop()!;
    if (world.getChunk(job.cx, job.cz) && !neighboursSettled(job.cx, job.cz)) { deferred.push(job); continue; }
    if (meshJob(job)) done++;
  }
  // Deferred jobs were popped nearest-first, so putting them back on top keeps the order.
  for (let i = deferred.length - 1; i >= 0; i--) pending.push(deferred[i]);
  if (done) diag.meshMs = performance.now() - start;
  diag.queued = pending.length;
  diag.nearQueued = queuedUnder(NEAR_BLOCKS * NEAR_BLOCKS);
  diag.visibleQueued = queuedUnder(BURIED_PENALTY);
}

/**
 * Queued sections whose sort key is under `d2` — under NEAR_BLOCKS squared: "is the view
 * around the camera complete yet"; under BURIED_PENALTY: "is everything that can be seen
 * from here meshed yet". The queue is sorted, so this walks only the head.
 */
function queuedUnder(d2: number): number {
  let n = 0;
  for (let i = pending.length - 1; i >= 0 && pending[i].d2 < d2; i--) n++;
  return n;
}

/** Mesh one queued section; false when its column has been unloaded meanwhile. */
function meshJob(job: MeshJob): boolean {
  pendingKeys.delete(`${job.cx},${job.cy},${job.cz}`);
  if (!ctx || !world.getChunk(job.cx, job.cz)) return false;
  const mesh = meshSection(ctx, job.cx, job.cy, job.cz);
  if (mesh) {
    viewer.addSection(mesh);
    shaders?.addSection(mesh);
    diag.sections++;
  }
  return true;
}

/** Entities live in a parallel `entities/r.X.Z.mca` region since 1.17. */
const pendingEntities: NbtCompound[] = [];

async function loadEntityRegion(data: Uint8Array, name: string) {
  const coords = RegionFile.parseName(name) ?? { x: 0, z: 0 };
  const region = new RegionFile(data, coords.x, coords.z);
  for (const e of region.entries()) {
    let root;
    try {
      root = region.chunk(e.localX, e.localZ);
    } catch {
      continue;
    }
    if (!root) continue;
    for (const raw of ((root.Entities as NbtList) ?? [])) {
      pendingEntities.push(raw as NbtCompound);
      diag.entities++;
    }
  }
}

/**
 * Distinct entity type ids across every loaded entity region, plus the player.
 *
 * The player is added unconditionally rather than only in live mode: this set is what the
 * atlas is built from, and the atlas is built long before the bridge has said whether
 * anybody is online. One 64x64 sprite is a cheaper price than a player who appears
 * untextured because they logged in after the atlas was packed.
 */
function entityTypesInWorld(): Set<string> {
  const out = new Set<string>([PLAYER_TYPE]);
  for (const ent of pendingEntities) out.add((ent.id as string) ?? '?');
  return out;
}

/** The extracted models with the player row grafted on; null if the extraction is absent. */
async function loadModelsWithPlayer() {
  const set = await loadEntityModels().catch((e) => {
    console.warn('entity models unavailable:', (e as Error).message);
    return null;
  });
  return set ? withPlayerModel(set) : null;
}

/**
 * Tally strategies. Deliberately not done at load time: 'extracted-model' depends on the
 * texture having made it into the atlas, which is not known until prepare() has run.
 */
function countEntityStrategies() {
  diag.entitiesByStrategy = {};
  for (const ent of pendingEntities) {
    const s = classifyEntity((ent.id as string) ?? '?', entityModels ?? undefined);
    diag.entitiesByStrategy[s] = (diag.entitiesByStrategy[s] ?? 0) + 1;
  }
}

function entityPos(ent: NbtCompound): [number, number, number] {
  const p = ent.Pos as NbtList | undefined;
  return Array.isArray(p) ? [Number(p[0]), Number(p[1]), Number(p[2])] : [0, 0, 0];
}

/** `Rotation` is [yaw, pitch]; only the body yaw affects a static pose. */
function entityYaw(ent: NbtCompound): number {
  const r = ent.Rotation as NbtList | undefined;
  return Array.isArray(r) ? Number(r[0]) : 0;
}

function renderEntities() {
  if (!ctx || !registry) return;
  const contraptions = renderContraptions(registry, ctx.atlas);
  const mobs = renderExtractedModels(ctx.atlas);
  countEntityStrategies();
  if (contraptions || mobs) {
    status(
      `rendered ${contraptions} contraptions (${diag.contraptionBlocks} blocks)` +
        ` and ${mobs} entities of ${diag.entityTypesDrawn} types`,
    );
  }
}

/**
 * Render contraptions. A Create contraption is a palette + block list embedded in the
 * entity NBT, so it goes through the ordinary block registry and mesher under one
 * entity transform — no Create-specific geometry code involved.
 */
function renderContraptions(reg: StateSource, atlas: TextureAtlas): number {
  let n = 0;
  for (const ent of pendingEntities) {
    const id = (ent.id as string) ?? '';
    if (!isContraptionId(id)) continue;
    const c = decodeContraption(ent);
    if (!c || !c.blocks.length) continue;
    const mesh = meshBlockSet(c.blocks, reg, atlas);
    if (!mesh.quadCount) continue;
    viewer.addEntityMesh(`entity:${id}:${n}`, mesh.layers, {
      pos: c.pos,
      angleDeg: c.angle,
      axis: c.axis,
    });
    diag.contraptions++;
    diag.contraptionBlocks += c.blocks.length;
    n++;
  }
  return n;
}

/**
 * Render mobs from the offline Java-model extraction.
 *
 * Meshing is cached per entity TYPE: every chicken in the world is the same bind-pose
 * geometry under a different transform, so the world's few dozen types are meshed once
 * and the buffers reused across hundreds of instances. Only the static bind pose is
 * drawn — `setupAnim` (walk cycles, head tracking, the spider's splayed legs) is animation
 * state we do not have.
 */
function renderExtractedModels(atlas: TextureAtlas): number {
  const models = entityModels;
  if (!models) return 0;
  // In live mode LiveEntities owns every save-file entity, drawing it live and interpolated;
  // drawing them statically here as well would leave a frozen duplicate under each one.
  if (observing) return 0;
  const meshes = new Map<string, EntityMesh | null>();
  const typesDrawn = new Set<string>();
  let n = 0;

  for (const ent of pendingEntities) {
    const id = (ent.id as string) ?? '';
    if (classifyEntity(id, models) !== 'extracted-model') continue;
    const mesh = cachedEntityMesh(meshes, models, id, atlas);
    if (!mesh) continue;
    viewer.addEntityMesh(`mob:${id}:${n}`, mesh.layers, {
      pos: entityPos(ent),
      angleDeg: entityYawDeg(entityYaw(ent)),
      axis: 'Y',
    });
    typesDrawn.add(id);
    diag.entityQuads += mesh.quadCount;
    n++;
  }

  diag.entitiesDrawn = n;
  diag.entityTypesDrawn = typesDrawn.size;
  return n;
}

/** Build-once-per-type memo; null means "this type produced nothing drawable". */
function cachedEntityMesh(
  cache: Map<string, EntityMesh | null>,
  models: EntityModelSet,
  id: string,
  atlas: TextureAtlas,
): EntityMesh | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const quads = buildEntityQuads(models, id, atlas);
  const mesh = quads ? meshEntityQuads(quads, atlas) : null;
  const usable = mesh && mesh.quadCount ? mesh : null;
  cache.set(id, usable);
  return usable;
}

/** How far back from the world spawn the camera opens; a settlement, not one block. */
const SPAWN_VIEW_DIST = 20;

/**
 * Open on an explicit `?at=x,y,z[,dist]` (reproducible screenshots of a specific feature),
 * else on the world's own spawn point from level.dat, else — a world with no readable
 * spawn — just above the highest solid block of the first chunk loaded.
 */
function placeCamera(firstRegion?: string) {
  const target = cameraTarget();
  if (target) {
    const { x, y, z, dist, yaw } = target;
    // yaw is the compass bearing the camera sits at, in degrees clockwise from +Z (south),
    // so 45 is the historical "+X +Z" corner and 225 looks at a block's north-west faces.
    const r = dist * Math.SQRT2;
    const a = (yaw * Math.PI) / 180;
    viewer.camera.position.set(x + r * Math.sin(a), y + dist * 0.5, z + r * Math.cos(a));
    controls.lookAt(x, y, z);
    controls.speed = 10;
    return;
  }
  const p = highestLoadedSurface() ?? regionCentre(firstRegion) ?? { x: 0, y: 120, z: 0 };
  viewer.camera.position.set(p.x, p.y, p.z);
  // FlyControls owns the camera rotation, so seed its yaw/pitch rather than calling
  // camera.lookAt (which the next controls.update would immediately overwrite).
  controls.lookAt(p.x + 40, p.y - 25, p.z + 40);
}

/** Just above the highest non-air section of the first loaded chunk; null with none loaded. */
function highestLoadedSurface(): { x: number; y: number; z: number } | null {
  for (const col of world.chunks.values()) {
    for (let sy = 20; sy >= -4; sy--) {
      const s = col.sections.get(sy);
      if (!s) continue;
      if (!s.ids && s.uniform === 0) continue;
      return { x: col.x * 16 + 8, y: sy * 16 + 40, z: col.z * 16 + 8 };
    }
  }
  return null;
}

/**
 * The middle of a region. On the streaming path nothing is loaded when the camera is
 * placed, so with no spawn and no `?at=` it opens over the first served region, not 0,0.
 */
function regionCentre(name?: string): { x: number; y: number; z: number } | null {
  const rc = name ? RegionFile.parseName(name) : null;
  return rc ? { x: rc.x * 512 + 256, y: 120, z: rc.z * 512 + 256 } : null;
}

interface CameraTarget { x: number; y: number; z: number; dist: number; yaw: number }

/** `?at=` wins over the world spawn; null means neither is usable. */
function cameraTarget(): CameraTarget | null {
  const at = new URLSearchParams(location.search).get('at');
  if (at) return parseAt(at);
  return worldSpawn ? { ...worldSpawn, dist: SPAWN_VIEW_DIST, yaw: 45 } : null;
}

/** `x,y,z[,dist[,yaw]]` from the URL; null when it is not three numbers. */
function parseAt(at: string): CameraTarget | null {
  const n = at.split(',').map(Number);
  if (n.length < 3 || n.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  return {
    x: n[0], y: n[1], z: n[2],
    dist: Number.isFinite(n[3]) ? n[3] : 12,
    yaw: Number.isFinite(n[4]) ? n[4] : 45,
  };
}

/** The world's spawn point, read once at boot from the served level.dat; null if unreadable. */
let worldSpawn: SpawnPoint | null = null;

// ---------------------------------------------------------------------------
// Input paths

interface DevManifest {
  jars: string[];
  regions: string[];
  entityRegions?: string[];
}

async function fetchManifest(): Promise<DevManifest> {
  return (await (await fetch('/dev/manifest.json')).json()) as DevManifest;
}

/** Fetch and unzip the asset packs. Shared by save-file mode and live mode. */
async function loadPacksFromManifest(manifest: DevManifest) {
  const files: Array<{ name: string; data: Uint8Array }> = [];
  let i = 0;
  for (const jar of manifest.jars) {
    status(`fetching jars ${++i}/${manifest.jars.length}...`);
    const r = await fetch('/dev/jar/' + encodeURIComponent(jar));
    if (!r.ok) continue;
    files.push({ name: jar, data: new Uint8Array(await r.arrayBuffer()) });
  }
  status(`unzipping ${files.length} packs...`);
  stack = await buildPacks(files);
}

/**
 * Preferred path: assets baked on the server.
 *
 * The jar path below still works and is what drag-and-drop uses, but it makes the browser
 * fetch every jar (~476 MB for the reference set) and redo the whole asset pipeline on
 * every load. When a bake is served, this fetches ~224 KB instead and the renderer is
 * otherwise identical.
 */
async function autoLoadBaked(): Promise<boolean> {
  status('fetching baked assets...');
  const baked = await loadServedAssets(['/baked']);
  if (!baked) return false;

  diag.packs = 0;
  registry = baked.registry;
  status(`baked assets: ${baked.stateCount} states, ${baked.atlas.sprites.size} sprites`);

  if (streamParam.enabled) {
    await startStreaming(baked);
    return true;
  }

  for (const rg of baked.regions) {
    const r = await fetch('/dev/region/' + encodeURIComponent(rg));
    if (!r.ok) continue;
    await loadRegion(new Uint8Array(await r.arrayBuffer()), rg);
  }
  for (const rg of baked.regions) {
    const r = await fetch('/dev/entities/' + encodeURIComponent(rg));
    if (!r.ok) continue;
    await loadEntityRegion(new Uint8Array(await r.arrayBuffer()), rg);
  }

  await startShaders();
  status('loading extracted entity models...');
  entityModels = await loadModelsWithPlayer();

  applyBaked(baked);
  bakeRefresh = new BakeRefresh(baked.generated);

  placeCamera();
  renderEntities();
  rebuildQueue();
  return true;
}

/**
 * The streaming load. Everything that does not need the world is set up first (bake,
 * shaders, mob models, camera), then the streamer reads the 8 KB index of each region
 * and starts fetching around the camera; each chunk is added to the world and its
 * sections queued for meshing as it lands. The entity regions (under 1 MB) load in
 * parallel and draw when they are done rather than holding up the first frame.
 */
async function startStreaming(baked: ServedAssets): Promise<void> {
  await startShaders();
  status('loading extracted entity models...');
  entityModels = await loadModelsWithPlayer();
  applyBaked(baked);
  bakeRefresh = new BakeRefresh(baked.generated);
  for (const rg of baked.regions) loadedRegions.add(rg);
  placeCamera(baked.regions[0]);

  const t0 = performance.now();
  let reported = false;
  const s = new ChunkStreamer(baked.regions, {
    fetchRange: httpRangeFetch('/dev/region'),
    onChunk: (root, cx, cz) => {
      let col: ChunkColumn;
      try {
        col = world.addChunk(root);
      } catch (err) {
        console.warn(`chunk ${cx},${cz}:`, (err as Error).message);
        return;
      }
      diag.chunks = world.chunks.size;
      enqueueColumn(col, true);
      live?.noteColumn(col);
    },
    onUnload: (cx, cz) => {
      const col = world.getChunk(cx, cz);
      if (col) for (const sy of col.sections.keys()) viewer.removeSection(`${cx},${sy},${cz}`);
      world.removeChunk(cx, cz);
      diag.chunks = world.chunks.size;
    },
    onProgress: (st) => {
      if (reported || st.queued || st.inFlight) return;
      reported = true;
      status(`streamed ${st.fetched} chunks (${(st.bytes / 1048576).toFixed(1)} MB, ${st.requests} requests)`
        + ` in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    },
  }, streamParam.loadRadius ? { loadRadius: streamParam.loadRadius, unloadRadius: streamParam.loadRadius + 8 } : {});
  streamer = s;
  (globalThis as Record<string, unknown>).__mcwvStream = { stats: () => ({ ...s.stats }), streamer: s };
  const cam = viewer.camera.position;
  status(`streaming chunks around ${cam.x.toFixed(0)},${cam.z.toFixed(0)}...`);
  await s.start(cam.x, cam.z);

  void Promise.all(baked.regions.map(async (rg) => {
    const r = await fetch('/dev/entities/' + encodeURIComponent(rg)).catch(() => null);
    if (r?.ok) await loadEntityRegion(new Uint8Array(await r.arrayBuffer()), rg);
  })).then(() => renderEntities());
}

/** Make a served bundle THE bundle: registry, atlas, tints, mesh context, diagnostics. */
function applyBaked(baked: ServedAssets): void {
  registry = baked.registry;
  diag.unresolved = baked.registry.unresolved.size;
  diag.atlasSprites = baked.atlas.sprites.size;
  diag.atlasMissing = baked.atlas.missing.size;
  diag.biomes = baked.biomes.count;
  viewer.setAtlas(baked.atlas);
  entityModels?.useTextureFilter((id) => baked.atlas.sprites.has(id));

  ctx = makeContext(world, baked.registry, baked.atlas, baked.biomes);
  if (shaderBundle) ctx.blockIdOf = ShaderView.blockIds(shaderBundle);
  shaders?.setAtlas(baked.atlas);
  (globalThis as Record<string, unknown>).__mcwv = {
    world, registry: baked.registry, atlas: baked.atlas, biomes: baked.biomes,
    diag, viewer, controls, pendingEntities, baked: true, generated: baked.generated,
    shaders: () => shaders?.status(),
  };
}

/**
 * Adopt a newer bake IN PLACE.
 *
 * The bundle is a snapshot of the world's block inventory and a live world outgrows it: a
 * state the bake never saw is drawn as nothing, so a tower the turtles built after the
 * bake is simply not there. Once a re-bake lands, this swaps it in without a page reload —
 * a reload drops the camera and, in live mode, closes the socket, which despawns a bot
 * someone is driving.
 *
 * The world data is untouched by a re-bake; only the geometry is stale. But ALL of it is:
 * every mesh on screen was built against the old atlas and sprite rects move between
 * bakes, so every section and entity goes and the streaming mesher rebuilds them
 * nearest-first exactly as it did on load. A few seconds of filling in, then a complete
 * world.
 */
function swapBaked(next: ServedAssets): void {
  applyBaked(next);
  bakeRefresh?.adopt(next.generated);
  viewer.clear();
  diag.sections = 0;
  diag.contraptions = 0;
  diag.contraptionBlocks = 0;
  diag.entityQuads = 0;
  live?.invalidateMeshes();
  renderEntities();
  rebuildQueue();
  status(`bake refreshed: ${next.stateCount} states, ${next.atlas.sprites.size} sprites — re-meshing`);
}

/**
 * While the bundle on screen lacks states the world has, look for a newer one. The policy
 * in bake-refresh.ts decides WHEN (never while nothing is missing, backing off while
 * nothing changes); this only performs the fetch and the swap.
 */
function pollBakeRefresh(now: number): void {
  const r = bakeRefresh;
  if (!r || !r.due(now, registry?.missing?.size ?? 0)) return;
  r.inFlight = true;
  loadServedAssets(['/baked'], { fresh: true })
    .then((next) => {
      if (next && r.isNew(next.generated)) swapBaked(next);
    })
    .catch((e: unknown) => status(`bake refresh failed: ${(e as Error).message}`))
    .finally(() => { r.inFlight = false; });
}

async function autoLoad() {
  // Before either load path: both end in placeCamera(), which wants to know where the
  // world starts. A few hundred bytes of NBT, and null on any failure keeps the old fallback.
  worldSpawn = await fetchSpawn();
  if (await autoLoadBaked()) return;
  status('no baked assets served — falling back to fetching jars');
  const manifest = await fetchManifest();
  await loadPacksFromManifest(manifest);

  for (const rg of manifest.regions) {
    const r = await fetch('/dev/region/' + encodeURIComponent(rg));
    if (!r.ok) continue;
    await loadRegion(new Uint8Array(await r.arrayBuffer()), rg);
  }
  for (const rg of manifest.entityRegions ?? []) {
    const r = await fetch('/dev/entities/' + encodeURIComponent(rg));
    if (!r.ok) continue;
    await loadEntityRegion(new Uint8Array(await r.arrayBuffer()), rg);
  }
  await startShaders();
  // Must precede prepare(): the atlas has to include the mob textures.
  status('loading extracted entity models...');
  entityModels = await loadModelsWithPlayer();
  await prepare();
  placeCamera();
  renderEntities();
  rebuildQueue();
}

async function handleDrop(items: FileList) {
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const regions: Array<{ name: string; data: Uint8Array }> = [];
  for (const f of Array.from(items)) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (f.name.endsWith('.jar') || f.name.endsWith('.zip')) files.push({ name: f.name, data });
    else if (f.name.endsWith('.mca')) regions.push({ name: f.name, data });
  }
  if (files.length) {
    status(`unzipping ${files.length} packs...`);
    stack = await buildPacks(files);
  }
  for (const r of regions) await loadRegion(r.data, r.name);
  if (stack && regions.length) {
    await prepare();
    placeCamera();
    renderEntities();
    rebuildQueue();
  } else {
    status(
      `have ${files.length} packs, ${regions.length} regions — need at least one of each` +
        ' (drop the client jar + mod jars, then .mca files)',
    );
  }
}

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) void handleDrop(e.dataTransfer.files);
});

/**
 * Live mode.
 *
 * The world is loaded exactly as `?auto=1` loads it — baked assets, save-file regions —
 * and then a bridge socket is attached on top. It brings two things the save files alone
 * cannot: where the players are right now, and a notification that the server has written
 * changed chunks to disk so the region files are worth re-reading.
 *
 * The camera is NOT server-authoritative any more. You fly around a live world with the
 * ordinary controls; the previous version drove a server-side fake player, which required
 * a mod this server does not have (see live.ts).
 */
async function startObserving(url: string) {
  // Set BEFORE autoLoad: it tells renderEntities to leave the mobs to LiveEntities.
  observing = true;
  // The button appears before the world finishes loading, disabled, so it does not pop
  // into the layout later under a thumb already reaching for it.
  joinButton.render(null, true);
  await autoLoad();
  live = new LiveView(url, {
    world,
    viewer,
    getContext: () => ctx,
    getEntityModels: () => entityModels,
    getAtlas: () => ctx?.atlas ?? null,
    getStates: () => registry,
    regions: [...loadedRegions],
    regionBase: '/dev/region',
    entityRegions: [...loadedRegions],
    entityBase: '/dev/entities',
    bakedBase: '/baked',
    hudRoot: document.body,
    status,
    fly: controls,
    // Streaming: a flush only re-reads chunks that are on screen, and afterwards the
    // streamer re-reads its index so a chunk the flush moved in the file is not fetched
    // from its old offset.
    chunkFilter: streamer ? (cx, cz) => streamer!.isLoaded(cx, cz) : undefined,
    onSynced: streamer ? () => void streamer!.refreshIndex() : undefined,
    onIngest: streamer ? (cx, cz) => streamer!.noteLoaded(cx, cz) : undefined,
  });
  live.onControlChange = (control) => {
    joinButton.render(control, true);
    renderModeButton();
  };
  await live.start();
  (globalThis as Record<string, unknown>).__mcwvLive = live;
}

// ---------------------------------------------------------------------------
// Frame loop

/** The shader path reports its own pass count, because "it is on" and "it is working" are
 * different claims and the HUD should not conflate them. */
function shaderHud(shaderStats: { passesRun: number } | null): string {
  if (!shaderStats) return '';
  const skipped = shaders?.status().skipped.length ?? 0;
  return ` | SHADERS ${shaderBundle?.id} ${shaderStats.passesRun} passes`
    + (skipped ? ` (${skipped} skipped)` : '');
}

function worldHud(
  stats: { fps: number; drawCalls: number; triangles: number },
  shaderStats: { passesRun: number } | null,
): string {
  return `${stats.fps.toFixed(0)} fps | ${stats.drawCalls} draws | `
    + `${(stats.triangles / 1000).toFixed(0)}k tris | ${diag.sections} sections | `
    + `${diag.chunks} chunks | ${diag.packs} packs | ${diag.atlasSprites} sprites`
    + shaderHud(shaderStats)
    + (diag.entitiesDrawn ? ` | ${diag.entitiesDrawn} mobs` : '')
    + (diag.queued ? ` | ${diag.queued} queued` : '')
    + streamHud()
    + unresolvedHud()
    + (live?.hudLine() ?? '');
}

function streamHud(): string {
  const st = streamer?.stats;
  if (!st) return '';
  const busy = st.queued + st.inFlight;
  return busy ? ` | streaming ${busy}` : '';
}

/**
 * Read LIVE from the registry, not from the snapshot taken at load. States are resolved as
 * sections are meshed, so at load time the count is always zero — which is how a bundle
 * the world had outgrown by nine stone-brick states looked exactly like a complete one, on
 * a HUD that was built to say otherwise. The two numbers are kept apart because they have
 * different fixes: NOT IN BAKE means the bake predates the block (re-run it, or the baker
 * will); UNRESOLVED means no jar has a model for it at all.
 */
function unresolvedHud(): string {
  const missing = registry?.missing?.size ?? 0;
  const unresolved = (registry?.unresolved?.size ?? diag.unresolved) - missing;
  diag.unresolved = unresolved + missing;
  return (unresolved > 0 ? ` | ${unresolved} UNRESOLVED` : '')
    + (missing > 0
      ? ` | ${missing} NOT IN BAKE${bakeRefresh ? ' — waiting for a re-bake' : ''}`
      : '');
}

let panelTick = 0;
let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // When a fake player is being driven the camera is server-authoritative; otherwise the
  // ordinary fly controls own it. Live mode is the same page either way.
  if (!live?.updateCamera(dt)) controls.update(dt);
  // AFTER the camera has been moved by whoever owns it: players are interpolated between
  // 1 Hz samples here, and a follow lock translates the camera by the followed player's
  // movement on top of the input the user just gave. Doing it first would have the fly
  // controls overwrite the lock every frame, which presents as "follow does nothing".
  live?.updatePlayers();
  pumpMeshing();
  // Live re-meshes get their own budget: they are latency-sensitive in a way the
  // initial streaming load is not, and starving them behind a full region's backlog
  // is what makes a "live" view feel dead.
  live?.pump();
  pollBakeRefresh(now);

  const shaderStats = shaders?.active ? shaders.render(viewer.camera, dt) : null;
  // WebGPU reports validation errors asynchronously, so the panel has to be re-read
  // periodically rather than written once at startup.
  if (shaders && ++panelTick % 120 === 0) shaders.refreshPanel();
  viewer.cullByDistance();
  const stats = shaderStats ? viewer.statsOnly() : viewer.render();
  hud.textContent = worldHud(stats, shaderStats);
  requestAnimationFrame(frame);
}
frame();

const params = new URLSearchParams(location.search);

// LIVE IS THE DEFAULT. It used to need `?live`, and that was the wrong way round.
//
// The whole point of this viewer is to watch a running world and join it, so hiding that behind an
// opt-in flag meant the ordinary URL — and every link anyone actually shared — opened the static
// save-file renderer with no bot, no controls and no Join button, looking exactly like a build that
// had lost its play mode. There is nothing to discover here: if the bridge is reachable you want it.
//
// Opting OUT is now the explicit act, for the one case that genuinely wants it: reading region
// files with no server behind them. `?static`, or `?live=0`/`off`.
const liveParam = params.get('live');
const liveOff = params.has('static') || liveParam === '0' || liveParam === 'off';

if (!liveOff) {
  // Any non-URL value of `live` still means the bridge behind this same origin, which is what the
  // nginx `/live` proxy exists for — no second hostname, no second DNS record. Only an explicit
  // ws:// or wss:// overrides it; treating `?live=1` as a hostname produces a WebSocket error with
  // no hint as to why.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = /^wss?:\/\//.test(liveParam ?? '') ? liveParam! : `${scheme}://${location.host}/live`;
  startObserving(url).catch((e) => status('live mode failed: ' + (e as Error).message));
} else if (params.has('auto')) {
  autoLoad().catch((e) => status('autoload failed: ' + (e as Error).message));
} else {
  status('drop the vanilla client jar + mod jars + .mca region files here');
}
