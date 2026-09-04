/**
 * What the 1 Hz roster has to look like by the time it reaches the screen.
 *
 * The claims here are the ones a screenshot cannot make and a demo cannot disprove, because
 * every one of them is about MOTION over time:
 *
 *   - a player walking reads as walking, not as a teleport once a second;
 *   - the smoothed path is close to the real one, not merely smooth (a lag of a whole
 *     sample is also perfectly smooth, and wrong);
 *   - a sample that is late is bridged briefly and then the pose is HELD and marked stale,
 *     rather than dead-reckoned into the middle distance;
 *   - when that late sample finally lands, the correction does not go BACKWARDS visibly —
 *     a snap-back is the specific failure that makes extrapolation worse than stepping;
 *   - a teleport, a dimension change and a logout are each drawn as what they are.
 *
 * The numbers below are asserted against a ground truth the test itself defines, so a
 * regression shows up as a distance in blocks rather than as "it looks wrong".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerTracks, shortestArc, type RosterEntry, type TrackPose } from './player-tracks.js';

const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const POLL_MS = 1000;
const FRAME_MS = 16;
/** Vanilla sprint. Everything below moves at a speed a real player can produce. */
const SPRINT = 5.6;

type Vec = [number, number, number];

interface Frame {
  t: number;
  pose: TrackPose | null;
  truth: Vec | null;
}

/**
 * Run a world: a ground-truth position function sampled at the poll rate and rendered at
 * the frame rate, exactly as the app does it.
 *
 * `truth` returning null means the player is not on the server at that moment, so the
 * roster does not list them — which is how logging out is expressed here.
 */
function simulate(opts: {
  truth: (t: number) => Vec | null;
  until: number;
  /** yaw in degrees at time t, if the test cares */
  yaw?: (t: number) => number;
  dimension?: (t: number) => string;
  /** polls inside this window never arrive — a stalled bridge */
  dropBetween?: [number, number];
  tracks?: PlayerTracks;
}): { frames: Frame[]; tracks: PlayerTracks } {
  const tracks = opts.tracks ?? new PlayerTracks(OVERWORLD);
  const roster = (at: number): RosterEntry[] => {
    const pos = opts.truth(at);
    if (!pos) return [];   // not listed by `list`: they are not on the server
    return [{
      name: 'Ada',
      pos,
      yawDeg: opts.yaw?.(at) ?? 0,
      dimension: opts.dimension?.(at) ?? OVERWORLD,
    }];
  };
  const arrives = (at: number) =>
    !opts.dropBetween || at < opts.dropBetween[0] || at > opts.dropBetween[1];

  const frames: Frame[] = [];
  let nextPoll = 0;
  for (let t = 0; t <= opts.until; t += FRAME_MS) {
    while (t >= nextPoll) {
      if (arrives(nextPoll)) tracks.ingest(roster(nextPoll), nextPoll);
      nextPoll += POLL_MS;
    }
    const pose = tracks.poses(t).find((p) => p.name === 'Ada') ?? null;
    frames.push({ t, pose, truth: opts.truth(t) });
  }
  return { frames, tracks };
}

/** Straight-line walk along +X at `speed` blocks per second, starting at the origin. */
const walking = (speed: number) => (t: number): Vec => [(speed * t) / 1000, 64, 0];

/** The biggest jump between two consecutive drawn positions. THE teleport metric. */
function maxStep(frames: Frame[]): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].pose;
    const b = frames[i].pose;
    if (!a || !b) continue;
    worst = Math.max(worst, dist(a.pos, b.pos));
  }
  return worst;
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * How far the drawn position is from where the player really was `lagMs` ago.
 *
 * `lagMs` is not a fudge factor: the poses are DELIBERATELY drawn one sample interval
 * behind so that the common case is interpolation between two readings we already have
 * rather than a guess past the newest one. The delay is reported in the HUD. What this
 * measures is whether the delayed picture is ACCURATE — a smoothing that merely lags is
 * also perfectly smooth, and wrong by a whole sample.
 */
function errorVsTruth(
  frames: Frame[],
  truth: (t: number) => Vec | null,
  from: number,
  lagMs: number,
): { mean: number; max: number } {
  const errs = frames
    .filter((f) => f.t >= from && f.pose)
    .map((f) => dist(f.pose!.pos, truth(f.t - lagMs)!));
  return {
    mean: errs.reduce((a, b) => a + b, 0) / errs.length,
    max: Math.max(...errs),
  };
}

