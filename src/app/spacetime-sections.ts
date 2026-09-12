/**
 * Terrain sections from SpacetimeDB into the renderer's `World`.
 *
 * The decoding and naming live in `spacetime-terrain.ts`; this is the part that talks to
 * the database, keeps the caches, and hands finished sections to `World.addLiveSection` —
 * the same entry point the RCON/save-file live path already uses, so the mesher, the atlas
 * and the registry cannot tell where a section came from.
 *
 * THE ONE GENUINELY AWKWARD PROBLEM, and how it is solved.
 *
 * `block_state.properties` omits properties at their default value, and the renderer needs
 * the full canonical key (see `spacetime-terrain.ts`). Working out a default needs to know a
 * property's whole DOMAIN — and the browser does not have the blockstate JSON to read it
 * from: by design it fetches a *baked* bundle of already-resolved geometry rather than 476 MB
 * of jars (`render/served-assets.ts`).
 *
 * But the bundle is keyed BY CANONICAL STATE KEY, which turns out to be a better domain
 * source than the JSON would have been:
 *
 *   domain(prop)  = every value of `prop` across the bundle's keys for that block
 *   non-defaults  = every value of `prop` the database ever spells out for that block
 *   default       = the one domain value left over
 *
 * and it is exactly right where it needs to be. The bake only contains states that are
 * actually present in the world, so a state whose default this cannot pin down is a state
 * that does not occur — and therefore never appears in a section palette either. The
 * failure is self-limiting rather than silent, and `stats.unnamed` counts it regardless.
 */

import type { World } from '../render/world.js';
import { StateNamer, unpackSection, type SectionRow, type StateRow } from './spacetime-terrain.js';

/** How often queued sections are drained. Sections arrive in bursts as chunks load. */
const DRAIN_MS = 120;
/** `WHERE id = a OR id = b ...` — SpacetimeDB has no `IN`, and a huge clause is refused. */
const ID_BATCH = 60;

export interface SectionHandle {
  onInsert(cb: (ctx: unknown, row: Record<string, unknown>) => void): void;
  onUpdate(cb: (ctx: unknown, o: Record<string, unknown>, r: Record<string, unknown>) => void): void;
  onDelete(cb: (ctx: unknown, row: Record<string, unknown>) => void): void;
  iter(): Iterable<Record<string, unknown>>;
}

export interface TerrainConnection {
  db: {
    chunkSection: SectionHandle;
    chunkLight?: SectionHandle;
    blockChange?: SectionHandle;
  };
  subscriptionBuilder(): { onApplied(cb: () => void): { subscribe(q: string[]): unknown } };
}

export interface SpacetimeTerrainDeps {
  world: World;
  /** run a SQL query against the module; rows as arrays, or null when it failed */
  sql: (query: string) => Promise<unknown[][] | null>;
  /** every canonical state key the baked bundle can render */
  bakedKeys: () => Iterable<string>;
  /** a section's contents changed: re-mesh it and its neighbours */
  onSection: (cx: number, cy: number, cz: number) => void;
  /**
   * One block changed, with the canonical state keys either side.
   *
   * Separate from `onSection` because a sound needs the exact block and both of its states,
   * which a section-level "something in here changed" cannot give — and because the block
   * that makes the noise is the one that LEFT on a break, not the air that replaced it.
   */
  onBlockChange?: (
    pos: [number, number, number], oldKey: string | null, newKey: string | null,
  ) => void;
  status: (msg: string) => void;
}

export class SpacetimeTerrain {
  private queue = new Map<string, SectionRow>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  /** block name -> its full state list, fetched once */
  private statesByBlock = new Map<string, StateRow[]>();
  private namer: StateNamer;
  /** canonical keys grouped by block name, built lazily from the bundle */
  private bakedByBlock: Map<string, string[]> | null = null;
  /**
   * Light per section, keyed `cx,sy,cz`.
   *
   * A MISSING ENTRY AND AN ENTRY OF ZEROES ARE DIFFERENT THINGS, and conflating them is the
   * one mistake this whole feature can make: missing means the producer has not said
   * anything yet and the section renders fully lit, while an entry of 2048 zero bytes is the
   * server saying a sealed cave really is pitch dark. Blacking out on "not said yet" makes
   * the world flash dark every time a chunk arrives before its light does.
   */
  private light = new Map<string, { block: Int8Array | null; sky: Int8Array | null }>();

