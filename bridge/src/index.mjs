/**
 * mcwv-bridge — the live tier.
 *
 * A browser cannot open a TCP socket, so something server-side has to hold the RCON
 * connection. That is all this process is: a read-only observer of a running Minecraft
 * server, exposed to the browser over one WebSocket.
 *
 *   browser  <--WebSocket-->  bridge  --RCON-->  Minecraft server
 *      |                                              |
 *      +----------- HTTP: region files <--------------+  (flushed on a guarded timer)
 *
 * It sends the browser:
 *
 *   { t: 'players', list: [{ name, pos, yaw, pitch, dimension }] }   ~1 Hz
 *   { t: 'reload',  seq, tookMs, intervalMs }                        after each flush
 *   { t: 'hello',   flush: {...}, control: {...} }                   on connect
 *
 * and accepts back: `ping`, `hello`, `join`, `leave`, and — ONLY once a fake player has
 * actually been joined — `input`, `look`, `dig`, `place` and `hotbar`. See
 * fake-player.mjs: `/player <name> ...` comes from a mod the reference server does not
 * have, so that path is off by default, spawns nothing until asked, and latches itself
 * off on the first failure rather than firing failing commands at a live world.
 *
 * The mineflayer backend is gone: NeoForge's configuration phase disconnects non-NeoForge
 * clients, and modded block-state ids are never transmitted, so it could never have worked
 * here. The world comes from the save files instead, which is strictly better — they are
 * string-keyed, so every modded block renders exactly.
 *
 * Environment:
 *   MCWV_RCON_HOST/PORT/PASSWORD   how to reach the server. The password is read from the
 *                                  environment and never logged or sent to the browser.
 *   MCWV_POLL_MS         player poll cadence (default 1000, floor 500)
 *   MCWV_MAX_PLAYERS     cap on players polled per tick (default 10)
 *   MCWV_TURTLE_MS       `computercraft dump` cadence for live turtles (default 1000,
 *                        floor 500, 0 = off). One read a second; see computers.mjs.
 *   MCWV_HQ_URL          the settlement brain, for turtle activity labels (default
 *                        http://hq:4400 on the Minecraft compose network; empty = off)
 *   MCWV_HQ_MS           HQ label poll cadence (default 1000, floor 500, 0 = off)
 *   MCWV_FLUSH_ENABLE    '1' to allow `save-all flush` at all. DEFAULT OFF.
 *   MCWV_FLUSH_MS        flush cadence (default 5000, HARD FLOOR 2000)
 *   MCWV_FLUSH_SLOW_MS   a flush slower than this backs the cadence off (default 1000)
 *   MCWV_FAKEPLAYER_ENABLE    '1' to permit an ATTEMPT at browser control. DEFAULT OFF.
 *                             Needs SiliconeDolls or Carpet: NeoForged on the server.
 *   MCWV_BOT_NAME             the fake player's name (default WebViewer)
 *   MCWV_FAKEPLAYER_COMMANDS  JSON overriding the command templates, for a mod that
 *                             spells them differently
 *   MCWV_SELF_MS         bot position poll (default 100, floor 50)
 *   MCWV_VITALS_MS       health/hunger/XP/slot poll (default 500)
 *   MCWV_INVENTORY_MS    inventory poll (default 2000)
 *   MCWV_CHAT_LOG        path to the server's latest.log, mounted read-only, for
 *                        receiving chat. RCON has no push channel.
 */

import { WebSocketServer } from 'ws';
import { Observer } from './observer.mjs';
import { FLOOR_MS } from './flush-timer.mjs';

