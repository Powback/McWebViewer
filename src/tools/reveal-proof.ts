/**
 * Proof harness for the isometric reveal — what is hidden, and what must NOT be.
 *
 * The first version of the reveal was a global clipping plane at `playerY + 3`. It was
 * signed off on ONE measurement: the character went from 0 visible pixels to 2601. That
 * measurement was true and the feature was still broken, because it only asked whether the
 * character came back and never whether anything else went away. Two things had: walls
 * nowhere near the sightline lost everything above the cut, and because the cut tracked the
 * player's Y, one step up redrew the entire world.
 *
 * So this harness measures BOTH SIDES, against the live server, on real terrain:
 *
 *   A  the character is visible when something is between it and the camera
 *   B  pixels far from the character are IDENTICAL with the reveal on and off
 *   C  changing only the character's height changes nothing far from it
 *
 * B and C are also run against the old height cut, reproduced in the page, so the numbers
 * are a before/after rather than an assertion that the new one is fine.
 *
 *   npx tsx src/tools/reveal-proof.ts [--url http://mcwebviewer.pow/] [--out out/reveal]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer, { type Page } from 'puppeteer';

const W = 1200;
const H = 800;

interface Args { url: string; out: string; headful: boolean }

function parseArgs(argv: string[]): Args {
  const arg = (name: string, def: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    url: arg('--url', 'http://mcwebviewer.pow/'),
    out: arg('--out', 'out/reveal'),
    headful: argv.includes('--headful'),
  };
}

/**
 * Everything that runs IN THE PAGE, as one source string.
 *
 * A string rather than a function reference on purpose: `tsx` compiles with esbuild's
 * keep-names, which injects a `__name` helper that does not exist in the page — the same
 * trap render-proof.ts documents.
 */