  /** the raw rows of sections already built, so a late light row can re-mesh them */
  private built = new Map<string, Record<string, unknown>>();
  /** false until the initial snapshot has been taken, so history is not replayed as events */
  private liveFromNow = false;

  readonly stats = {
    sections: 0, cells: 0, unnamed: 0, blocks: 0, queued: 0,
    lit: 0, litSections: 0, bogus: 0, changes: 0,
  };

  constructor(private deps: SpacetimeTerrainDeps) {
    this.namer = new StateNamer(
      (block) => this.statesByBlock.get(block) ?? [],
      // Not a blockstate JSON: a synthetic one whose `variants` keys are the bundle's own
      // canonical keys for this block, which `domainsFromBlockstate` reads the same way.
      (block) => ({ variants: Object.fromEntries(
        (this.bakedFor(block)).map((props) => [props, {}])) }),
    );
  }

  attach(conn: TerrainConnection): void {
    const take = (_c: unknown, row: Record<string, unknown>) => this.enqueue(row);
    conn.db.chunkSection.onInsert(take);
    conn.db.chunkSection.onUpdate((_c, _o, row) => this.enqueue(row));
    const lights = conn.db.chunkLight;
    if (lights) {
      const takeLight = (_c: unknown, row: Record<string, unknown>) => this.absorbLight(row, true);
      lights.onInsert(takeLight);
      lights.onUpdate((_c, _o, row) => this.absorbLight(row, true));
    }
    // Block changes are for SOUND (and anything else that wants the exact block). Only
    // inserts: the table is append-only, so an insert IS the event. The initial snapshot is
    // deliberately not replayed — those changes already happened, some of them days ago,
    // and playing them all on connect would be a wall of noise.
    conn.db.blockChange?.onInsert((_c, row) => this.absorbBlockChange(row));
    conn.subscriptionBuilder()
      .onApplied(() => {
        // Light FIRST, so a section built in this same drain already has it and does not
        // have to be meshed once lit-by-default and again a moment later.
        for (const row of lights?.iter() ?? []) this.absorbLight(row, false);
        for (const row of conn.db.chunkSection.iter()) this.enqueue(row);
        this.liveFromNow = true;
        this.deps.status(
          `spacetime: ${this.queue.size} terrain sections, ${this.light.size} lit`);
      })
      .subscribe([
        'SELECT * FROM chunk_section',
        'SELECT * FROM chunk_light',
        'SELECT * FROM block_change',
      ]);
    this.timer = setInterval(() => void this.drain(), DRAIN_MS);
  }

  /**
   * Take one `chunk_light` row.
   *
   * `requeue` re-meshes a section that is already on screen, which is what makes light that
   * arrives after its section actually appear. On the initial snapshot it is off, because
   * every section is about to be built anyway.
   */
  private absorbLight(row: Record<string, unknown>, requeue: boolean): void {
    const cx = Number(row.cx);
    const cz = Number(row.cz);
    const sy = Number(row.sy);
    if (!sane(cx, cz, sy)) { this.stats.bogus++; return; }
    const block = toNibbles(row.blockLight);
    const sky = toNibbles(row.skyLight);
    if (!block && !sky) return;
    // THE TWO ARRAYS ARE INDEPENDENTLY PRESENT OR ABSENT, and substituting zeros for a
    // missing one is the same mistake as treating a missing ROW as darkness — just finer
    // grained. Measured on the live module: 9 of 159 rows carry full block light and an
    // EMPTY sky array (a section the server sent no sky data for). Filling that with zeros
    // made every such section pitch black under a sky that should have lit it.
    const key = `${cx},${sy},${cz}`;
    this.light.set(key, { block, sky });
    this.stats.lit = this.light.size;
    const existing = this.built.get(key);
    if (requeue && existing) this.enqueue(existing);
  }

  /**
   * One `block_change` row.
   *
   * The state ids are resolved through the same namer the terrain uses, so the keys handed
   * on are the renderer's canonical ones. An id the namer has not learned yet yields null
   * rather than a wrong name — a sound is not worth guessing a block for.
   */
  private absorbBlockChange(row: Record<string, unknown>): void {
    if (!this.liveFromNow || !this.deps.onBlockChange) return;
    const pos: [number, number, number] = [Number(row.x), Number(row.y), Number(row.z)];
    if (!pos.every(Number.isFinite)) return;
    if (!sane(pos[0] >> 4, pos[2] >> 4, pos[1] >> 4)) { this.stats.bogus++; return; }
    const oldId = Number(row.oldStateId);
    const newId = Number(row.newStateId);
    if (oldId === newId) return;
    this.stats.changes++;
    this.deps.onBlockChange(pos, this.keyOrNull(oldId), this.keyOrNull(newId));
  }

