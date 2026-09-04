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
import { Viewer } from '../render/viewer.js';
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

async function prepare() {
  if (!stack) throw new Error('no asset packs loaded');
  status('resolving block models...');
  const reg = new BlockRegistry(stack);
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
const pending: Array<{ cx: number; cy: number; cz: number; d2: number }> = [];
let queueBuiltFor = { x: Infinity, z: Infinity };
const MESH_BUDGET_MS = 8;
/** sections further than this (in blocks) are not meshed at all */
const MESH_RADIUS = 256;

function rebuildQueue() {
  if (!ctx) return;
  const cam = viewer.camera.position;
  pending.length = 0;
  for (const col of world.chunks.values()) {
    for (const sy of col.sections.keys()) {
      const key = `${col.x},${sy},${col.z}`;
      if (viewer.hasSection(key)) continue;
      const dx = col.x * 16 + 8 - cam.x;
      const dy = sy * 16 + 8 - cam.y;
      const dz = col.z * 16 + 8 - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > MESH_RADIUS * MESH_RADIUS) continue;
      pending.push({ cx: col.x, cy: sy, cz: col.z, d2 });
    }
  }
  pending.sort((a, b) => b.d2 - a.d2); // pop() takes the nearest
  queueBuiltFor = { x: cam.x, z: cam.z };
}

function pumpMeshing() {
  if (!ctx) return;
  const cam = viewer.camera.position;
  // Re-sort when the camera has moved far enough that the ordering is stale.
  const moved = Math.hypot(cam.x - queueBuiltFor.x, cam.z - queueBuiltFor.z);
  if (moved > 48) rebuildQueue();

  const deadline = performance.now() + MESH_BUDGET_MS;
  let done = 0;
  while (pending.length && performance.now() < deadline) {
    const job = pending.pop()!;
    const mesh = meshSection(ctx, job.cx, job.cy, job.cz);
    if (mesh) {
      viewer.addSection(mesh);
      shaders?.addSection(mesh);
      diag.sections++;
    }
    done++;
  }
  if (done) diag.meshMs = performance.now() - (deadline - MESH_BUDGET_MS);
  diag.queued = pending.length;
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

/**
 * Drop the camera just above the highest solid block near the region centre, or at an
 * explicit `?at=x,y,z[,dist]` for reproducible screenshots of a specific feature.
 */
function placeCamera() {
  const at = new URLSearchParams(location.search).get('at');
  if (at) {
    const n = at.split(',').map(Number);
    const dist = n[3] ?? 12;
    viewer.camera.position.set(n[0] + dist, n[1] + dist * 0.5, n[2] + dist);
    controls.lookAt(n[0], n[1], n[2]);
    controls.speed = 10;
    return;
  }
  let best: { x: number; y: number; z: number } | null = null;
  for (const col of world.chunks.values()) {
    for (let sy = 20; sy >= -4; sy--) {
      const s = col.sections.get(sy);
      if (!s) continue;
      if (!s.ids && s.uniform === 0) continue;
      best = { x: col.x * 16 + 8, y: sy * 16 + 40, z: col.z * 16 + 8 };
      break;
    }
    if (best) break;
  }
  const p = best ?? { x: 0, y: 120, z: 0 };
  viewer.camera.position.set(p.x, p.y, p.z);
  // FlyControls owns the camera rotation, so seed its yaw/pitch rather than calling
  // camera.lookAt (which the next controls.update would immediately overwrite).
  controls.lookAt(p.x + 40, p.y - 25, p.z + 40);
}

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
    bakedBase: '/baked',
    hudRoot: document.body,
    status,
    fly: controls,
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
    + unresolvedHud()
    + (live?.hudLine() ?? '');
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