const PAGE_SCRIPT = String.raw`
(async () => {
  const live = globalThis.__mcwvLive;
  const viewer = globalThis.__mcwv.viewer;
  const iso = live.iso;
  const renderer = viewer.renderer;
  const gl = renderer.getContext();
  const cam = viewer.camera;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- join and get into the isometric camera -----------------------------
  if (live.client.control?.joined !== true) {
    live.join();
    for (let i = 0; i < 200 && live.client.control?.joined !== true; i++) await sleep(100);
  }
  if (live.client.control?.joined !== true) return { error: 'the bot never joined' };
  live.setCameraMode('iso');
  // Let positions arrive so the camera is following a real place, not the origin.
  for (let i = 0; i < 100 && !live.controls.botPos; i++) await sleep(100);
  const pos = live.controls.botPos;
  if (!pos) return { error: 'no bot position ever arrived' };
  // Let the world around the bot stream in and mesh.
  await sleep(4000);

  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;

  // The character's own mesh, so it can be taken off screen to measure how much of it
  // reached the screen at all.
  let selfMeshes = null;
  for (const [key, meshes] of viewer.meshes) {
    if (key.startsWith('player:')) selfMeshes = meshes;
  }

  // preserveDrawingBuffer is off, so the read has to happen in the same task as the draw.
  function shoot() {
    viewer.render();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }
  function differing(a, b, keep) {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const p = i / 4, x = p % w, y = (p / w) | 0;
      if (keep && !keep(x, y)) continue;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
    return n;
  }
  function setSelfVisible(on) {
    if (selfMeshes) for (const m of selfMeshes) m.visible = on;
  }

  // ---- the OLD model, reproduced ------------------------------------------
  // A global clipping plane at playerY + 3, which is exactly what setCutawayY did.
  // Duck-typed: three copies .normal and .constant off whatever it is handed.
  const down = cam.position.clone().set(0, -1, 0);
  function oldCut(y) {
    renderer.clippingPlanes = y === null ? [] : [{ normal: down, constant: y }];
  }

  // ---- pick the azimuth with the most terrain in the way -------------------
  // A reveal that never has to remove anything proves nothing, so the camera is turned to
  // wherever the character is most buried before any of this is measured.
  iso.dist = 30;
  let best = { yaw: iso.yaw, hidden: -1 };
  for (let i = 0; i < 16; i++) {
    iso.yaw = (i / 16) * Math.PI * 2;
    iso.update(pos);
    viewer.setSubject(null);           // reveal off: how much of it survives on its own
    setSelfVisible(true);
    const withChar = shoot();
    setSelfVisible(false);
    const without = shoot();
    setSelfVisible(true);
    const visible = differing(withChar, without);
    if (best.hidden < 0 || visible < best.hidden) best = { yaw: iso.yaw, hidden: visible };
  }
  iso.yaw = best.yaw;
  iso.update(pos);

  // Where the character is on screen, and how big its hole is, so "far away" is defined in
  // the feature's own units rather than a guessed number of pixels.
  viewer.setSubject(pos);
  const reveal = viewer.subjectReveal;
  const far = (x, y) => Math.hypot(x - reveal.x, y - reveal.y) > reveal.outer * 3;
  let farPixels = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (far(x, y)) farPixels++;

  // ---- A: is the character visible? ---------------------------------------
  function charPixels() {
    setSelfVisible(true);
    const a = shoot();
    setSelfVisible(false);
    const b = shoot();
    setSelfVisible(true);
    return differing(a, b);
  }
  viewer.setSubject(null);
  const charOff = charPixels();
  viewer.setSubject(pos);
  const charOn = charPixels();

  // ---- B: what happens to everything else? --------------------------------
  // The character is taken off screen for these so the comparison is purely about terrain.
  setSelfVisible(false);
  viewer.setSubject(null);
  oldCut(null);
  const plain = shoot();

  viewer.setSubject(pos);
  const withNew = shoot();
  const newTouchedFar = differing(plain, withNew, far);
  const newTouchedAll = differing(plain, withNew);

  viewer.setSubject(null);
  oldCut(Math.floor(pos[1]) + 3);
  const withOld = shoot();
  const oldTouchedFar = differing(plain, withOld, far);
  const oldTouchedAll = differing(plain, withOld);

  // ---- C: does the character's height move the rest of the world? ---------
  // The camera is held still and ONLY the subject's Y changes, so anything that moves,
  // moved because of the Y.
  oldCut(null);
  viewer.setSubject([pos[0], pos[1], pos[2]]);
  const newLow = shoot();
  viewer.setSubject([pos[0], pos[1] + 3, pos[2]]);
  const newHigh = shoot();
  const newYFar = differing(newLow, newHigh, far);

  viewer.setSubject(null);
  oldCut(Math.floor(pos[1]) + 3);
  const oldLow = shoot();
  oldCut(Math.floor(pos[1]) + 6);
  const oldHigh = shoot();
  const oldYFar = differing(oldLow, oldHigh, far);

  // Put the page back the way it was found.
  oldCut(null);
  setSelfVisible(true);
  viewer.setSubject(pos);

  // A handle for the screenshots. The frame loop calls setSubject every frame, so a state
  // set from outside is gone before the shutter opens; this pins one and holds it.
  const realSetSubject = viewer.setSubject.bind(viewer);
  globalThis.__revealProof = {
    yaw: best.yaw,
    freeze(mode) {
      viewer.setSubject = realSetSubject;
      oldCut(null);
      if (mode === 'on') realSetSubject(pos);
      else realSetSubject(null);
      if (mode === 'old') oldCut(Math.floor(pos[1]) + 3);
      viewer.setSubject = () => {};
      iso.yaw = best.yaw;
    },
    thaw() {
      viewer.setSubject = realSetSubject;
      oldCut(null);
    },
  };

  return {
    pos, yaw: best.yaw, dist: iso.dist,
    screen: { w, h, farPixels },
    reveal: { x: reveal.x, y: reveal.y, inner: reveal.inner, outer: reveal.outer },
    charOff, charOn,
    newTouchedFar, newTouchedAll, oldTouchedFar, oldTouchedAll,
    newYFar, oldYFar,
  };
})()
`;

async function open(headful: boolean) {
  const browser = await puppeteer.launch({
    headless: !headful,
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
  return { browser, page };
}

async function shot(page: Page, path: string) {
  await page.screenshot({ path: path as `${string}.png` });
  console.log(`  wrote ${path}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const { browser, page } = await open(args.headful);
  try {
    console.log(`loading ${args.url} ...`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction('globalThis.__mcwvLive && globalThis.__mcwv', { timeout: 300_000, polling: 500 });

    const r = await page.evaluate(PAGE_SCRIPT) as Record<string, number> & { error?: string };
    if (r.error) throw new Error(r.error);
    console.log(JSON.stringify(r, null, 2));

    // Screenshots for the eye, at the SAME blocked azimuth the numbers were taken at, and
    // taken after them so nothing depends on them.
    for (const mode of ['off', 'on', 'old'] as const) {
      await page.evaluate(`globalThis.__revealProof.freeze('${mode}')`);
      await new Promise((r) => setTimeout(r, 400));
      await shot(page, `${args.out}/reveal-${mode}.png`);
    }
    await page.evaluate('globalThis.__revealProof.thaw()');
    writeFileSync(`${args.out}/reveal.json`, JSON.stringify(r, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
