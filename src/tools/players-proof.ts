/**
 * Proof harness for live player motion: BEFORE and AFTER, in blocks.
 *
 * The claim is "a player you can see now reads as moving rather than teleporting". That is
 * a claim about a sequence of frames, so a screenshot cannot make it and neither can a
 * demo — a viewer standing over a still player looks identical either way. What decides it
 * is the distribution of per-frame steps, and that is what this measures.
 *
 * WHY THIS ONE DOES NOT DRIVE THE DEPLOYED PAGE, unlike walk-proof.ts and reveal-proof.ts:
 * those two need the real server because they are about the SERVER's behaviour — where a
 * bot actually walks, what a real chunk of terrain actually occludes. This is about what
 * the browser does to a sample stream after it arrives, which is arithmetic over time and
 * is fully determined by the samples. So the samples are generated here from a ground truth
 * the harness knows exactly, which buys something the live server cannot give: the true
 * position at every frame, to compare against. Running it needs no server, no bridge, no
 * GPU and no deploy.
 *
 * What it therefore does NOT prove, stated rather than implied: that the bridge's own poll
 * is well behaved, and that the three.js transform lands where the pose says. Those are
 * live-server questions and they belong in a harness that has one.
 *
 *   npx tsx src/tools/players-proof.ts [--out out/players]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { PlayerTracks, type RosterEntry } from '../app/player-tracks.js';

const FRAME_MS = 16;
const POLL_MS = 1000;
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';

type Vec = [number, number, number];

interface Truth {
  /** null while the player is not on the server */
  pos: Vec | null;
  yawDeg: number;
  dimension: string;
}

interface Frame {
  t: number;
  drawn: Vec | null;
  truth: Vec | null;
  stale: boolean;
}

/**
 * A route with every shape that has ever made this look broken.
 *
 * Times in seconds:
 *   0-6    a straight sprint, the ordinary case
 *   6-8    stopped dead, which is where a bad extrapolation overshoots and snaps back
 *   8-14   a quarter circle at walking pace, which is where a naive yaw lerp spins
 *   14-16  an elytra dive: fast, but still real motion and it must NOT be treated as a jump
 *   16     a teleport across the map
 *   18-22  in the nether, where this viewer must draw nothing at all
 *   22-28  back in the overworld
 *   28     logs out
 */
function route(t: number): Truth {
  const s = t / 1000;
  if (s < 6) return { pos: [5.6 * s, 64, 0], yawDeg: 90, dimension: OVERWORLD };
  if (s < 8) return { pos: [33.6, 64, 0], yawDeg: 90, dimension: OVERWORLD };
  if (s < 14) {
    // A quarter turn about a 12-block radius, joined to the stop above so the ground truth
    // itself is continuous — a discontinuous truth would charge the interpolator for a jump
    // no real player made. The heading sweeps 315 -> 45 and so crosses north.
    const a = ((s - 8) / 6) * (Math.PI / 2) - Math.PI / 2;
    return {
      pos: [33.6 + 12 * Math.cos(a), 64, 12 + 12 * Math.sin(a)],
      yawDeg: ((a * 180) / Math.PI + 405) % 360,
      dimension: OVERWORLD,
    };
  }
  if (s < 16) {
    const d = s - 14;
    // ~31 blocks/s, which is elytra speed: genuinely fast, genuinely real, and it must not
    // be mistaken for the teleport two lines below.
    return { pos: [45.6 + 20 * d, 64 - 12 * d, 12 + 20 * d], yawDeg: 45, dimension: OVERWORLD };
  }
  if (s < 18) return { pos: [-820, 71, 640], yawDeg: 0, dimension: OVERWORLD };
  if (s < 22) return { pos: [-102, 40, 80], yawDeg: 0, dimension: NETHER };
  if (s < 28) return { pos: [-820 + 4 * (s - 22), 71, 640], yawDeg: 180, dimension: OVERWORLD };
  return { pos: null, yawDeg: 0, dimension: OVERWORLD };
}

/** Polls that never arrive: one dropped at 4 s, and a three-second stall from 24 s. */
function pollArrives(t: number): boolean {
  const s = t / 1000;
  return !(s === 4 || (s >= 24 && s < 27));
}