// ---------------------------------------------------------------------------
// Motion

/**
 * THE FAILURE THIS MODULE EXISTS TO REMOVE. Rendering the sample where it lands moves the
 * player 5.6 blocks in one frame and then not at all for a second. Sixty frames of nothing
 * and one frame of five blocks is not slow movement, it is a teleport, and it is what a
 * viewer of a drone fleet spends the whole session looking at.
 */
test('a walking player moves every frame instead of jumping once a second', () => {
  const { frames } = simulate({ truth: walking(SPRINT), until: 8000 });

  const drawn = frames.filter((f) => f.pose);
  assert.ok(drawn.length > 400, 'the player has to be drawn throughout');
  // One frame of a sprint is 0.09 blocks. Allow generous headroom and still be two orders
  // of magnitude away from the 5.6 blocks a raw sample stream produces.
  assert.ok(maxStep(frames) < 0.3, `biggest single-frame jump was ${maxStep(frames)} blocks`);
  // And it really moved: not smooth because it is frozen.
  const travelled = dist(drawn[0].pose!.pos, drawn.at(-1)!.pose!.pos);
  assert.ok(travelled > 30, `only travelled ${travelled} blocks`);
});

/**
 * Smooth is not the same as right.
 *
 * The cheap way to get smooth is to ease toward the newest sample, which produces a path
 * that lags by a whole, VARYING amount — it falls a sample behind just after a poll and
 * catches up just before the next, so a player walking at a constant speed is drawn
 * surging and slowing. The buffered interpolation here is behind by a CONSTANT delay
 * instead, and inside that delay the path is the real one. This pins that: the drawn
 * position matches the truth from exactly `delayMs` ago, to within centimetres.
 */
test('the drawn path is the real path, offset by the delay it declares', () => {
  const { frames, tracks } = simulate({ truth: walking(SPRINT), until: 8000 });

  // From 3 s: past the initial fill of the buffer, which has nothing to interpolate from.
  const err = errorVsTruth(frames, walking(SPRINT), 3000, tracks.delayMs);
  assert.ok(err.mean < 0.05, `mean error against ground truth was ${err.mean} blocks`);
  assert.ok(err.max < 0.2, `worst error against ground truth was ${err.max} blocks`);
  // And the delay is a stated number, not an emergent one. The HUD prints it.
  assert.ok(tracks.delayMs > tracks.sampleIntervalMs && tracks.delayMs < 2000);
});

test('a player who never moves is drawn perfectly still', () => {
  const { frames } = simulate({ truth: () => [10, 64, 20] as Vec, until: 5000 });

  assert.equal(maxStep(frames), 0, 'a still player must not shimmer');
  assert.deepEqual(frames.at(-1)!.pose!.pos, [10, 64, 20]);
});

// ---------------------------------------------------------------------------
// Late and missing samples

/**
 * The bridge going quiet must not move anybody. Coasting on the last velocity would walk a
 * player calmly through a wall for as long as the outage lasts, and nothing on screen would
 * distinguish that from a player who is really walking.
 */
test('when samples stop, the pose is held and marked stale rather than flown onward', () => {
  const { frames } = simulate({
    truth: walking(SPRINT),
    until: 10_000,
    // The bridge stops answering at 4 s and does not come back.
    dropBetween: [4000, Infinity],
  });

  const late = frames.filter((f) => f.t > 7000 && f.pose);
  assert.ok(late.length, 'the player must still be drawn — they did not log out');
  assert.ok(late.every((f) => f.pose!.stale), 'and every one of those poses is STALE');
  // Held: the last three seconds of the outage moved it not at all.
  const spread = dist(late[0].pose!.pos, late.at(-1)!.pose!.pos);
  assert.ok(spread < 0.01, `a held pose drifted ${spread} blocks`);
  // And it was held near the last KNOWN position — the last successful poll was at 3 s —
  // not wherever a second of dead reckoning would have run to.
  const lastKnown = walking(SPRINT)(3000);
  assert.ok(dist(late[0].pose!.pos, lastKnown) < 2.5,
    `held ${dist(late[0].pose!.pos, lastKnown)} blocks past the last real sample`);
});

