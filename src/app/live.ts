/**
 * Live mode: watch a running server.
 *
 * This used to be "play from the browser", driving a server-side fake player over RCON
 * with `/player <name> move|turn|attack`. That is fabric-carpet syntax and no
 * carpet-equivalent mod is installed on this NeoForge server, so every one of those
 * commands failed at runtime. The input handling, the raycast, the server-authoritative
 * camera and the chunk-over-WebSocket protocol have all been removed with it — see
 * ARCHITECTURE.md.
 *
 * What is left is what the server can actually be asked for without installing anything:
 *
 *   players       `list` + `data get entity <name> Pos|Rotation|Dimension`, ~1 Hz
 *   block changes a guarded `save-all flush`, then the browser re-reads the save files
 *
 * Both come through this socket; only the notification does, though — the world itself is
 * read over HTTP from the region files, because save files are string-keyed and every
 * modded block therefore renders exactly, which the network protocol cannot manage on a
 * NeoForge server.
 *
 * The camera stays local. You fly around a live world; you do not drive anything in it.
 */

export interface LivePlayer {
  name: string;
  pos: [number, number, number];
  /** degrees, as the game stores them */
  yaw: number;
  pitch: number;
  dimension: string | null;
}

export interface FlushState {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastDurationMs: number;
  flushes: number;
}

/**
 * Whether the browser gets controls at all.
 *
 * `available` is null until the bridge has probed the server. Controls bind only on
 * `true` — a viewer with no controls is honest, a viewer whose controls do nothing is
 * not. `reason` carries the server's own words when it said no.
 */
export interface ControlState {
  enabled: boolean;
  available: boolean | null;
  /** whether a fake player is in the world right now */
  joined: boolean;
  reason: string;
  name: string | null;
}

export interface ChatState {
  available: boolean;
}

export interface SelfSample {
  pos: [number, number, number];
  /** bridge clock, milliseconds — used only to measure sample spacing */
  at: number;
}

export interface ObserverHooks {
  status: (msg: string) => void;
  /** the full current roster, every poll */
  onPlayers: (players: LivePlayer[]) => void;
  /** the server flushed; the save files are worth re-reading */
  onReload: (info: { seq: number; tookMs: number; intervalMs: number }) => void;
  /** the bridge has said whether this browser may drive a player */
  onControl?: (control: ControlState) => void;
  /** the driven player's own position, at the fast poll rate */
  onSelf?: (sample: SelfSample) => void;
  onVitals?: (vitals: Record<string, unknown>) => void;
  onInventory?: (stacks: Array<{ slot: number; id: string; count: number }>) => void;
  onBlock?: (block: unknown) => void;
  onChat?: (msg: { kind: string; from: string | null; text: string }) => void;
}

type Msg = Record<string, unknown> & { t: string };

const RECONNECT_MS = 5000;

/**
 * The browser half of the bridge protocol. It sends nothing but `ping` — the bridge
 * accepts no commands, by design, so there is no client-side control surface to get
 * wrong.
 */
export class ObserverClient {
  private ws: WebSocket | null = null;
  private closed = false;

  connected = false;
  players: LivePlayer[] = [];
  flush: FlushState | null = null;
  control: ControlState | null = null;
  lastReloadAt = 0;

  /** Control frames actually written to the socket. */
  sent = 0;
  /** Control frames refused by the `joined` gate below — they never reached the wire. */
  dropped = 0;
  /**
   * The last control frame the BRIDGE said it handled.
   *
   * Without this, "the browser is not sending" and "the browser is sending and the server
   * is ignoring it" are the same picture on screen. `driving` is the bridge's own answer
   * to whether it was in a position to act on it at all.
   */
  lastAck: { of: string; at: number; driving: boolean } | null = null;

  constructor(
    private url: string,
    private hooks: ObserverHooks,
  ) {}

  connect(): void {
    this.hooks.status(`connecting to bridge at ${this.url} ...`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.hooks.status('bridge connected');
    };
    ws.onclose = () => {
      this.connected = false;
      this.players = [];
      this.hooks.onPlayers([]);
      if (this.closed) return;
      this.hooks.status(`bridge disconnected — retrying in ${RECONNECT_MS / 1000}s`);
      setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => this.hooks.status(`bridge error (is it running at ${this.url}?)`);
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string) as Msg);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  /**
   * Send a control intent. Silently dropped unless the bridge said the control path is
   * live — the bridge would ignore it anyway, but there is no reason to put a command
   * a stock server cannot honour onto the wire.
   */
  send(msg: Record<string, unknown> & { t: string }): void {
    if (!this.control?.joined) {
      this.dropped++;
      return;
    }
    // A closed socket is a drop too — counting the attempt as sent would report traffic
    // that never left the tab.
    if (this.raw(msg)) this.sent++;
    else this.dropped++;
  }

  /** Join and Leave bypass the `joined` gate — they are what changes it. */
  join(): void {
    this.raw({ t: 'join' });
  }

