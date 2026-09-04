/**
 * Minimal Source RCON client.
 *
 * Packet layout (little-endian):
 *   i32 length (of everything after this field)
 *   i32 request id
 *   i32 type   (3 = auth, 2 = exec / auth-response, 0 = response)
 *   body       (null-terminated ASCII)
 *   i8  0      (second terminator)
 *
 * Written out rather than pulled in as a dependency: it is ~80 lines, and the
 * alternative packages are unmaintained wrappers around exactly this.
 */

import net from 'node:net';

const noop = () => {};

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_RESPONSE = 0;

export class RconClient {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 1;
  #authed = false;
  /** Tail of the serialisation chain; see `command()` for why this is mandatory. */
  #queue = Promise.resolve();

  constructor({ host, port, password }) {
    this.host = host;
    this.port = port;
    this.#password = password;
  }

  #password;

  get connected() {
    return this.#authed;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      this.#socket = sock;
      sock.on('data', (d) => this.#onData(d));
      sock.on('error', (e) => {
        this.#authed = false;
        reject(e);
      });
      sock.on('close', () => {
        this.#authed = false;
        for (const { reject: rj } of this.#pending.values()) rj(new Error('rcon closed'));
        this.#pending.clear();
        this.onClose?.();
      });
      sock.on('connect', () => {
        // A failed auth is signalled by the server replying with request id -1.
        this.#send(TYPE_AUTH, this.#password)
          .then(() => {
            this.#authed = true;
            resolve(this);
          })
          .catch(reject);
      });
    });
  }

  /**
   * Run a server command and resolve with its console output.
   *
   * SERIALISED, and that is not an optimisation — it is required.
   *
   * Vanilla's `RconClient` handles one request per read on a fixed buffer. Send two
   * commands without waiting for the first reply and both land in the same TCP segment;
   * the server mis-parses the second and CLOSES THE CONNECTION. It presents as a bridge
   * that works perfectly until the moment there is something to poll, then drops its RCON
   * link every few seconds — which is exactly how it presented here: the player poll
   * issues three `data get`s per player, so the fault only appeared once a player existed.
   *
   * So every command queues behind the last. Callers may still use `Promise.all`; it just
   * does not put two packets on the wire at once.
   */
  command(text) {
    if (!this.#authed) return Promise.reject(new Error('rcon not authenticated'));
    const run = () => (this.#authed
      ? this.#send(TYPE_EXEC, text)
      : Promise.reject(new Error('rcon not authenticated')));
    // Chain onto the tail, and swallow the predecessor's rejection so one failed command
    // does not poison every command queued behind it.
    const result = this.#queue.then(run, run);
    this.#queue = result.then(noop, noop);
    return result;
  }

  close() {
    this.#socket?.end();
  }

  #send(type, body) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const payload = Buffer.from(body, 'utf8');
      const packet = Buffer.alloc(14 + payload.length);
      packet.writeInt32LE(10 + payload.length, 0);
      packet.writeInt32LE(id, 4);
      packet.writeInt32LE(type, 8);
      payload.copy(packet, 12);
      packet.writeInt16LE(0, 12 + payload.length);
      // The timeout handle is kept and cleared on the way out. Without that, every command
      // leaves an 8-second timer behind after it has already been answered, which holds the
      // event loop open — harmless in a long-running bridge, and enough to add ten seconds
      // to any test that makes one.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`rcon timeout: ${body.slice(0, 40)}`));
      }, 8000);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#socket.write(packet);
    });
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 4) return;
      const len = this.#buffer.readInt32LE(0);
      if (this.#buffer.length < len + 4) return;
      const id = this.#buffer.readInt32LE(4);
      const type = this.#buffer.readInt32LE(8);
      const body = this.#buffer.subarray(12, 4 + len - 2).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + len);

      if (id === -1) {
        // Auth failure: the server closes right after this.
        for (const { reject } of this.#pending.values()) {
          reject(new Error('rcon auth failed (bad password)'));
        }
        this.#pending.clear();
        continue;
      }
      const waiter = this.#pending.get(id);
      if (waiter) {
        this.#pending.delete(id);
        waiter.resolve(body);
      } else if (type === TYPE_RESPONSE) {
        this.onLog?.(body);
      }
    }
  }
}
