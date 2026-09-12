/**
 * Live entities from SpacetimeDB, via the official SDK and generated bindings.
 *
 * THE POINT. The bridge path refreshes entities only when the server writes them to disk —
 * `save-all flush`, floor 2 s, backing off to 120 s under load — so a mob is repositioned
 * with a short slide every couple of seconds and then held. That reads on screen as "mobs
 * don't move", which is exactly the complaint PARITY-AUDIT.md §4 traced to its cause.
 *
 * `../mcspacetime` fixes it at the source: a headless Minecraft 1.21.1 protocol client joins
 * the server as a real player (full NeoForge handshake, no server-side mod) and mirrors what
 * it sees into SpacetimeDB. Entity movement arrives as ordinary row updates at packet rate.
 * Measured against the dev replica: a single wolf produced 29 position updates in 20 s,
 * where the flush path would have produced at most 10 and usually 4.
 *
 * WHAT THIS FILE IS AND IS NOT. It is a *source* of `EntitySample`s. It is deliberately not
 * a renderer: the samples go into the same `LiveEntities` the save-file path feeds, so
 * interpolation, meshes, billboards, name tags and item icons are all the identical code in
 * both modes. Swapping the source must not fork the renderer, or the two paths drift and
 * only one of them stays correct.
 *
 * TWO HONEST LIMITS, both because of what the wire carries rather than how this is written:
 *
 * - **A dropped item's stack and a falling block's state are not resolved here.** The
 *   `entity` row carries the spawn-data varint, not an item stack; resolving a falling
 *   block's `data` to a block name means joining against the 344,003-row `block_state`
 *   table, which is not something to subscribe a browser to. Items and falling blocks
 *   therefore arrive typed but without their icon/state, and `renderKind` in live-entities
 *   draws them as the generic type rather than as their contents. The save-file path still
 *   resolves both, so this is a regression *for those two kinds only* and is called out on
 *   the HUD rather than hidden.
 * - **Monitor text is untouched.** A ComputerCraft terminal's contents are not on the
 *   Minecraft wire at all, so `screen.json` remains the source in both modes.
 */

import { appearanceOf } from '../render/entity-layers.js';
import { entityAppearanceContext } from './entity-tracks.js';
import {
  nbtFromMetadata, parseAppearance, type VariantTable,
} from '../render/entity-metadata.js';
import { toMonitors, type MonitorRow } from './spacetime-monitors.js';
import type { LiveMonitor } from './live.js';
import type { EntityAppearance } from '../render/entity-layers.js';
import type { EntitySample } from './entity-tracks.js';

/**
 * The fields this file needs from a generated `Entity` row.
 *
 * Declared structurally rather than importing the generated type, so a schema change that
 * adds columns cannot break the build and the module bindings stay an implementation
 * detail of `connect()`. The names are the SDK's camelCase accessors.
 */
export interface EntityRow {
  id: number;
  uuid: string;
  typeName: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  customName?: string | null;
  /** raw SynchedEntityData scalars as `[0, "<json>"]`, or `[1, []]` for none */
  appearance?: unknown;
}

/**
 * One row to one sample.
 *
 * `uuid` is the track identity, and it must be the row's own uuid rather than its numeric
 * entity id: the id is reused by the server after a despawn, and reusing a track across two
 * different mobs makes one of them appear to teleport across the map.
 *
 * A row whose position is not finite is REFUSED. three.js answers a NaN position by
 * silently dropping the whole mesh, which looks exactly like "the feature does not work" —
 * this project has already paid for that lesson once, in `readPlayers`.
 */
/** The base model and nothing else: what an entity with no appearance data looks like. */
const NO_APPEARANCE: EntityAppearance = {
  key: '', layers: [{ model: null, texture: null, tint: null }],
};

/**
 * Where the variant registries come from for this source.
 *
 * Installed alongside the appearance context, from the same baked bundle, so the metadata
 * adapter and the appearance rules are looking at one table rather than two.
 */
let registries: ((name: string) => VariantTable | undefined) | undefined;

export function useVariantRegistries(
  fn: ((name: string) => VariantTable | undefined) | undefined,
): void {
  registries = fn;
}

/** The shared appearance rules, fed from metadata instead of from NBT. */
function appearanceFrom(row: EntityRow): EntityAppearance {
  const meta = parseAppearance(row.appearance);
  if (!meta) return NO_APPEARANCE;
  const nbt = nbtFromMetadata(row.typeName, meta, { registry: registries });
  if (!Object.keys(nbt).length) return NO_APPEARANCE;
  return appearanceOf(row.typeName, nbt, entityAppearanceContext());
}

export function toSample(row: EntityRow): EntitySample | null {
  const pos: [number, number, number] = [Number(row.x), Number(row.y), Number(row.z)];
  if (!pos.every(Number.isFinite)) return null;
  if (typeof row.uuid !== 'string' || !row.uuid) return null;
  if (typeof row.typeName !== 'string' || !row.typeName) return null;
  return {
    uuid: row.uuid,
    type: row.typeName,
    pos,
    yawDeg: Number.isFinite(row.yaw) ? Number(row.yaw) : 0,
    name: typeof row.customName === 'string' && row.customName ? row.customName : null,
    // Not on the wire as such — see the file header. Typed, but without contents.
    item: null,
    block: null,
    // Appearance now comes from the mirror's raw metadata scalars, translated into the NBT
    // shape the shared rules already read — see render/entity-metadata.ts, and note that
    // the indices are shifted on this pack. An entity with no blob (every item-shaped one)
    // keeps NO_APPEARANCE rather than a faked default.
    appearance: appearanceFrom(row),
    // Same reason as the appearance: the module's row has no NBT to read a hand from.
    held: [],
    facing: null,
    rotation: null,
  };
}

