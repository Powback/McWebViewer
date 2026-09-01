/**
 * Reading chat back out of the server.
 *
 * RCON is request/response only — there is no subscribe, and nothing pushes chat to it.
 * `broadcast-rcon-to-ops` sounds like it helps and does the opposite: it sends RCON's own
 * command output to operators, not chat to RCON.
 *
 * So chat is read where the server actually writes it: `logs/latest.log`, mounted
 * READ-ONLY into this container. That needs no mod, no server config and no restart —
 * it is a file the server was already writing.
 *
 * The tail is deliberately dumb: poll size, read the delta, split lines. `fs.watch` on a
 * bind-mounted file across the Docker VM boundary misses events on macOS, and a missed
 * chat message with no error is worse than a 500 ms delay.
 */

import { createReadStream, promises as fsp } from 'node:fs';

/** How often to look for new bytes. Chat is a human-speed channel. */
export const POLL_MS = 500;
/** A single read is capped so a log rotation or a mod dumping a stack trace cannot OOM. */
const MAX_CHUNK = 256 * 1024;

/**
 * Log line shapes, all captured from this server's own `latest.log`.
 *
 *   [31Aug2026 21:43:07.459] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: [Not Secure] [webviewer] hello
 *   [...]: [Not Secure] <Powback> hello
 *   [...]: webviewer joined the game
 *   [...]: webviewer was slain by Zombie
 *
 * `[Not Secure]` is 1.19+ marking unsigned chat; the bot's `say` output always carries it.
 * `[name]` is `say`, `<name>` is ordinary chat.
 */
/**
 * Only lines logged BY THE SERVER count.
 *
 * Without this the `<name> text` shape matches mod log output too — a real capture from
 * this server is EMI warning `Can't send EMI packet to FakePlayer['webviewer'...]`, which
 * showed up in the chat window as `<EMI> ...`. Chat that includes the server's own
 * debug noise is worse than no chat, because you stop trusting any of it.
 */
const SERVER_LOGGER = '[net.minecraft.server.MinecraftServer/]: ';

const PATTERNS = [
  { kind: 'chat', re: /(?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.+)$/ },
  { kind: 'say', re: /(?:\[Not Secure\] )?\[([A-Za-z0-9_]{1,16})\] (.+)$/ },
];

/**
 * Events worth surfacing that are not chat. Deliberately a short list — the log is full
 * of mod noise, and forwarding all of it would bury the messages a player cares about.
 */
const SYSTEM_RE = new RegExp(
  '^([A-Za-z0-9_]{1,16} (?:joined the game|left the game|'
  + 'was slain by .+|was shot by .+|drowned.*|fell .*|burned .*|blew up.*|'
  + 'died.*|was killed.*|starved.*|suffocated.*|hit the ground.*|went up in flames.*))$',
);

/** Parse one log line into a message, or null if it is not one. */
export function parseLogLine(line) {
  if (typeof line !== 'string') return null;
  const at = line.indexOf(SERVER_LOGGER);
  if (at < 0) return null;
  const body = line.slice(at + SERVER_LOGGER.length);
  // The server logs its own RCON echoes as `[Rcon: ...]`, which would otherwise match the
  // `[name] text` say-shape.
  if (body.startsWith('[Rcon:')) return null;
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(body);
    if (m) return { kind, from: m[1], text: m[2].trim() };
  }
  const sys = SYSTEM_RE.exec(body);
  if (sys) return { kind: 'system', from: null, text: sys[1].trim() };
  return null;
}

export class ChatLog {
  #offset = 0;
  #timer = null;
  #reading = false;
  #carry = '';

  /**
   * @param {string} path      the server's latest.log, mounted read-only
   * @param {(msg: object) => void} onMessage
   */
  constructor(path, onMessage, { pollMs = POLL_MS, log = () => {} } = {}) {
    this.path = path;
    this.onMessage = onMessage;
    this.pollMs = pollMs;
    this.log = log;
    this.available = false;
  }

  /** Starts at the END of the file: history is not chat, it is backlog. */
  async start() {
    try {
      const st = await fsp.stat(this.path);
      this.#offset = st.size;
      this.available = true;
    } catch {
      this.log(`chat: ${this.path} is not readable — chat receive is off`);
      this.available = false;
      return;
    }
    this.#timer = setInterval(() => void this.#tick(), this.pollMs);
    if (this.#timer.unref) this.#timer.unref();
    this.log(`chat: tailing ${this.path}`);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick() {
    if (this.#reading) return;
    this.#reading = true;
    try {
      const st = await fsp.stat(this.path);
      // Rotation (or the file being replaced on a server restart) shows as a shrink.
      if (st.size < this.#offset) {
        this.#offset = 0;
        this.#carry = '';
      }
      if (st.size > this.#offset) await this.#readDelta(st.size);
    } catch {
      /* the file can vanish briefly during rotation; the next tick picks it up */
    } finally {
      this.#reading = false;
    }
  }

  #readDelta(size) {
    const start = Math.max(this.#offset, size - MAX_CHUNK);
    const end = size - 1;
    this.#offset = size;
    return new Promise((resolve) => {
      let buf = '';
      createReadStream(this.path, { start, end, encoding: 'utf8' })
        .on('data', (c) => { buf += c; })
        .on('error', () => resolve())
        .on('end', () => {
          // A read can land mid-line; hold the tail until its newline arrives.
          const lines = (this.#carry + buf).split('\n');
          this.#carry = lines.pop() ?? '';
          for (const line of lines) {
            const msg = parseLogLine(line);
            if (msg) this.onMessage(msg);
          }
          resolve();
        });
    });
  }
}