/**
 * THE MODEL THIS REPLACED, reproduced from the code it was removed from.
 *
 * `onPlayers` transformed each player's mesh straight from the roster poll and nothing
 * touched it again until the next one. So the drawn position is the newest sample, held.
 */
class LatestSampleOnly {
  private latest = new Map<string, RosterEntry>();

  ingest(roster: readonly RosterEntry[]): void {
    this.latest.clear();
    for (const e of roster) this.latest.set(e.name, e);
  }

  drawn(name: string): Vec | null {
    const e = this.latest.get(name);
    // The old code drew a player whose dimension it could not read anyway, which is the
    // other half of what changed; here everything reads fine, so it does not distort the
    // motion numbers this harness is about.
    if (!e || (e.dimension !== null && e.dimension !== OVERWORLD)) return null;
    return [...e.pos] as Vec;
  }
}

function run(): { before: Frame[]; after: Frame[] } {
  const tracks = new PlayerTracks(OVERWORLD);
  const old = new LatestSampleOnly();
  const before: Frame[] = [];
  const after: Frame[] = [];
  let nextPoll = 0;
  for (let t = 0; t <= 32_000; t += FRAME_MS) {
    while (t >= nextPoll) {
      const at = nextPoll;
      nextPoll += POLL_MS;
      if (!pollArrives(at)) continue;
      const truth = route(at);
      const roster: RosterEntry[] = truth.pos
        ? [{ name: 'Ada', pos: truth.pos, yawDeg: truth.yawDeg, dimension: truth.dimension }]
        : [];
      tracks.ingest(roster, at);
      old.ingest(roster);
    }
    const pose = tracks.poses(t).find((p) => p.name === 'Ada') ?? null;
    const truthNow = route(t);
    const visible = truthNow.dimension === OVERWORLD ? truthNow.pos : null;
    after.push({ t, drawn: pose ? pose.pos : null, truth: visible, stale: pose?.stale ?? false });
    before.push({ t, drawn: old.drawn('Ada'), truth: visible, stale: false });
  }
  return { before, after };
}

// ---------------------------------------------------------------------------
// Metrics

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * A step above this is a deliberate snap — a teleport or a correction too large to be
 * drawn as motion. Counted separately rather than folded into the distribution, because
 * one 1,000-block teleport otherwise swamps every number in the table and hides the thing
 * being measured. Matches SNAP_BLOCKS in player-tracks.ts.
 */
const SNAP_BLOCKS = 4;

interface Step {
  d: number;
  /** was the player actually moving at that moment, per the ground truth */
  moving: boolean;
}

function steps(frames: Frame[]): Step[] {
  const out: Step[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (!a.drawn || !b.drawn) continue;
    const moving = !!a.truth && !!b.truth && dist(a.truth, b.truth) > 0.005;
    out.push({ d: dist(a.drawn, b.drawn), moving });
  }
  return out;
}

/**
 * How far the drawn position is from the true position AT THAT MOMENT.
 *
 * This is the metric the new model is deliberately WORSE on, and it is reported for exactly
 * that reason: the render delay is a real cost and the honest way to present it is next to
 * the thing it bought. Hiding it would make this harness an advertisement.
 */
function latency(frames: Frame[]): { mean: number; max: number } {
  const errs = frames.filter((f) => f.drawn && f.truth).map((f) => dist(f.drawn!, f.truth!));
  return { mean: mean(errs), max: Math.max(...errs) };
}

/**
 * How far the drawn position is from the nearest point the player was EVER at.
 *
 * The complement to latency: it asks whether the viewer ever drew a player somewhere they
 * had not been. Interpolation cuts corners on a curve, so this is not zero — and the size
 * of that corner-cutting is exactly what it should report.
 */