/** The generated `DbConnection`, structurally — see the note on `EntityRow`. */
interface TableHandle<Row> {
  onInsert(cb: (ctx: unknown, row: Row) => void): void;
  onUpdate(cb: (ctx: unknown, old: Row, row: Row) => void): void;
  onDelete(cb: (ctx: unknown, row: Row) => void): void;
  iter(): Iterable<Row>;
}

export interface Connection {
  db: { entity: TableHandle<EntityRow>; monitor?: TableHandle<MonitorRow> };
  subscriptionBuilder(): {
    onApplied(cb: () => void): { subscribe(queries: string[]): unknown };
  };
  disconnect(): void;
}

export interface SpacetimeEntitiesDeps {
  /** the full current roster, whenever it changes */
  onRoster: (roster: EntitySample[]) => void;
  /** every drawable monitor panel, whenever one changes; omitted by callers that draw none */
  onMonitors?: (panels: LiveMonitor[]) => void;
  status: (msg: string) => void;
}

/**
 * How often the roster is pushed downstream, in ms.
 *
 * Row callbacks fire per entity per packet; a busy world would call `onRoster` hundreds of
 * times a frame and re-ingest the whole roster each time for no visible gain. Coalescing to
 * once per frame-ish keeps the work proportional to what is drawn. The SDK's client cache is
 * already the authoritative roster, so this only decides WHEN to read it, never what it says.
 */
const PUSH_MS = 50;

/**
 * Feeds `EntitySample`s from a SpacetimeDB connection.
 *
 * Read-only: it subscribes and never calls a reducer. The bot is the module's only writer,
 * exactly as the RCON bridge is the only thing that talks to the game.
 */
export class SpacetimeEntities {
  private conn: Connection | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  readonly stats = { rows: 0, updates: 0, applied: false, monitors: 0 };

  constructor(private deps: SpacetimeEntitiesDeps) {}

  /**
   * Bind to an already-built connection.
   *
   * Takes the connection rather than building it so the caller owns the lifecycle and the
   * tests can drive a stub — `connect()` below is the ordinary way to get one.
   */
  attach(conn: Connection): void {
    this.conn = conn;
    const touch = () => { this.dirty = true; };
    conn.db.entity.onInsert(touch);
    conn.db.entity.onDelete(touch);
    conn.db.entity.onUpdate(() => { this.dirty = true; this.stats.updates++; });
    // Monitors ride the same connection and the same dirty flag. One panel per row and a
    // handful of rows, so there is nothing to gain from a second subscription lifecycle —
    // and a screen that repaints on the entity cadence is still far faster than the bridge's
    // file poll.
    const mon = conn.db.monitor;
    if (mon) {
      mon.onInsert(touch);
      mon.onDelete(touch);
      mon.onUpdate(touch);
    }
    conn.subscriptionBuilder()
      .onApplied(() => {
        this.stats.applied = true;
        this.dirty = true;
        this.deps.status('spacetime: entity subscription applied');
      })
      .subscribe(mon ? ['SELECT * FROM entity', 'SELECT * FROM monitor'] : ['SELECT * FROM entity']);
    this.timer = setInterval(() => this.flush(), PUSH_MS);
  }

  /** Push the roster if anything changed since the last push. */
  private flush(): void {
    if (!this.dirty || !this.conn) return;
    this.dirty = false;
    const roster: EntitySample[] = [];
    for (const row of this.conn.db.entity.iter()) {
      const s = toSample(row);
      if (s) roster.push(s);
    }
    this.stats.rows = roster.length;
    this.deps.onRoster(roster);
    // Panels, when the module carries them and the caller wants them. A module without the
    // table (an older publish) simply has no monitors rather than failing to connect.
    const mon = this.conn.db.monitor;
    if (mon && this.deps.onMonitors) {
      const panels = toMonitors(mon.iter());
      this.stats.monitors = panels.length;
      this.deps.onMonitors(panels);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.conn?.disconnect();
    } catch {
      // Already gone; nothing to do and nothing worth saying.
    }
    this.conn = null;
  }

  hudLine(): string {
    if (!this.conn) return ' | spacetime: not connected';
    return ` | spacetime: ${this.stats.rows} entities`
      + `${this.stats.applied ? '' : ' (subscribing)'} moves=${this.stats.updates}`
      + (this.stats.monitors ? `, ${this.stats.monitors} panels` : '');
  }
}

/**
 * Build a live connection to the module.
 *
 * The generated bindings are imported dynamically so the SDK is only fetched by a browser
 * that actually selects the spacetime source — the bridge path, which is the default, pays
 * nothing for this file existing.
 */
export async function connect(
  stdbUri: string,
  database: string,
  status: (msg: string) => void,
): Promise<Connection> {
  const { DbConnection } = await import('../module_bindings/index.js');
  const ws = stdbUri.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
  return new Promise<Connection>((resolve, reject) => {
    DbConnection.builder()
      .withUri(ws)
      // `withDatabaseName`, NOT `withModuleName` — the latter is the 1.x name and throws
      // "is not a function" at runtime against the 2.x SDK. Found the hard way.
      .withDatabaseName(database)
      .onConnectError((_c: unknown, e: Error) => {
        status(`spacetime: connect failed — ${e.message}`);
        reject(e);
      })
      .onDisconnect(() => status('spacetime: disconnected'))
      .onConnect((c: unknown) => {
        status(`spacetime: connected to ${database}`);
        resolve(c as unknown as Connection);
      })
      .build();
  });
}
