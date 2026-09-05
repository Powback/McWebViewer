/**
 * What a 1 Hz roster poll has to become before it can be drawn.
 *
 * The bridge reads players with `list` + `data get entity <name> Pos|Rotation|Dimension`
 * about once a second (see live.ts). Rendering those samples where they land is a player
 * that teleports once a second and then stands perfectly still, which reads as broken
 * rather than as slow. This turns the sample stream into a pose stream.
 *
 * THE ONE DECISION EVERYTHING ELSE FOLLOWS: poses are rendered on a DELAY of roughly one
 * sample interval, so the common case is INTERPOLATION between two samples we already
 * have, not extrapolation past the newest one. Extrapolation is a guess, and a guess that
 * is corrected snaps — and a snap backwards is more obviously wrong than honest stepping
 * would have been. So the delay buys accuracy with latency, the latency is a second, and
 * the HUD says out loud how far behind the players are drawn. It is not hidden.
 *
 * Extrapolation still exists, because a poll that is 200 ms late must not freeze everyone
 * on screen. It is capped at MAX_EXTRAPOLATE_MS and then the pose HOLDS: when the server
 * has gone quiet the honest picture is a player standing where he was last seen, flagged
 * stale, not a player who keeps walking through a wall on the strength of a stale
 * velocity. `TrackPose.stale` is that flag and callers are expected to show it.
 *
 * Two motions are deliberately NOT smoothed:
 *  - a teleport (more than TELEPORT_SPEED blocks per second between samples) snaps,
 *    because gliding a player across half a kilometre is a lie about what happened;
 *  - a dimension change discards the buffer outright, so nothing is ever interpolated
 *    between a nether coordinate and an overworld one — those two numbers are not on the
 *    same map and a line drawn between them crosses terrain that does not exist.
 */

/** One roster reading of one player, in the units the renderer wants. */
export interface TrackSample {
  pos: readonly [number, number, number];
  /** heading in degrees about +Y, i.e. `entityYawDeg` already applied */
  yawDeg: number;
  dimension: string;
  /** local clock (performance.now) at which this reading was RECEIVED */
  at: number;
}

/** What to draw this frame. */
export interface TrackPose {
  name: string;
  pos: [number, number, number];
  yawDeg: number;
  dimension: string;
  /** age of the newest sample behind this pose, in ms — always > 0, that is the point */
  ageMs: number;
  /**
   * The pose is being HELD rather than tracked: no sample has arrived for longer than the
   * render delay plus the extrapolation window. The position on screen is the last one the
   * server actually reported. Callers must make this visible.
   */
  stale: boolean;
}

/** The roster entry shape this consumes — a structural subset of `LivePlayer`. */
export interface RosterEntry {
  name: string;
  pos: readonly [number, number, number];
  yawDeg: number;
  /** null when the bridge could not read it; such a player is TRACKED but never DRAWN */
  dimension: string | null;
}

/** Starting guess before two polls have been seen; the real interval is measured. */
const DEFAULT_INTERVAL_MS = 1000;
/** Poll intervals outside this range are treated as a reconnect, not as a new cadence. */
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 3000;
/** How heavily a new observed gap moves the running estimate. */
const INTERVAL_EMA = 0.2;
/**
 * Slack added to the render delay on top of the measured interval.
 *
 * RCON round-trips vary by tens of milliseconds (measured: ~3-6 ms median, 26-50 ms p95),
 * so a delay of exactly one interval starves the buffer on every slow poll and spends its
 * time extrapolating — which is the thing the delay exists to avoid.
 */
const JITTER_MS = 80;
/**
 * How far past the newest sample a pose may be dead-reckoned before it is held instead.
 *
 * Sized well under a poll interval: this covers a late sample, not a dead bridge. At a
 * sprint (5.6 blocks/s) it is worth about 2 blocks of guess, which is the most a wrong
 * guess should ever be allowed to cost.
 */
const MAX_EXTRAPOLATE_MS = 350;
/**
 * Above this speed between two samples, the player did not walk — they were teleported,
 * or rode a portal, or the server hitched. Elytra tops out around 33 blocks/s, so this
 * sits above anything a body can do under its own power and below anything a `/tp` does.
 */