  leave(): void {
    this.raw({ t: 'leave' });
  }

  /** Returns whether the frame actually went out. */
  private raw(msg: Record<string, unknown> & { t: string }): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Dispatch as a table rather than a switch: each entry reads as one line of the
   * protocol spec, and the whole protocol is four lines long.
   */
  private readonly handlers: Record<string, (msg: Msg) => void> = {
    hello: (m) => {
      this.flush = (m.flush as FlushState) ?? null;
      this.control = (m.control as ControlState) ?? null;
      this.hooks.onControl?.(this.control ?? DISABLED_CONTROL);
      this.hooks.status(
        `${describeControl(this.control)} — ${describeFlush(this.flush)}`,
      );
    },
    // Sent whenever the control state changes, so a Join in one tab updates the others.
    control: (m) => {
      this.control = (m.control as ControlState) ?? null;
      this.hooks.onControl?.(this.control ?? DISABLED_CONTROL);
      this.hooks.status(describeControl(this.control));
    },
    // The bridge handled a control frame. Recorded with the LOCAL clock, because the point
    // of it is the age on screen and the two machines' clocks need not agree.
    ack: (m) => {
      this.lastAck = {
        of: String(m.of ?? '?'),
        at: performance.now(),
        driving: m.driving === true,
      };
    },
    status: (m) => this.hooks.status(String(m.message)),
    error: (m) => this.hooks.status(String(m.message)),
    players: (m) => {
      this.players = readPlayers(m.list);
      this.hooks.onPlayers(this.players);
    },
    self: (m) => {
      const pos = m.pos as [number, number, number];
      if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite)) return;
      this.hooks.onSelf?.({ pos, at: Number(m.at) || Date.now() });
    },
    vitals: (m) => this.hooks.onVitals?.(m),
    inventory: (m) => {
      const stacks = Array.isArray(m.stacks) ? m.stacks : [];
      this.hooks.onInventory?.(stacks as Array<{ slot: number; id: string; count: number }>);
    },
    block: (m) => this.hooks.onBlock?.(m.block),
    died: () => this.hooks.status('you died'),
    chat: (m) => this.hooks.onChat?.({
      kind: String(m.kind ?? 'chat'),
      from: typeof m.from === 'string' ? m.from : null,
      text: String(m.text ?? ''),
    }),
    reload: (m) => {
      this.lastReloadAt = performance.now();
      if (this.flush) {
        this.flush.intervalMs = Number(m.intervalMs ?? this.flush.intervalMs);
        this.flush.lastDurationMs = Number(m.tookMs ?? 0);
        this.flush.flushes = Number(m.seq ?? this.flush.flushes);
        this.flush.running = true;
      }
      this.hooks.onReload({
        seq: Number(m.seq ?? 0),
        tookMs: Number(m.tookMs ?? 0),
        intervalMs: Number(m.intervalMs ?? 0),
      });
    },
  };

  private onMessage(msg: Msg): void {
    this.handlers[msg.t]?.(msg);
  }
}

/**
 * Trust nothing off the wire. A player whose Pos did not parse server-side is dropped
 * there, but a malformed message must not put NaN into a transform — three.js responds
 * to a NaN position by silently dropping the whole mesh, which looks exactly like "the
 * feature does not work".
 */
function readPlayers(raw: unknown): LivePlayer[] {
  if (!Array.isArray(raw)) return [];
  const out: LivePlayer[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    const pos = e.pos;
    if (typeof e.name !== 'string' || !Array.isArray(pos) || pos.length !== 3) continue;
    const xyz = pos.map(Number) as [number, number, number];
    if (!xyz.every(Number.isFinite)) continue;
    out.push({
      name: e.name,
      pos: xyz,
      yaw: Number(e.yaw) || 0,
      pitch: Number(e.pitch) || 0,
      dimension: typeof e.dimension === 'string' ? e.dimension : null,
    });
  }
  return out;
}

const DISABLED_CONTROL: ControlState = {
  enabled: false,
  available: false,
  joined: false,
  reason: 'the bridge did not report a control path',
  name: null,
};

/**
 * The one line that has to be right. If the server cannot be driven, this must say so
 * plainly, because the alternative — controls that bind and do nothing — is precisely
 * what this rewrite exists to remove.
 */
export function describeControl(control: ControlState | null): string {
  if (!control || !control.enabled) return 'watching (no control: MCWV_FAKEPLAYER_ENABLE is off)';
  if (control.available === false) return `watching (cannot join: ${control.reason})`;
  if (control.joined) return `PLAYING as ${control.name}`;
  return 'watching (press Join to take control)';
}

export function describeFlush(flush: FlushState | null): string {
  if (!flush) return 'players only';
  if (!flush.enabled) {
    return 'players only — block updates need MCWV_FLUSH_ENABLE=1 on the bridge';
  }
  return `players + block updates every ${(flush.intervalMs / 1000).toFixed(0)}s`;
}
