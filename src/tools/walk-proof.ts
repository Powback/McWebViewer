/**
 * Proof harness for click-to-move: does the REAL bot walk around a REAL obstacle?
 *
 * The claim being tested is not "the planner returns a path" — that is what
 * pathfind.test.ts is for. It is that a tap on the far side of something solid moves the
 * server's own player around it and puts it where the tap was, and that the version this
 * replaced does not.
 *
 * So the harness drives the deployed page, and every position it reports comes from the
 * bridge's RCON poll of the server, not from the browser's guess:
 *
 *   1. find an obstacle   a destination 12-25 blocks away whose straight line is blocked
 *   2. walk it            with the planner, and record where the server says it went
 *   3. walk back          which returns the bot to the start for a fair comparison
 *   4. walk it AGAIN      with the OLD steering — face it, hold forward, jump when stuck,
 *                         give up after four seconds — reproduced in the page from the
 *                         commit it was removed in, so this is a before/after
 *
 *   npx tsx src/tools/walk-proof.ts [--url http://mcwebviewer.pow/] [--out out/walk]
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
    url: arg('--url', 'http://mcwebviewer.pow/'),
    out: arg('--out', 'out/walk'),
    headful: argv.includes('--headful'),
  };
}

/** Runs in the page. A raw string — see the note in reveal-proof.ts about `__name`. */
const PAGE_SCRIPT = String.raw`
(async () => {
  const live = globalThis.__mcwvLive;
  const world = globalThis.__mcwv.world;
  const iso = live.iso;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];

  // Joining races the previous session's leave — the bridge despawns the fake player when
  // the last viewer drops, and a spawn issued while that is in flight is answered but does
  // nothing. Retry rather than report a failure that is really a reconnect.
  for (let attempt = 0; attempt < 4 && live.client.control?.joined !== true; attempt++) {
    live.join();
    for (let i = 0; i < 60 && live.client.control?.joined !== true; i++) await sleep(100);
    if (live.client.control?.joined !== true) await sleep(2000);
  }
  if (live.client.control?.joined !== true) {
    return { error: 'the bot never joined: ' + JSON.stringify(live.client.control) };
  }
  live.setCameraMode('iso');
  for (let i = 0; i < 100 && !live.controls.botPos; i++) await sleep(100);
  if (!live.controls.botPos) return { error: 'no bot position ever arrived' };
  await sleep(4000);   // let the chunks around it finish streaming and meshing

  // Positions come from the BRIDGE, which reads them off the server over RCON. Nothing
  // here trusts the browser's idea of where the character is.
  const serverPos = () => live.controls.botPos.slice();
  const cell = (p) => [Math.floor(p[0]), Math.floor(p[1] + 0.001), Math.floor(p[2])];

  /**
   * Put the bot back where it started.
   *
   * respawn is the bridge's own verb (the R key), and on this server it reliably returns
   * the fake player to the same spot. Both arms of the comparison therefore start from the
   * SAME position, which is the only way the two numbers mean anything — the first arm
   * moves the character, and without a reset the second would start from wherever it left
   * it.
   */
  async function reset() {
    // Leave and re-join, NOT the respawn verb. player <name> spawn is answered for a
    // player that is already in the world and moves nothing — measured: the second arm of
    // this comparison started from where the first arm had left the character. Despawning
    // first is what actually puts it back.
    live.leave();
    await sleep(2500);
    for (let i = 0; i < 4 && live.client.control?.joined !== true; i++) {
      live.join();
      for (let k = 0; k < 60 && live.client.control?.joined !== true; k++) await sleep(100);
      if (live.client.control?.joined !== true) await sleep(2000);
    }
    // Leaving nulls the tracked position; wait for the first real sample of the new one.
    for (let i = 0; i < 100 && !live.controls.botPos; i++) await sleep(100);
    await sleep(2500);
    return serverPos();
  }

  const solid = (x, y, z) => world.getState(x, y, z) !== 0;
  const standable = (x, y, z) =>
    solid(x, y - 1, z) && !solid(x, y, z) && !solid(x, y + 1, z);

  /**
   * How many steps of the STRAIGHT line a walking body could not take.
   *
   * Not "how many solid blocks are on the line" — that was the first version of this and it
   * was useless: on any sloped ground the line passes through the hillside the character
   * would simply walk up, and every destination looked obstructed. This walks the line one
   * block at a time carrying the ground height with it, and counts the steps that need a
   * rise of two or more, or a drop of more than three, or have no floor at all. Those are
   * exactly the steps that stop the old steering dead.
   */
  function blockedAlong(a, b) {
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz)));
    let y = a[1];
    let n = 0;
    for (let i = 1; i <= steps; i++) {
      const x = Math.floor(a[0] + (dx * i) / steps);
      const z = Math.floor(a[2] + (dz * i) / steps);
      let next = null;
      for (let cand = y + 1; cand >= y - 3; cand--) {
        if (standable(x, cand, z)) { next = cand; break; }
      }
      if (next === null) { n++; continue; }   // a wall, a ceiling or a drop too far
      y = next;
    }
    return n;
  }

  /** Ground height along the straight line, so a route over a cliff can be excluded. */
  function levelBetween(a, b) {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.floor(a[0] + (b[0] - a[0]) * t);
      const z = Math.floor(a[2] + (b[2] - a[2]) * t);
      let ground = null;
      for (let y = a[1] + 6; y >= a[1] - 6; y--) if (solid(x, y, z)) { ground = y; break; }
      if (ground === null) return false;            // a hole with no floor within 6
      if (Math.abs(ground + 1 - a[1]) > 4) return false;
    }
    return true;
  }

  // ---- pick a destination that is genuinely on the far side of something -----
  const start = await reset();
  const from = cell(start);
  let goal = null;
  let blocked = 0;
  for (let r = 10; r <= 24; r += 2) {
    for (let a = 0; a < 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      const c = [from[0] + Math.round(Math.cos(th) * r), from[1], from[2] + Math.round(Math.sin(th) * r)];
      // Let the destination sit a few blocks up or down; terrain is not flat.
      let stand = null;
      for (let dy = 0; dy <= 4 && !stand; dy++) {
        if (standable(c[0], c[1] + dy, c[2])) stand = [c[0], c[1] + dy, c[2]];
        else if (standable(c[0], c[1] - dy, c[2])) stand = [c[0], c[1] - dy, c[2]];
      }
      if (!stand) continue;
      // Keep it on roughly the same level. A destination in a pit is a fine walk and a
      // terrible experiment: the character cannot climb back out for the second run.
      if (Math.abs(stand[1] - from[1]) > 3) continue;
      // And no cliffs on the way. A destination across a chasm is a fine walk and a
      // useless experiment: the old steering "arrives" by falling into it.
      if (!levelBetween(from, stand)) continue;
      const b = blockedAlong(from, stand);
      // At least three steps of the straight line that a walking body cannot take.
      if (b < 3) continue;
      if (b > blocked) { blocked = b; goal = stand; }
    }
  }
  if (!goal) return { error: 'no obstructed destination found near the bot' };

  // ---- one run, whichever way it is being driven ---------------------------
  async function record(label, dest, drive, ms) {
    const trail = [serverPos()];
    const t0 = performance.now();
    const stop = drive();
    let plannedLength = 0;
    let snappedGoal = null;
    while (performance.now() - t0 < ms) {
      await sleep(150);
      plannedLength = Math.max(plannedLength, iso.plannedPath.length);
      if (!snappedGoal && iso.walkTarget) snappedGoal = iso.walkTarget.slice();
      const p = serverPos();
      const last = trail[trail.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.05) trail.push(p);
      if (stop && stop()) break;
    }
    const end = serverPos();
    // How far off the straight line it ever got. A route that walks AROUND something has
    // to leave that line; a route that shoves into it never does.
    const ax = dest[0] + 0.5 - trail[0][0];
    const az = dest[2] + 0.5 - trail[0][2];
    const len = Math.hypot(ax, az) || 1;
    let deviation = 0;
    let intoObstacle = 0;
    for (const p of trail) {
      const px = p[0] - trail[0][0];
      const pz = p[2] - trail[0][2];
      deviation = Math.max(deviation, Math.abs((px * az - pz * ax) / len));
      const c = cell(p);
      if (solid(c[0], c[1], c[2])) intoObstacle++;
    }
    return {
      label,
      start: round(trail[0]), end: round(end), dest,
      snappedGoal,
      straightLine: Math.hypot(dest[0] + 0.5 - trail[0][0], dest[2] + 0.5 - trail[0][2]),
      finalDistance: Math.hypot(end[0] - (dest[0] + 0.5), end[2] - (dest[2] + 0.5)),
      travelled: trail.slice(1).reduce((sum, p, i) =>
        sum + Math.hypot(p[0] - trail[i][0], p[2] - trail[i][2]), 0),
      deviation, intoObstacle,
      blockedOnLine: blockedAlong(cell(trail[0]), dest),
      samples: trail.length,
      trail: trail.map(round),
      seconds: (performance.now() - t0) / 1000,
      status: iso.walkStatus,
      plannedLength,
    };
  }
  const round = (p) => p.map((n) => Math.round(n * 100) / 100);

  // ---- the planner, through the real tap path where possible ---------------
  function planned(dest) {
    return () => {
      iso.stop();
      iso.goal = [dest[0], dest[1], dest[2]];
      iso.walkStatus = 'planning';
      return () => ['arrived', 'no path', 'stuck', 'idle'].includes(iso.walkStatus);
    };
  }

  /**
   * The OLD implementation, reproduced verbatim from the commit it was removed in:
   * face the destination, hold forward, jump every 600 ms while no progress is being
   * made, and abandon the walk after four seconds of that.
   */
  function steered(dest) {
    return () => {
      iso.stop();
      let lastDist = Infinity, lastProgressAt = performance.now(), lastJumpAt = 0, done = false;
      const frame = () => {
        if (done) return;
        const p = serverPos();
        const dx = dest[0] + 0.5 - p[0];
        const dz = dest[2] + 0.5 - p[2];
        const d = Math.hypot(dx, dz);
        const now = performance.now();
        if (d <= 1.0) { finish(); return; }
        live.client.send({ t: 'look', yaw: Math.atan2(-dx, -dz), pitch: 0 });
        live.client.send(frameMsg({ forward: true }));
        if (d < lastDist - 0.15) { lastDist = d; lastProgressAt = now; }
        else if (now - lastProgressAt > 4000) { finish(); return; }
        else if (now - lastJumpAt > 600) {
          lastJumpAt = now;
          live.client.send(frameMsg({ forward: true, jump: true }));
        }
        setTimeout(frame, 100);
      };
      const finish = () => { done = true; live.client.send(frameMsg()); };
      setTimeout(frame, 0);
      return () => done;
    };
  }
  function frameMsg(flags) {
    return { t: 'input', forward: false, back: false, left: false, right: false,
             jump: false, sneak: false, sprint: false, ...flags };
  }

  const out = { goal, blockedBlocks: blocked, start, runs: [] };

  iso.stop();
  live.client.send(frameMsg());
  await reset();
  out.runs.push(await record('BEFORE - old steering', goal, steered(goal), 30000));
  iso.stop();
  live.client.send(frameMsg());

  await reset();
  out.runs.push(await record('AFTER - planned', goal, planned(goal), 60000));
  iso.stop();
  live.client.send(frameMsg());

  // And the honest refusal: forty blocks straight up, where nothing can stand. The old
  // steering would have faced it and held forward for four seconds.
  await reset();
  const impossible = [start[0], start[1] + 40, start[2]];
  out.runs.push(await record('impossible - no route exists', impossible,
    planned(impossible), 15000));
  iso.stop();
  live.client.send(frameMsg());

  await reset();
  log.push('done');
  return out;
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
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction('globalThis.__mcwvLive && globalThis.__mcwv',
      { timeout: 300_000, polling: 500 });
    const r = await page.evaluate(PAGE_SCRIPT) as { error?: string };
    if (r.error) throw new Error(r.error);
    console.log(JSON.stringify(r, null, 2));
    writeFileSync(`${args.out}/walk.json`, JSON.stringify(r, null, 2));
    await page.screenshot({ path: `${args.out}/after.png` });
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