const TELEPORT_SPEED = 45;
/** Samples older than the two needed to interpolate are only useful for late arrivals. */
const MAX_SAMPLES = 4;
/**
 * The correction budget, as a speed.
 *
 * The interpolated target can move discontinuously — a late sample lands and corrects an
 * extrapolation, a sample arrives out of order — and a discontinuity is the thing this
 * module exists to remove. So the DRAWN position chases the target at a bounded speed
 * instead of jumping to it: at most half again the speed the server says the player is
 * doing, plus a small floor so a standing player's correction still resolves.
 *
 * Deliberately a speed cap and not an exponential ease. An ease with one time constant has
 * to trade correction rate against steady-state lag — fast enough to absorb a correction in
 * under a second means a permanent lag of a third of a block at a sprint, and the whole
 * point of the render delay is that the position should be RIGHT. A cap has no such trade:
 * while the target is moving smoothly the step is inside the budget, so the drawn position
 * equals the target exactly and nothing lags at all.
 */
const SPEED_TOLERANCE = 1.5;
const CATCHUP_SPEED = 2.5;
/** The same, for facing. A body may turn fast; it may not spin. */
const MAX_YAW_RATE = 540;
/**
 * Beyond this, do not chase: SNAP. A teleport must look like a teleport, and sliding
 * smoothly across four blocks of wall is the failure that smoothing everything produces.
 */
const SNAP_BLOCKS = 4;

/**
 * How a track that the roster stops listing is treated.
 *
 * A PLAYER who leaves the roster logged out: the track plays out its last second and is
 * dropped. A TURTLE that leaves `computercraft dump` was unloaded or broken — it is still,
 * as far as anyone knows, where it was last seen, and the only honest thing to draw is that
 * position, held exactly (no dead reckoning past a reading known to be the last) and marked
 * STALE. `holdLost` selects the second behaviour.
 */
export interface TrackOptions {
  holdLost?: boolean;
}

interface Track {
  samples: TrackSample[];
  /** local clock at which the roster stopped listing this player, or null while online */
  departedAt: number | null;
  /** with `holdLost`: when the roster stopped listing this track, or null while listed */
  lostAt: number | null;
  /** the eased position actually drawn, null until the first pose is produced */
  rendered: [number, number, number] | null;
  renderedYaw: number;
}

export class PlayerTracks {
  private tracks = new Map<string, Track>();
  private intervalMs = DEFAULT_INTERVAL_MS;
  private lastRosterAt: number | null = null;
  private lastPoseAt: number | null = null;

  /**
   * Players the bridge listed but whose dimension it could not read.
   *
   * They are NOT drawn. Drawing them here would mean assuming they are in the dimension
   * this viewer happens to show, which is the plausible-looking default that turns a failed
   * read into confident wrong output. Exposed so the HUD can name them instead.
   */
  readonly unknownDimension = new Set<string>();

  constructor(private drawnDimension: string, private opts: TrackOptions = {}) {}

  /** How far behind live the poses are, in ms. Report this; do not hide it. */
  get delayMs(): number {
    return this.intervalMs + JITTER_MS;
  }

  /** The measured roster cadence, for the HUD and the tests. */
  get sampleIntervalMs(): number {
    return this.intervalMs;
  }

  /** Every player currently tracked, in a stable order — what "follow next" cycles. */
  names(): string[] {
    return [...this.tracks.keys()].sort();
  }

  /**
   * Fold one roster message in.
   *
   * `now` is the local clock, not the bridge's: the two machines' clocks need not agree,
   * and every interval this module measures is a local one.
   */
  ingest(roster: readonly RosterEntry[], now: number): void {
    this.measureInterval(now);
    const seen = new Set<string>();
    this.unknownDimension.clear();
    for (const entry of roster) {
      if (entry.dimension === null) {
        this.unknownDimension.add(entry.name);
        continue;
      }
      seen.add(entry.name);
      this.push(entry, now);
    }
    // A player the roster no longer lists has gone — but the poses are a second behind, so
    // the last second of their movement has not been drawn yet. Mark the departure and let
    // `poses` play it out; deleting here would make everyone vanish a second early and, at
    // 1 Hz, a second early is halfway across a room.
    for (const [name, track] of this.tracks) {
      if (seen.has(name)) continue;
      if (this.opts.holdLost) {
        if (track.lostAt === null) track.lostAt = now;
      } else if (track.departedAt === null) {
        track.departedAt = now;
      }
    }
  }