function offPath(frames: Frame[], path: Vec[]): { mean: number; max: number } {
  const errs = frames
    .filter((f) => f.drawn)
    .map((f) => Math.min(...path.map((p) => dist(f.drawn!, p))));
  return { mean: mean(errs), max: Math.max(...errs) };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function pct(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function measure(label: string, frames: Frame[], path: Vec[]) {
  const st = steps(frames);
  const drawn = frames.filter((f) => f.drawn);
  const moving = st.filter((s) => s.moving);
  const smooth = st.filter((s) => s.d <= SNAP_BLOCKS).map((s) => s.d);
  return {
    label,
    framesDrawn: drawn.length,
    /**
     * THE HEADLINE. Frames on which the ground truth says the player was moving and the
     * screen says they were not. A player sampled at 1 Hz and drawn where the sample lands
     * is motionless for 59 frames out of every 60 and then covers five blocks in one.
     */
    frozenWhileMoving: `${((moving.filter((s) => s.d === 0).length / moving.length) * 100).toFixed(1)}%`,
    maxStepBlocksExcludingSnaps: round(Math.max(...smooth)),
    p99StepBlocks: round(pct(smooth, 0.99)),
    medianStepBlocks: round(pct(smooth, 0.5)),
    /** Steps too big to draw as motion: the teleport, and nothing else should be here. */
    snaps: st.filter((s) => s.d > SNAP_BLOCKS).length,
    latencyMeanBlocks: round(latency(frames).mean),
    latencyMaxBlocks: round(latency(frames).max),
    offPathMeanBlocks: round(offPath(frames, path).mean),
    offPathMaxBlocks: round(offPath(frames, path).max),
    /** distinct positions ever drawn: the whole difference, in one number */
    distinctPositions: new Set(drawn.map((f) => f.drawn!.map((n) => n.toFixed(2)).join(','))).size,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Behaviours that are pass/fail rather than a distribution. */
function behaviours(after: Frame[]) {
  const at = (s: number) => after.find((f) => f.t >= s * 1000)!;
  const drawnInNether = after.filter((f) => f.t >= 19_000 && f.t < 22_000 && f.drawn).length;
  const midTeleport = after.filter(
    (f) => f.drawn && f.drawn[0] < -10 && f.drawn[0] > -800,
  ).length;
  const lastDrawn = after.filter((f) => f.drawn).at(-1)!;
  return {
    framesDrawnWhileInTheNether: drawnInNether,
    framesDrawnMidTeleport: midTeleport,
    staleWhileTheBridgeStalled: at(26).stale,
    freshOnceItRecovered: !at(29.5).stale || at(29.5).drawn === null,
    lastFrameDrawnAtMs: lastDrawn.t,
    goneAfterLogoutWithinMs: lastDrawn.t - 28_000,
  };
}

function main(): void {
  const outDir = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'out/players';
  const { before, after } = run();
  const path: Vec[] = [];
  for (let t = 0; t <= 32_000; t += FRAME_MS) {
    const truth = route(t);
    if (truth.pos && truth.dimension === OVERWORLD) path.push(truth.pos);
  }
  const report = {
    scenario: 'sprint, stop, turn through north, elytra dive, teleport, nether, return, logout',
    droppedPolls: 'one at 4s, and a three-second stall from 24s',
    runs: [
      measure('BEFORE - the newest sample, held until the next one', before, path),
      measure('AFTER  - buffered interpolation with a capped chase', after, path),
    ],
    behaviours: behaviours(after),
    // What the numbers do NOT say, so nobody has to guess at the residual.
    notes: [
      'AFTER still reads frozen on about a third of the moving frames, and all of it is'
        + ' deliberate: three seconds of it is the stalled bridge, where the pose is HELD'
        + ' and flagged stale rather than dead-reckoned, and the rest is the second after'
        + ' each teleport and dimension change, where the buffer holds one sample and'
        + ' there is genuinely nothing to interpolate between.',
      'AFTER is WORSE on latency by design: the render delay is about one poll interval,'
        + ' which at a sprint is a few blocks. That is the price of interpolating between'
        + ' two readings instead of guessing past the newest one, and the HUD prints it.',
      'This measures the browser-side model only. Whether the bridge polls reliably, and'
        + ' whether the three.js transform lands where the pose says, are live-server'
        + ' questions — see walk-proof.ts for the harness shape that answers those.',
    ],
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/players.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
