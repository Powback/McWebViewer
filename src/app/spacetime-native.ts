/**
 * Players and ComputerCraft computers, natively from SpacetimeDB.
 *
 * WHY THIS EXISTS. In spacetime mode the viewer must not quietly fall back to the RCON
 * bridge for anything. Before this, players came from the bridge's `list` + `data get` poll
 * and turtles from its `computercraft dump` poll — so selecting "spacetime" still opened a
 * bridge socket and still leaned on the save files, which is exactly the silent backfill
 * that makes a mode selector meaningless.
 *
 * Both are already in the module and need no bridge at all:
 *
 *   players    the `player` table — name, position, yaw/pitch, online
 *   computers  the `block_entity` table, which lifts ComputerCraft's fields out of the
 *              block-entity NBT: `computer_id`, `label`, `fuel`, `on`, and the two upgrades
 *
 * WHAT IS GENUINELY NOT AVAILABLE, and is not faked here: a computer's or monitor's SCREEN
 * TEXT. A terminal's contents are not on the Minecraft network protocol at all, so a
 * protocol client cannot see them however it is written — this is a property of the wire,
 * not a gap in the module. `screen-files.ts` reads them from each computer's own
 * `screen.json` in the save, which is a separate channel the HUD names explicitly rather
 * than something that silently stands in for a spacetime feed.
 *
 * Dimension is taken from `bot_status`, because the `player` table does not carry one and
 * the bot only ever observes the dimension it is standing in. Guessing `overworld` would
 * put every player on screen in the wrong world the moment the bot went to the Nether.
 */

import type { LiveComputer, LivePlayer } from './live.js';

/** Just the shape used here, so a schema addition cannot break the build. */
export interface PlayerRow {
  uuid: string;
  name: string;
  online: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface BlockEntityRow {
  x: number;
  y: number;
  z: number;
  typeName: string;
  computerId?: number | null;
  label?: string | null;
  on?: boolean | null;
}

export interface BotStatusRow {
  dimension: string;
  state: string;
  detail: string;
}

/**
 * A `player` row to the roster shape the renderer already draws.
 *
 * An OFFLINE player is dropped rather than drawn: the module keeps the row so a name can be
 * resolved after a logout, but a body standing where someone logged out is a ghost. A row
 * whose position is not finite is refused for the reason `readPlayers` gives — three.js
 * answers a NaN transform by dropping the whole mesh, which looks exactly like the feature
 * not working.
 */
export function toPlayer(row: PlayerRow, dimension: string | null): LivePlayer | null {
  if (!row.online) return null;
  const pos: [number, number, number] = [Number(row.x), Number(row.y), Number(row.z)];
  if (!pos.every(Number.isFinite)) return null;
  if (typeof row.name !== 'string' || !row.name) return null;
  return {
    name: row.name,
    pos,
    yaw: Number(row.yaw) || 0,
    pitch: Number(row.pitch) || 0,
    dimension,
  };
}

/**
 * A `block_entity` row to a computer, or null when it is not one.
 *
 * The test is `computer_id` being present, not the type name — which is the same structural
 * rule the save-file path uses (`LeftUpgrade`/`RightUpgrade` means turtle) rather than a
 * list of ComputerCraft block ids, so a mod that adds its own computer block is picked up
 * without being named.
 */
export function toComputer(row: BlockEntityRow): LiveComputer | null {
  const id = row.computerId;
  if (id === null || id === undefined || !Number.isInteger(Number(id))) return null;
  const pos: [number, number, number] = [Number(row.x), Number(row.y), Number(row.z)];
  if (!pos.every(Number.isInteger)) return null;
  const out: LiveComputer = { id: Number(id), on: row.on === true, pos };
  if (typeof row.label === 'string' && row.label) out.label = row.label;
  return out;
}

interface Handle<Row> {
  onInsert(cb: (ctx: unknown, row: Row) => void): void;
  onUpdate(cb: (ctx: unknown, o: Row, r: Row) => void): void;
  onDelete(cb: (ctx: unknown, row: Row) => void): void;
  iter(): Iterable<Row>;
}

export interface NativeConnection {
  db: {
    player: Handle<PlayerRow>;
    blockEntity: Handle<BlockEntityRow>;
    botStatus: Handle<BotStatusRow>;
  };
  subscriptionBuilder(): { onApplied(cb: () => void): { subscribe(q: string[]): unknown } };
}

export interface SpacetimeNativeDeps {
  onPlayers: (list: LivePlayer[]) => void;
  onComputers: (list: LiveComputer[]) => void;
  status: (msg: string) => void;
}

/** Coalescing interval; rows arrive per packet and the renderer wants a roster. */
const PUSH_MS = 100;

export class SpacetimeNative {
  private conn: NativeConnection | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = true;

  readonly stats = { players: 0, computers: 0, dimension: '', botState: '' };

  constructor(private deps: SpacetimeNativeDeps) {}

  attach(conn: NativeConnection): void {
    this.conn = conn;
    const touch = () => { this.dirty = true; };
    for (const h of [conn.db.player, conn.db.blockEntity, conn.db.botStatus]) {
      h.onInsert(touch);
      h.onUpdate(touch);
      h.onDelete(touch);
    }
    conn.subscriptionBuilder()
      .onApplied(() => {
        this.dirty = true;
        this.deps.status('spacetime: players and computers subscribed');
      })
      .subscribe([
        'SELECT * FROM player',
        'SELECT * FROM block_entity',
        'SELECT * FROM bot_status',
      ]);
    this.timer = setInterval(() => this.flush(), PUSH_MS);
  }

  private flush(): void {
    if (!this.dirty || !this.conn) return;
    this.dirty = false;
    const dimension = this.readBot();
    const players: LivePlayer[] = [];
    for (const row of this.conn.db.player.iter()) {
      const p = toPlayer(row, dimension);
      if (p) players.push(p);
    }
    const computers: LiveComputer[] = [];
    for (const row of this.conn.db.blockEntity.iter()) {
      const c = toComputer(row);
      if (c) computers.push(c);
    }
    this.stats.players = players.length;
    this.stats.computers = computers.length;
    this.deps.onPlayers(players);
    this.deps.onComputers(computers);
  }

  /** The bot's own dimension and state; null dimension when it has not said. */
  private readBot(): string | null {
    const bot = this.conn ? [...this.conn.db.botStatus.iter()][0] : undefined;
    const dimension = bot && typeof bot.dimension === 'string' && bot.dimension
      ? bot.dimension
      : null;
    this.stats.dimension = dimension ?? '';
    this.stats.botState = bot?.state ?? '';
    return dimension;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.conn = null;
  }

  hudLine(): string {
    if (!this.conn) return '';
    return ` | native: ${this.stats.players} players, ${this.stats.computers} computers`
      + (this.stats.dimension ? ` in ${this.stats.dimension.replace('minecraft:', '')}` : '')
      + (this.stats.botState && this.stats.botState !== 'playing' ? ` (bot ${this.stats.botState})` : '');
  }
}