  private keyOrNull(id: number): string | null {
    if (!Number.isFinite(id)) return null;
    if (id === 0) return 'minecraft:air';
    return this.namer.knows(id) ? this.namer.keyOf(id) : null;
  }

  /** The light for a section, in the shape `addLiveSection` wants. Absent stays absent. */
  private lightFor(cx: number, sy: number, cz: number):
  { blockLight?: Int8Array; skyLight?: Int8Array } {
    const hit = this.light.get(`${cx},${sy},${cz}`);
    if (!hit) return {};
    this.stats.litSections++;
    const out: { blockLight?: Int8Array; skyLight?: Int8Array } = {};
    // Only what is actually known: an omitted key leaves World.getLight on its
    // "nobody has said" fallback, which is full sky rather than darkness.
    if (hit.block) out.blockLight = hit.block;
    if (hit.sky) out.skyLight = hit.sky;
    return out;
  }

  private enqueue(row: Record<string, unknown>): void {
    const cx = Number(row.cx);
    const cz = Number(row.cz);
    const sy = Number(row.sy);
    if (!sane(cx, cz, sy)) { this.stats.bogus++; return; }
    this.built.set(`${cx},${sy},${cz}`, row);
    this.queue.set(`${cx},${sy},${cz}`, {
      cx, cz, sy,
      blockBits: Number(row.blockBits),
      blockPalette: (row.blockPalette ?? []) as (number | bigint)[],
      blockData: (row.blockData ?? []) as (number | bigint)[],
      nonAirCount: Number(row.nonAirCount),
    });
    this.stats.queued = this.queue.size;
  }

  /**
   * Name everything the queued sections need, then build them.
   *
   * Naming first, in one batch, is what keeps this affordable: a burst of sections shares
   * almost all of its palette ids, so one round of queries serves all of them instead of
   * one round per section.
   */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.size === 0) return;
    this.draining = true;
    try {
      const batch = [...this.queue.values()];
      this.queue.clear();
      this.stats.queued = 0;
      await this.learnPalettes(batch);
      for (const row of batch) this.build(row);
    } catch (e) {
      this.deps.status(`spacetime terrain: ${(e as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  /** Resolve every palette id these sections use that we cannot already name. */
  private async learnPalettes(batch: readonly SectionRow[]): Promise<void> {
    const want = new Set<number>();
    for (const row of batch) {
      for (const id of row.blockPalette) {
        const n = Number(id);
        if (n !== 0 && !this.namer.knows(n)) want.add(n);
      }
    }
    if (want.size === 0) return;
    const rows = await this.fetchStates([...want]);
    // A block we have not met needs its FULL state list before any of its states can be
    // named, because the defaults are derived from the whole set.
    const blocks = new Set(rows.map((r) => r.name).filter((n) => !this.statesByBlock.has(n)));
    for (const block of blocks) await this.loadBlock(block);
    this.namer.learn(rows);
  }

  private async fetchStates(ids: number[]): Promise<StateRow[]> {
    const out: StateRow[] = [];
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const clause = ids.slice(i, i + ID_BATCH).map((id) => `id = ${id}`).join(' OR ');
      const rows = await this.deps.sql(`SELECT id,name,properties FROM block_state WHERE ${clause}`);
      for (const r of rows ?? []) {
        out.push({ id: Number(r[0]), name: String(r[1]), properties: String(r[2] ?? '') });
      }
    }
    return out;
  }

  private async loadBlock(block: string): Promise<void> {
    const rows = await this.deps.sql(
      `SELECT id,name,properties FROM block_state WHERE name = '${block.replace(/'/g, "''")}'`);
    this.statesByBlock.set(block, (rows ?? []).map((r) => ({
      id: Number(r[0]), name: String(r[1]), properties: String(r[2] ?? ''),
    })));
    this.stats.blocks++;
  }

  /** Canonical keys the bundle holds for one block, as bare property strings. */
  private bakedFor(block: string): string[] {
    if (!this.bakedByBlock) {
      this.bakedByBlock = new Map();
      for (const key of this.deps.bakedKeys()) {
        const br = key.indexOf('[');
        const name = br < 0 ? key : key.slice(0, br);
        const props = br < 0 ? '' : key.slice(br + 1, -1);
        const list = this.bakedByBlock.get(name);
        if (list) list.push(props);
        else this.bakedByBlock.set(name, [props]);
      }
    }
    return this.bakedByBlock.get(block) ?? [];
  }

  private build(row: SectionRow): void {
    const { ids } = unpackSection(row);
    const before = this.namer.stats.unresolved;
    const { palette, indices } = this.namer.toLivePalette(ids);
    this.stats.unnamed += this.namer.stats.unresolved - before;
    this.deps.world.addLiveSection(row.cx, row.sy, row.cz, {
      palette, indices, ...this.lightFor(row.cx, row.sy, row.cz),
    });
    this.deps.onSection(row.cx, row.sy, row.cz);
    this.stats.sections++;
    this.stats.cells += 4096;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.clear();
  }

  hudLine(): string {
    return ` | terrain: ${this.stats.sections} sections`
      + (this.stats.queued ? ` (+${this.stats.queued} queued)` : '')
      + ` ${this.stats.litSections} lit`
      + (this.stats.changes ? ` ${this.stats.changes} edits` : '')
      + (this.stats.bogus ? ` ${this.stats.bogus} BOGUS coords skipped` : '')
      + (this.stats.unnamed ? ` ${this.stats.unnamed} UNNAMED cells` : '');
  }
}