/**
 * THE REASON EXTRAPOLATION IS CAPPED. A guess that is corrected snaps, and a snap backwards
 * is more obviously wrong than never guessing at all — it reads as the player rubber-banding
 * or as the viewer being broken. One late poll is bridged; the correction that follows must
 * not be visible as a reversal.
 */
test('a late sample is bridged, and its correction never moves the player backwards', () => {
  // One poll lost, then the stream resumes: the classic case for a short extrapolation.
  const { frames } = simulate({
    truth: walking(SPRINT),
    until: 9000,
    dropBetween: [4000, 4000],
  });

  let worstBackwards = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].pose;
    const b = frames[i].pose;
    if (!a || !b) continue;
    worstBackwards = Math.max(worstBackwards, a.pos[0] - b.pos[0]);
  }
  assert.ok(worstBackwards < 0.02,
    `the player was drawn moving backwards by ${worstBackwards} blocks`);
  assert.ok(maxStep(frames) < 0.3, 'and the correction was not a jump forwards either');
});

// ---------------------------------------------------------------------------
// Teleports, dimensions, joining and leaving

/**
 * A teleport is not motion and must not be drawn as motion. Easing across it would show the
 * player gliding through several hundred blocks of terrain they were never in.
 */
test('a teleport snaps; it is not glided across', () => {
  const there: Vec = [0, 64, 0];
  const elsewhere: Vec = [900, 70, -400];
  const { frames } = simulate({
    truth: (t) => (t < 3000 ? there : elsewhere),
    until: 7000,
  });

  const drawn = frames.filter((f) => f.pose);
  // Every drawn position is at one end or the other; nothing is ever in between.
  for (const f of drawn) {
    const atA = dist(f.pose!.pos, there) < 0.01;
    const atB = dist(f.pose!.pos, elsewhere) < 0.01;
    assert.ok(atA || atB, `drawn mid-teleport at ${f.pose!.pos.join(',')}`);
  }
  assert.ok(dist(drawn.at(-1)!.pose!.pos, elsewhere) < 0.01, 'and it ended up at the far end');
});

/**
 * `dimension` is in the payload and it has to be used. Nether coordinates are an eighth of
 * overworld ones, so a nether player drawn on the overworld map is not merely in the wrong
 * place, they are somewhere plausible — which is worse.
 */
test('a player in another dimension is tracked and not drawn', () => {
  const { frames, tracks } = simulate({
    truth: () => [100, 64, 100] as Vec,
    dimension: (t) => (t < 3000 ? OVERWORLD : NETHER),
    until: 8000,
  });

  assert.ok(frames.find((f) => f.t === 2000)?.pose, 'drawn while in the overworld');
  assert.equal(frames.at(-1)!.pose, null, 'and gone once they are in the nether');
  assert.ok(tracks.names().includes('Ada'), 'still TRACKED — they have not logged out');
});

test('coming back from another dimension appears where they are, without a streak', () => {
  const { frames } = simulate({
    truth: (t) => (t < 3000 ? [100, 64, 100] : [40, 70, -60]) as Vec,
    dimension: (t) => (t >= 3000 && t < 6000 ? NETHER : OVERWORLD),
    until: 11_000,
  });

  const back = frames.filter((f) => f.t > 8000 && f.pose);
  assert.ok(back.length, 'they have to come back');
  for (const f of back) {
    assert.ok(dist(f.pose!.pos, [40, 70, -60]) < 0.01,
      `drawn at ${f.pose!.pos.join(',')} on the way back from the nether`);
  }
});

/**
 * A player whose Dimension read failed is a fact we do not have. Drawing them in the
 * dimension that happens to be on screen is the plausible-looking default this codebase
 * keeps paying for, so they are withheld and NAMED instead.
 */
test('a player with an unreadable dimension is not drawn, and is named', () => {
  const tracks = new PlayerTracks(OVERWORLD);

  tracks.ingest([{ name: 'Ada', pos: [1, 64, 2], yawDeg: 0, dimension: null }], 0);
  const poses = tracks.poses(2000);

  assert.deepEqual(poses, [], 'a dimension we could not read is not a dimension we can draw');
  assert.deepEqual([...tracks.unknownDimension], ['Ada'], 'and the HUD is told who');
});