  private measureInterval(now: number): void {
    const prev = this.lastRosterAt;
    this.lastRosterAt = now;
    if (prev === null) return;
    const gap = now - prev;
    // A gap outside the plausible range is a reconnect or a stalled bridge, and folding it
    // into the cadence would move the render delay for every player for minutes afterwards.
    if (gap < MIN_INTERVAL_MS || gap > MAX_INTERVAL_MS) return;
    this.intervalMs += (gap - this.intervalMs) * INTERVAL_EMA;
  }

  private push(entry: RosterEntry, now: number): void {
    const track = this.tracks.get(entry.name) ?? newTrack();
    this.tracks.set(entry.name, track);
    track.departedAt = null;
    track.lostAt = null;
    const sample: TrackSample = {
      pos: entry.pos,
      yawDeg: entry.yawDeg,
      dimension: entry.dimension as string,
      at: now,
    };
    if (discontinuous(track.samples.at(-1), sample)) track.samples.length = 0;
    track.samples.push(sample);
    if (track.samples.length > MAX_SAMPLES) track.samples.shift();
  }

  /**
   * Every pose to draw this frame.
   *
   * Call exactly once per frame and keep the result: the easing step reads the time since
   * the previous call, so a second call in the same frame advances the smoothing twice and
   * a caller that wants one player's pose must take it out of this list rather than ask
   * again.
   */
  poses(now: number): TrackPose[] {
    const dt = this.lastPoseAt === null ? 0 : Math.min(0.1, (now - this.lastPoseAt) / 1000);
    this.lastPoseAt = now;
    const renderAt = now - this.delayMs;
    const out: TrackPose[] = [];
    for (const [name, track] of this.tracks) {
      const target = sampleAt(track, renderAt);
      if (!target) {
        // Departed AND played out. This is the only place a track is forgotten, so a player
        // never disappears part-way through a frame — the mesh goes when the pose does.
        this.tracks.delete(name);
        continue;
      }
      if (target.dimension !== this.drawnDimension) {
        // Tracked, deliberately not drawn. Forget the eased position so a return to this
        // dimension appears where the player is, rather than gliding in from the portal.
        track.rendered = null;
        continue;
      }
      out.push(this.ease(name, track, target, dt, now));
    }
    return out;
  }

  private ease(
    name: string,
    track: Track,
    target: Target,
    dt: number,
    now: number,
  ): TrackPose {
    const newest = track.samples.at(-1)!;
    const ageMs = now - newest.at;
    chase(track, target, dt);
    return {
      name,
      pos: [...track.rendered!] as [number, number, number],
      yawDeg: track.renderedYaw,
      dimension: target.dimension,
      ageMs,
      stale: ageMs > this.delayMs + MAX_EXTRAPOLATE_MS,
    };
  }
}

/** Move the drawn position toward the target without ever exceeding the budget. */
function chase(track: Track, target: Target, dt: number): void {
  const gap = track.rendered ? distance(track.rendered, target.pos) : Infinity;
  if (gap > SNAP_BLOCKS || dt <= 0) {
    track.rendered = [...target.pos] as [number, number, number];
    track.renderedYaw = target.yawDeg;
    return;
  }
  const budget = (target.speed * SPEED_TOLERANCE + CATCHUP_SPEED) * dt;
  const t = gap <= budget ? 1 : budget / gap;
  for (let i = 0; i < 3; i++) {
    track.rendered![i] += (target.pos[i] - track.rendered![i]) * t;
  }
  const turn = shortestArc(track.renderedYaw, target.yawDeg);
  const maxTurn = MAX_YAW_RATE * dt;
  track.renderedYaw += Math.abs(turn) <= maxTurn ? turn : Math.sign(turn) * maxTurn;
}

function newTrack(): Track {
  return { samples: [], departedAt: null, lostAt: null, rendered: null, renderedYaw: 0 };
}

