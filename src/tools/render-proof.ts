/**
 * Headless render harness.
 *
 * Loads the viewer in headless Chrome against the reference world, waits for meshing to
 * finish, captures a screenshot and measures sustained frame rate. Doubles as the
 * project's end-to-end test: if the asset pipeline or mesher regresses, the quad count
 * or unresolved count moves and this fails loudly.
 *
 *   npx tsx src/tools/render-proof.ts [--url ...] [--out out/render.png] [--headful]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';

interface Diag {
  packs: number;
  chunks: number;
  sections: number;
  meshMs: number;
  atlasSprites: number;
  atlasMissing: number;
  unresolved: number;
  biomes: number;
  entities: number;
  contraptions: number;
  contraptionBlocks: number;
  entitiesDrawn: number;
  entityTypesDrawn: number;
  entityQuads: number;
  entitiesByStrategy: Record<string, number>;
}

interface Fps { avg: number; p1: number; frames: number }
interface RenderOnly { avgMs: number; medianMs: number; fps: number }
interface Stats { drawCalls: number; triangles: number; states: number }

function parseArgs(args: string[]) {
  const arg = (name: string, def: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  return {
    url: arg('--url', 'http://localhost:5180/?auto=1'),
    out: arg('--out', 'out/render.png'),
    headful: args.includes('--headful'),
  };
}

/** Launches the browser and returns a page already wired up to forward its console. */
async function openPage(headful: boolean) {
  const browser = await puppeteer.launch({
    headless: !headful,
    args: [
      // SwiftShader gives a real WebGL2 context in headless CI. On a machine with a GPU
      // the ANGLE default is faster, but SwiftShader is deterministic — we report both.
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--window-size=1600,1000',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[mcwv]') || m.type() === 'error') console.log(`  browser: ${t}`);
  });
  page.on('pageerror', (e: unknown) => console.log(`  PAGE ERROR: ${(e as Error).message}`));
  return { browser, page };
}

async function loadWorld(page: Page, url: string) {
  console.log(`loading ${url} ...`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // Wait for the streaming mesher to drain its queue, so the fps figure measures
  // steady-state rendering rather than rendering-while-meshing.
  // NOTE: these are passed as source strings, not TS arrow functions. tsx compiles with
  // esbuild's keep-names, which injects a `__name` helper that does not exist in the page.
  await page.waitForFunction(
    'globalThis.__mcwv && globalThis.__mcwv.diag.sections > 0 && globalThis.__mcwv.diag.queued === 0',
    { timeout: 900_000, polling: 500 },
  );
  const loadMs = Date.now() - t0;
  console.log(`world ready in ${(loadMs / 1000).toFixed(1)}s`);
}

/** Measure sustained fps over 3 seconds of real frames. */
async function measureFps(page: Page): Promise<Fps> {
  return (await page.evaluate(`new Promise((resolve) => {
    const times = []; let last = performance.now(); let n = 0;
    function tick() {
      const now = performance.now();
      times.push(now - last); last = now;
      if (++n < 240) requestAnimationFrame(tick);
      else {
        const warm = times.slice(40);           // drop warm-up frames
        const sorted = warm.slice().sort((a, b) => a - b);
        const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
        resolve({ avg: 1000 / avg, p1: 1000 / sorted[Math.floor(sorted.length * 0.99)], frames: warm.length });
      }
    }
    requestAnimationFrame(tick);
  })`)) as Fps;
}

/**
 * Also measure GPU-submit time alone, with vsync excluded: rAF caps the loop above at
 * the display refresh, so 60 there is a ceiling and not a limit. This loop times only
 * renderer.render() over the same scene.
 */
async function measureRenderOnly(page: Page): Promise<RenderOnly> {
  return (await page.evaluate(`(() => {
    const v = globalThis.__mcwv.viewer;
    const times = [];
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now();
      v.renderer.render(v.scene, v.camera);
      times.push(performance.now() - t0);
    }
    const warm = times.slice(20).sort((a, b) => a - b);
    const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
    return { avgMs: avg, medianMs: warm[warm.length >> 1], fps: 1000 / avg };
  })()`)) as RenderOnly;
}

async function readDiagnostics(page: Page): Promise<{ diag: Diag; stats: Stats }> {
  const diag = (await page.evaluate('globalThis.__mcwv.diag')) as Diag;
  const stats = (await page.evaluate(`({
    drawCalls: globalThis.__mcwv.viewer.renderer.info.render.calls,
    triangles: globalThis.__mcwv.viewer.renderer.info.render.triangles,
    states: globalThis.__mcwv.world.palette.length,
  })`)) as Stats;
  return { diag, stats };
}

async function capture(page: Page, out: string) {
  mkdirSync(dirname(out), { recursive: true });
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(out, png);
}

function printProof(diag: Diag, stats: Stats, fps: Fps, renderOnly: RenderOnly, out: string) {
  console.log('\n=== render proof ===');
  console.log(`packs loaded:       ${diag.packs}`);
  console.log(`chunks loaded:      ${diag.chunks}`);
  console.log(`distinct states:    ${stats.states}`);
  console.log(`sections meshed:    ${diag.sections}`);
  console.log(`mesh time:          ${diag.meshMs.toFixed(0)} ms`);
  console.log(`atlas sprites:      ${diag.atlasSprites} (missing ${diag.atlasMissing})`);
  console.log(`biomes with tint:   ${diag.biomes}`);
  console.log(`unresolved states:  ${diag.unresolved}`);
  console.log(`entities loaded:    ${diag.entities}`);
  console.log(`  by strategy:      ${Object.entries(diag.entitiesByStrategy ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`contraptions drawn: ${diag.contraptions} (${diag.contraptionBlocks} blocks)`);
  console.log(`entities drawn:     ${diag.entitiesDrawn} of ${diag.entityTypesDrawn} types`
    + ` (${diag.entityQuads} quads)`);
  console.log(`draw calls:         ${stats.drawCalls}`);
  console.log(`triangles on screen:${stats.triangles}`);
  console.log(`fps (rAF, vsync):   ${fps.avg.toFixed(1)}  (1% low ${fps.p1.toFixed(1)}, ${fps.frames} frames)`);
  console.log(`render-only:        ${renderOnly.avgMs.toFixed(2)} ms/frame  => ${renderOnly.fps.toFixed(0)} fps uncapped`);
  console.log(`screenshot:         ${out}`);
}

async function main() {
  const { url, out, headful } = parseArgs(process.argv.slice(2));

  const { browser, page } = await openPage(headful);

  await loadWorld(page, url);

  const fps = await measureFps(page);
  const renderOnly = await measureRenderOnly(page);
  const { diag, stats } = await readDiagnostics(page);

  await capture(page, out);

  printProof(diag, stats, fps, renderOnly, out);

  await browser.close();
  if (diag.sections === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