const CONFIG = {
  host: process.env.MCWV_RCON_HOST ?? '127.0.0.1',
  port: Number(process.env.MCWV_RCON_PORT ?? 25575),
  password: process.env.MCWV_RCON_PASSWORD ?? '',
  pollMs: Number(process.env.MCWV_POLL_MS ?? 1000),
  maxTracked: Number(process.env.MCWV_MAX_PLAYERS ?? 10),
  turtleMs: Number(process.env.MCWV_TURTLE_MS ?? 1000),
  // The settlement brain, for turtle activity labels. An empty URL turns labels off; the
  // turtle positions still stream. See hq.mjs.
  hqUrl: process.env.MCWV_HQ_URL ?? 'http://hq:4400',
  hqMs: process.env.MCWV_HQ_URL === '' ? 0 : Number(process.env.MCWV_HQ_MS ?? 1000),
  // Monitor screen contents. Defaults to HQ's /monitors next to the label feed; any URL
  // answering the same JSON shape works. Empty disables (screens stay blank).
  monitorsUrl: process.env.MCWV_MONITORS_URL
    ?? (process.env.MCWV_HQ_URL === '' ? '' : `${(process.env.MCWV_HQ_URL ?? 'http://hq:4400').replace(/\/$/, '')}/monitors`),
  monitorsMs: Number(process.env.MCWV_MONITORS_MS ?? 2000),
  // Off unless explicitly turned on. This is the switch that decides whether a live
  // server's tick budget gets spent on the viewer at all.
  flushEnabled: process.env.MCWV_FLUSH_ENABLE === '1',
  flushMs: Number(process.env.MCWV_FLUSH_MS ?? 5000),
  flushSlowMs: Number(process.env.MCWV_FLUSH_SLOW_MS ?? 1000),
  // Browser control. Off unless explicitly turned on, and even then it only gets as far
  // as one probe on a server that lacks the mod.
  fakePlayerEnabled: process.env.MCWV_FAKEPLAYER_ENABLE === '1',
  botName: process.env.MCWV_BOT_NAME ?? 'WebViewer',
  fakePlayerCommands: parseCommandOverrides(process.env.MCWV_FAKEPLAYER_COMMANDS),
  // The bot's own position, polled far faster than the roster — this is what the camera
  // follows. 100 ms measured as free on the reference server; see observer.mjs.
  selfMs: Number(process.env.MCWV_SELF_MS ?? 100),
  vitalsMs: Number(process.env.MCWV_VITALS_MS ?? 500),
  inventoryMs: Number(process.env.MCWV_INVENTORY_MS ?? 2000),
  // The server's own log, mounted READ-ONLY. There is no push channel on RCON, so this
  // is where received chat comes from. Empty disables chat receive.
  chatLogPath: process.env.MCWV_CHAT_LOG ?? '',
  wsPort: Number(process.env.MCWV_WS_PORT ?? 8080),
};

/** Bad JSON here must not take the observer down with it; the control path is optional. */
function parseCommandOverrides(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.log(`[bridge] MCWV_FAKEPLAYER_COMMANDS is not valid JSON, ignoring: ${e.message}`);
    return undefined;
  }
}

const log = (...a) => console.log('[bridge]', ...a);
const clients = new Set();

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
}

/** Tell one browser its control frame was handled, and whether anything could act on it. */
function ack(ws, of) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'ack', of, at: Date.now(), driving: observer.driving }));
}

const observer = new Observer(
  {
    host: CONFIG.host,
    port: CONFIG.port,
    password: CONFIG.password,
    pollMs: CONFIG.pollMs,
    maxTracked: CONFIG.maxTracked,
    turtleMs: CONFIG.turtleMs,
    hqUrl: CONFIG.hqUrl,
    hqMs: CONFIG.hqMs,
    monitorsUrl: CONFIG.monitorsUrl,
    monitorsMs: CONFIG.monitorsMs,
    flushEnabled: CONFIG.flushEnabled,
    flushMs: CONFIG.flushMs,
    flushSlowMs: CONFIG.flushSlowMs,
    fakePlayerEnabled: CONFIG.fakePlayerEnabled,
    botName: CONFIG.botName,
    fakePlayerCommands: CONFIG.fakePlayerCommands,
    selfMs: CONFIG.selfMs,
    vitalsMs: CONFIG.vitalsMs,
    inventoryMs: CONFIG.inventoryMs,
    chatLogPath: CONFIG.chatLogPath,
    log,
  },
  broadcast,
);

function describeFlush() {
  if (!CONFIG.flushEnabled) {
    return 'flush: DISABLED (set MCWV_FLUSH_ENABLE=1 to allow `save-all flush`;'
      + ' without it block changes never reach the viewer)';
  }
  const ms = observer.flushTimer.intervalMs;
  const floored = ms !== CONFIG.flushMs ? ` (requested ${CONFIG.flushMs}, floor ${FLOOR_MS})` : '';
  return `flush: enabled at ${ms} ms${floored}, only while a viewer is connected`;
}

