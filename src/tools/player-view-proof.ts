/**
 * Proof harness for what the RENDERER does with a player — the half players-proof.ts says
 * it does not cover.
 *
 * players-proof.ts measures the motion model: sample stream in, pose stream out, in blocks.
 * It is deliberately blind to everything after that, and everything after that is where the
 * previous version actually went wrong — the pose was fine and the mesh was re-uploaded from
 * scratch once a second, so the model was right and the screen still stepped.
 *
 * So this one drives the REAL page: the real `LiveView`, the real three.js scene, the real
 * name tags. What it does not use is a real server. The bridge socket is replaced before any
 * app code runs, with a stub that scripts a roster, which buys three things a live server
 * cannot: a player who is in the nether on demand, a player whose Dimension read failed on
 * demand, and a logout at a known instant. Those are exactly the cases that are impossible
 * to stage against a running world and are where players linger, vanish early, or get drawn
 * in a dimension they are not in.
 *
 *   npm run dev                       # in another terminal
 *   npx tsx src/tools/player-view-proof.ts [--url http://localhost:5173/]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const W = 1200;
const H = 800;

function parseArgs(argv: string[]) {
  const arg = (name: string, def: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    url: arg('--url', 'http://localhost:5173/'),
    out: arg('--out', 'out/player-view'),
    headful: argv.includes('--headful'),
  };
}

/**
 * The bridge, replaced before the app loads.
 *
 * `evaluateOnNewDocument` rather than a page script, because `ObserverClient` constructs its
 * socket during startup and a stub installed afterwards would be too late.
 */
const BRIDGE_STUB = String.raw`
(() => {
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      globalThis.__fakeBridge = this;
      setTimeout(() => {
        this.onopen && this.onopen({});
        this.deliver({
          t: 'hello', backend: 'observe', connected: true, players: [],
          flush: { enabled: false, running: false, intervalMs: 0, lastDurationMs: 0, flushes: 0 },
          control: { enabled: false, available: false, joined: false, reason: 'stubbed bridge', name: null },
          chat: { available: false },
        });
      }, 10);
    }
    send() {}
    close() {}
    deliver(msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }
  }
  FakeSocket.OPEN = 1;
  globalThis.WebSocket = FakeSocket;
})();
`;