/**
 * Leaving has to be CLEAN: not a body left standing in an empty world, and not a
 * disappearance a second before the last position anyone saw them at. Because the poses run
 * a sample behind, a player who logs out still has that last second left to play out.
 */
test('a player who logs out finishes their last known second and then goes', () => {
  const { frames } = simulate({
    truth: (t) => (t < 5000 ? walking(SPRINT)(t) : null),
    until: 9000,
  });

  const last = frames.filter((f) => f.pose).at(-1)!;
  assert.ok(last.t > 5000, 'the last second of movement is drawn, not thrown away');
  assert.ok(last.t < 7000, `still on screen ${last.t}ms in — a logged-out player must go`);
  // Nothing after it: gone, and gone once.
  assert.ok(frames.filter((f) => f.t > last.t).every((f) => !f.pose), 'and stays gone');
  // The last poll that listed them was at 4 s, so that is the last thing anybody knows —
  // and it is where they must be when they wink out.
  assert.ok(dist(last.pose!.pos, walking(SPRINT)(4000)) < 0.5,
    `left from ${last.pose!.pos.join(',')}, ${dist(last.pose!.pos, walking(SPRINT)(4000))}`
      + ' blocks from where they were last seen');
});

test('a player who joins appears at their position rather than sliding in from nowhere', () => {
  const { frames } = simulate({
    truth: (t) => (t < 2000 ? null : [500, 64, -300] as Vec),
    until: 6000,
  });

  const first = frames.find((f) => f.pose)!;
  assert.deepEqual(first.pose!.pos, [500, 64, -300]);
  assert.equal(maxStep(frames), 0, 'and does not travel from the origin to get there');
});

// ---------------------------------------------------------------------------
// Facing

test('a turn past north takes the short way round', () => {
  const tracks = new PlayerTracks(OVERWORLD);
  const at = (t: number, yawDeg: number) =>
    tracks.ingest([{ name: 'Ada', pos: [0, 64, 0], yawDeg, dimension: OVERWORLD }], t);

  at(0, 355);
  at(1000, 355);
  at(2000, 5);
  const seen: number[] = [];
  for (let t = 2100; t <= 3200; t += FRAME_MS) {
    const pose = tracks.poses(t)[0];
    if (pose) seen.push(((pose.yawDeg % 360) + 360) % 360);
  }

  assert.ok(seen.length, 'the player has to be drawn while turning');
  // Every heading is within ten degrees of north on one side or the other. Lerping the raw
  // numbers would spin 350 degrees the other way and pass through south.
  for (const y of seen) {
    assert.ok(y > 345 || y < 15, `turned through ${y} degrees to get from 355 to 5`);
  }
});

test('shortestArc is the short way round in both directions', () => {
  assert.equal(shortestArc(355, 5), 10);
  assert.equal(shortestArc(5, 355), -10);
  assert.equal(shortestArc(0, 180), 180);
  assert.equal(shortestArc(10, 10), 0);
});

// ---------------------------------------------------------------------------
// Cadence

test('the render delay is measured from the polls, not assumed', () => {
  const tracks = new PlayerTracks(OVERWORLD);
  const roster: RosterEntry[] = [{ name: 'Ada', pos: [0, 64, 0], yawDeg: 0, dimension: OVERWORLD }];

  // A bridge polling twice as fast should not leave the viewer a second behind.
  for (let t = 0; t <= 30_000; t += 500) tracks.ingest(roster, t);

  assert.ok(tracks.sampleIntervalMs < 700,
    `still thinks the poll is ${tracks.sampleIntervalMs}ms apart`);
  assert.ok(tracks.delayMs > tracks.sampleIntervalMs, 'with slack for jitter on top');
});

test('a reconnect gap does not become the new cadence', () => {
  const tracks = new PlayerTracks(OVERWORLD);
  const roster: RosterEntry[] = [{ name: 'Ada', pos: [0, 64, 0], yawDeg: 0, dimension: OVERWORLD }];

  for (let t = 0; t <= 10_000; t += 1000) tracks.ingest(roster, t);
  const before = tracks.delayMs;
  tracks.ingest(roster, 90_000);   // eighty seconds of nothing, then a reconnect

  assert.equal(tracks.delayMs, before,
    'an outage must not push the render delay out for everybody afterwards');
});