function start() {
  if (!CONFIG.password) {
    log('ERROR: MCWV_RCON_PASSWORD is not set — put it in the .env next to docker-compose.yaml');
    log('       (it is the `rcon.password` from the server\'s server.properties)');
    return;
  }
  observer.start().catch((e) => {
    log('rcon start failed:', e.message);
    broadcast({ t: 'error', message: `rcon: ${e.message}` });
    setTimeout(start, 10_000);
  });
}

function describeControl() {
  if (!CONFIG.fakePlayerEnabled) {
    return 'control: DISABLED (set MCWV_FAKEPLAYER_ENABLE=1 to try browser control;'
      + ' it needs SiliconeDolls or Carpet: NeoForged installed on the server)';
  }
  return `control: enabled — nothing spawns until a browser presses Join,`
    + ` which runs \`/player ${CONFIG.botName} spawn\``;
}

const wss = new WebSocketServer({ port: CONFIG.wsPort });
log(`observer bridge listening on :${CONFIG.wsPort}`);
log(`rcon target ${CONFIG.host}:${CONFIG.port}`);
log(describeFlush());
log(describeControl());
log(observer.turtles.enabled
  ? `turtles: polling \`computercraft dump\` every ${observer.turtles.intervalMs} ms while a viewer is connected`
  : 'turtles: DISABLED (MCWV_TURTLE_MS=0) — turtles move only when their chunk is flushed and re-read');
log(observer.monitors.enabled
  ? `monitor screens: polling ${observer.monitors.url} every ${observer.monitors.intervalMs} ms (blank until it answers)`
  : 'monitor screens: DISABLED (set MCWV_MONITORS_URL) — monitors render blank');
log(observer.hq.enabled
  ? `turtle labels: polling HQ ${observer.hq.url}/invoke every ${observer.hq.intervalMs} ms (fleet.status)`
  : 'turtle labels: DISABLED (set MCWV_HQ_URL) — turtles show their id with no activity');
log(CONFIG.chatLogPath
  ? `chat: reading ${CONFIG.chatLogPath} (read-only)`
  : 'chat: receive DISABLED (set MCWV_CHAT_LOG to the server\'s latest.log)');

/**
 * How often a viewer must prove it is still there.
 *
 * WITHOUT THIS A DEAD TAB KEEPS FLUSHING A LIVE SERVER. nginx proxies this socket with
 * `proxy_read_timeout 3600s`, so a browser killed without a close handshake leaves the
 * upstream connection established for up to an hour. The bridge counted that as a viewer,
 * and the flush timer's whole safety property — "zero viewers means zero flushes, we never
 * flush into an empty room" — quietly stopped holding. Observed here: `flush.running` was
 * true with no browser anywhere and only the RCON socket left in the container.
 */
const HEARTBEAT_MS = 30_000;

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    // Missed the previous round trip entirely: the peer is gone, whatever TCP believes.
    if (ws.isAlive === false) {
      log('viewer failed two heartbeats — dropping it');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
// Never hold the process open for the sake of the heartbeat.
heartbeat.unref?.();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  log(`viewer connected (${clients.size} total)`);
  ws.send(JSON.stringify(
    observer.ready
      ? { t: 'hello', backend: 'observe', ...observer.status() }
      : { t: 'status', message: 'bridge is connecting to RCON...' },
  ));
  observer.setClients(clients.size);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
    } else if (msg.t === 'hello') {
      ws.send(JSON.stringify({ t: 'hello', backend: 'observe', ...observer.status() }));
    } else {
      // Everything else is a control intent. `control()` is a no-op unless the fake
      // player is enabled AND passed its probe, so an unexpected message from a browser
      // cannot reach the server on a stock install.
      //
      // The ack is what lets a browser tell "my input never left" from "my input left and
      // nothing happened" — the two look identical on screen otherwise, and one of them
      // is the bug this bridge has already shipped twice.
      void observer.control(msg).finally(() => ack(ws, msg.t));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`viewer disconnected (${clients.size} left)`);
    observer.setClients(clients.size);
  });
});

start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    observer.stop();
    wss.close();
    process.exit(0);
  });
}