/**
 * Is the step from `prev` to `next` something a body could have done?
 *
 * A dimension change is never continuous whatever the numbers say — nether coordinates are
 * an eighth of overworld ones, so two adjacent readings across a portal can be metres apart
 * and describe a journey of kilometres. Distance alone would happily interpolate that.
 */
function discontinuous(prev: TrackSample | undefined, next: TrackSample): boolean {
  if (!prev) return false;
  if (prev.dimension !== next.dimension) return true;
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0) return true;
  return distance(prev.pos, next.pos) / dt > TELEPORT_SPEED;
}

/**
 * Where to aim this frame, and how fast the server says the player is going.
 *
 * The speed comes out with the position because the correction budget is derived from it —
 * see `chase`. A stationary player and a sprinting one need different budgets, and the only
 * thing that knows which is which is the segment the pose was interpolated from.
 */
interface Target {
  pos: readonly [number, number, number];
  yawDeg: number;
  dimension: string;
  /** blocks per second along the segment this pose came from */
  speed: number;
}

/**
 * Where the player was at `renderAt`, from the samples on hand.
 *
 * Returns null only when the track is finished — departed, and the render clock has passed
 * the last thing we know about them.
 */
function sampleAt(track: Track, renderAt: number): Target | null {
  const s = track.samples;
  if (!s.length) return null;
  const newest = s[s.length - 1];
  if (track.departedAt !== null && renderAt > newest.at) return null;
  // Lost, not departed: the last reading is the last thing known. Hold it exactly — no
  // dead reckoning past a sample we know nothing followed — and let `stale` say so.
  if (track.lostAt !== null && renderAt > newest.at) return still(newest);
  // Before the buffer starts: a player who just appeared. Hold them at their first known
  // position rather than reaching backwards for a history that does not exist.
  if (renderAt <= s[0].at) return still(s[0]);
  for (let i = 0; i + 1 < s.length; i++) {
    if (renderAt <= s[i + 1].at) {
      const span = s[i + 1].at - s[i].at;
      return lerpSample(s[i], s[i + 1], span > 0 ? (renderAt - s[i].at) / span : 1);
    }
  }
  return extrapolate(s, renderAt);
}

function still(sample: TrackSample): Target {
  return { pos: sample.pos, yawDeg: sample.yawDeg, dimension: sample.dimension, speed: 0 };
}

/**
 * Past the newest sample: dead-reckon briefly, then HOLD.
 *
 * The hold is the important half. Coasting on a stale velocity is how a paused server ends
 * up drawing a player walking calmly through the floor, and there is nothing on screen to
 * distinguish that from a player who is really walking.
 */
function extrapolate(s: TrackSample[], renderAt: number): Target {
  const newest = s[s.length - 1];
  const prev = s.length >= 2 ? s[s.length - 2] : null;
  const lead = Math.min(renderAt - newest.at, MAX_EXTRAPOLATE_MS) / 1000;
  const dt = prev ? (newest.at - prev.at) / 1000 : 0;
  if (!prev || lead <= 0 || dt <= 0) return still(newest);
  const pos: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    pos[i] = newest.pos[i] + ((newest.pos[i] - prev.pos[i]) / dt) * lead;
  }
  return {
    pos,
    yawDeg: newest.yawDeg,
    dimension: newest.dimension,
    speed: distance(newest.pos, prev.pos) / dt,
  };
}

function lerpSample(a: TrackSample, b: TrackSample, t: number): Target {
  const pos: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) pos[i] = a.pos[i] + (b.pos[i] - a.pos[i]) * t;
  const span = (b.at - a.at) / 1000;
  return {
    pos,
    yawDeg: a.yawDeg + shortestArc(a.yawDeg, b.yawDeg) * t,
    dimension: b.dimension,
    speed: span > 0 ? distance(a.pos, b.pos) / span : 0,
  };
}

/**
 * Degrees from `from` to `to` the short way round.
 *
 * A player turning from 355 to 5 turned ten degrees right, not 350 degrees left. Lerping
 * the raw numbers spins the model most of the way round the compass once per turn, which
 * is far more visible than the teleporting this module set out to fix.
 */
export function shortestArc(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