/** A raw string — see reveal-proof.ts on why a function reference does not work here. */
const PAGE_SCRIPT = String.raw`
(async () => {
  const live = globalThis.__mcwvLive;
  const mcwv = globalThis.__mcwv;
  const bridge = globalThis.__fakeBridge;
  if (!live || !mcwv || !bridge) return { error: 'the page or the stub never came up' };
  const viewer = mcwv.viewer;
  const cam = viewer.camera;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const posOf = (key) => {
    const m = viewer.meshes.get(key);
    return m && m[0] ? [m[0].position.x, m[0].position.y, m[0].position.z] : null;
  };
  const sprites = () => viewer.scene.children.filter((c) => c.type === 'Sprite').length;

  // In front of wherever the camera was dropped, so the players are actually in frame.
  const base = [cam.position.x + 3, cam.position.y - 8, cam.position.z - 14];
  const WALK = 3;   // blocks per roster poll

  // Three players, and only ONE of them may ever be drawn.
  const roster = (n) => ([
    { name: 'drone_07', pos: [base[0] + WALK * n, base[1], base[2]], yaw: 90, pitch: 0,
      dimension: 'minecraft:overworld' },
    { name: 'Nether_Ned', pos: [base[0], base[1], base[2] + 3], yaw: 0, pitch: 0,
      dimension: 'minecraft:the_nether' },
    { name: 'NoDim_Nora', pos: [base[0] - 3, base[1], base[2]], yaw: 0, pitch: 0,
      dimension: null },
  ]);

  let n = 0;
  bridge.deliver({ t: 'players', list: roster(n) });
  const poll = setInterval(() => bridge.deliver({ t: 'players', list: roster(++n) }), 1000);

  // ---- does it MOVE, in the scene graph rather than in the model? -----------
  const trail = [];
  let peakSprites = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 6000) {
    await frame();
    const p = posOf('player:drone_07');
    if (p) trail.push(p);
    peakSprites = Math.max(peakSprites, sprites());
  }
  let maxStep = 0;
  for (let i = 1; i < trail.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(
      trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1], trail[i][2] - trail[i - 1][2]));
  }
  const distinct = new Set(trail.map((p) => p.map((v) => v.toFixed(3)).join(','))).size;
  const travelled = trail.length
    ? Math.hypot(trail[trail.length - 1][0] - trail[0][0], trail[trail.length - 1][2] - trail[0][2])
    : 0;

  // ---- following -----------------------------------------------------------
  const camBefore = [cam.position.x, cam.position.y, cam.position.z];
  const followed = live.followNext();
  await frame(); await frame();
  const camSnapped = [cam.position.x, cam.position.y, cam.position.z];
  globalThis.__mcwvProofShot = true;      // the screenshot is taken here
  const walkStart = posOf('player:drone_07');
  const t1 = performance.now();
  while (performance.now() - t1 < 2500) await frame();
  const camLocked = [cam.position.x, cam.position.y, cam.position.z];
  const walkEnd = posOf('player:drone_07');
  const released = live.followNext();

  // ---- leaving -------------------------------------------------------------
  clearInterval(poll);
  bridge.deliver({ t: 'players', list: [] });
  const t2 = performance.now();
  let stillThereAfterMs = null;
  while (performance.now() - t2 < 3000) {
    await frame();
    if (posOf('player:drone_07') !== null) stillThereAfterMs = performance.now() - t2;
  }

  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    motion: {
      framesDrawn: trail.length,
      maxStepBlocks: round(maxStep),
      distinctPositions: distinct,
      travelledBlocks: round(travelled),
    },
    presence: {
      nameSpritesWhileOneDrawable: peakSprites,
      spritesAfterEverybodyLeft: sprites(),
    },
    dimensions: {
      netherPlayerDrawn: posOf('player:Nether_Ned') !== null,
      unreadableDimensionPlayerDrawn: posOf('player:NoDim_Nora') !== null,
    },
    following: {
      followed,
      snapMovedCameraBlocks: round(dist3(camBefore, camSnapped)),
      // The camera should have moved by as much as the player did, and no more.
      cameraMovedBlocks: round(dist3(camSnapped, camLocked)),
      playerMovedBlocks: walkStart && walkEnd ? round(dist3(walkStart, walkEnd)) : null,
      releasedBy: released,
      followingAfterRelease: live.followingName,
    },
    leaving: {
      lastSeenMsAfterRosterEmptied: stillThereAfterMs === null ? 0 : Math.round(stillThereAfterMs),
      meshRemoved: posOf('player:drone_07') === null,
    },
    hud: live.hudLine(),
  };
})()
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const browser = await puppeteer.launch({
    headless: !args.headful,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      `--window-size=${W},${H}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[mcwv]') || m.type() === 'error') console.log(`  browser: ${t}`);
  });
  page.on('pageerror', (e: unknown) => console.log(`  PAGE ERROR: ${(e as Error).message}`));
  try {
    console.log(`loading ${args.url} ...`);
    // BEFORE the navigation: `ObserverClient` opens its socket during startup, and a stub
    // installed after that has already lost the race.
    await page.evaluateOnNewDocument(BRIDGE_STUB);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction('globalThis.__mcwvLive && globalThis.__mcwv',
      { timeout: 300_000, polling: 500 });
    // The screenshot has to be taken while the page script is still running, so it races
    // the evaluate rather than following it.
    const shot = page
      .waitForFunction('globalThis.__mcwvProofShot === true', { timeout: 180_000, polling: 50 })
      .then(() => page.screenshot({ path: `${args.out}/following.png` }));
    const r = await page.evaluate(PAGE_SCRIPT) as { error?: string };
    await shot;
    if (r.error) throw new Error(r.error);
    console.log(JSON.stringify(r, null, 2));
    writeFileSync(`${args.out}/player-view.json`, JSON.stringify(r, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