/** A light array is 2048 bytes: 4096 cells at one nibble each. */
export const LIGHT_BYTES = 2048;

/**
 * Chunk coordinates the producer could actually mean.
 *
 * There is a known upstream bug where a handful of rows carry `cx == cz == 1280064` —
 * identical bogus x and z, which points at two i32s read from the wrong offset. Rendering
 * them would put a section 20 million blocks away and stretch every bounding volume that
 * touches it, so they are skipped and COUNTED rather than drawn or silently dropped.
 */
/**
 * A million chunks is 16 million blocks — an order of magnitude beyond anywhere anyone
 * builds, and comfortably inside Minecraft's own ~1.87M-chunk world border, so this rejects
 * nothing real. The known bad rows sit at 1,280,064, just above it.
 *
 * Chosen against the observed bug rather than against the format's limits on purpose: the
 * format permits those coordinates, the world does not contain them, and the cost of
 * rendering one is a section 20 million blocks away stretching every bounding volume that
 * touches it.
 */
const MAX_CHUNK = 1_000_000;

export function sane(cx: number, cz: number, sy: number): boolean {
  if (![cx, cz, sy].every(Number.isFinite)) return false;
  if (Math.abs(cx) > MAX_CHUNK || Math.abs(cz) > MAX_CHUNK) return false;
  return sy >= -64 && sy <= 64;
}

/**
 * A light column as the module sends it, or null when it is not usable.
 *
 * Returns null for an ABSENT or wrong-sized array — which the caller must treat as "not
 * known", never as darkness. A genuinely dark section arrives as 2048 bytes of zero and
 * comes back here as a real array.
 */
export function toNibbles(v: unknown): Int8Array | null {
  // The two transports encode `Vec<u8>` differently, and both reach this function:
  // the SDK's BSATN gives real bytes, while the HTTP SQL endpoint gives a HEX STRING
  // (4096 characters for 2048 bytes). Accepting only one of them makes light work over a
  // subscription and silently vanish over a query, or the reverse.
  if (typeof v === 'string') return fromHex(v);
  if (v instanceof Int8Array) return v.length === LIGHT_BYTES ? v : null;
  if (v instanceof Uint8Array) {
    return v.length === LIGHT_BYTES ? new Int8Array(v.buffer, v.byteOffset, v.length) : null;
  }
  if (Array.isArray(v)) {
    if (v.length !== LIGHT_BYTES) return null;
    const out = new Int8Array(LIGHT_BYTES);
    for (let i = 0; i < LIGHT_BYTES; i++) out[i] = Number(v[i]) | 0;
    return out;
  }
  return null;
}

/** `"ff00..."` -> bytes. Refuses anything that is not exactly a full light column. */
function fromHex(hex: string): Int8Array | null {
  if (hex.length !== LIGHT_BYTES * 2 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Int8Array(LIGHT_BYTES);
  for (let i = 0; i < LIGHT_BYTES; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
