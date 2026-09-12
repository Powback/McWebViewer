/**
 * Client-side movement prediction, on the game's own constants.
 *
 * WHAT THIS FIXES. Before this, pressing W did nothing on screen until the server said so:
 * the intent went out over RCON (p95 ~50 ms, drained on the tick thread), the server moved
 * the player, and the browser learned about it on the next `Pos` poll (100 ms). The camera
 * then converged onto that. Roughly 100-200 ms of input latency, none of it hidden. See
 * PARITY-AUDIT.md §2.
 *
 * Now the browser runs the same motion locally the instant the key goes down, and the
 * server's reports correct it.
 *
 * THE NUMBERS ARE THE GAME'S, NOT MINE. Gravity, jump strength, step height, the player's
 * box, and the sneak and sprint multipliers all come from `physics.json`, which
 * `harness/src/mcextract/ExtractPhysics.java` reads out of the real deobfuscated client by
 * booting its registries and asking. Collision is the real per-state `VoxelShape`, so a
 * slab is half a block, a stair is a stair, and a fence is a post — see block-shapes.ts.
 * An earlier draft of this file had hand-tuned constants and whole-cube collision; the
 * difference is the difference between a plausible feel and the right one.
 *
 * THREE DECISIONS THAT ARE NOT OBVIOUS:
 *
 * 1. **Reconciliation is a decaying offset, not rollback-and-replay.** The textbook
 *    netcode answer — keep an input history, re-simulate from the last acknowledged state
 *    — is wrong here, because the server is not replaying our input timeline. It is
 *    executing a STATEFUL command: `player X move forward` walks until `player X stop`
 *    (bridge/src/fake-player.mjs:283-298). There is no per-tick input for the server to
 *    acknowledge and nothing to replay against. So we run the same motion immediately and
 *    are continuously pulled toward the server's own (dead-reckoned) position. In steady
 *    state the two agree and the pull is a no-op; the lead exists exactly during the round
 *    trip, which is the latency being hidden.
 *
 * 2. **Horizontal SPEED is still measured, not computed.** Everything else here is exact,
 *    but ground speed is the one thing the extraction cannot hand over: vanilla's
 *    `movementSpeed` attribute is 0.1, an input to `getFrictionInfluencedSpeed`, not a
 *    speed — 0.1 x 20 is 2 blocks/s and a player plainly walks faster. Rather than
 *    reimplement friction, `observe()` watches how fast the SERVER actually moved us and
 *    converges on that. It is also the more robust answer: a potion, a soul-sand block, an
 *    armour attribute or a mod all land in the measurement for free.
 *
 * 3. **The drift is a number you can read.** `stats().drift` goes on the HUD. This repo's
 *    rule is that the screen must never quietly lie, and a predictor that disagrees with
 *    the server has to be visible as a number rather than as an unexplained shudder.
 */

import type { BlockShapes } from './block-shapes.js';
import type { Box, MotionConstants } from './physics.js';
import { FALLBACK_MOTION, SEED_SPEED } from './physics.js';

/** Which movement keys are down. Mirrors the `input` frame the bridge already takes. */
export interface PredictIntent {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  /**
   * An analog direction in SCREEN space, from the on-screen joystick.
   *
   * Takes precedence over the booleans when present, because a stick that can only express
   * the eight directions a keyboard has is immediately worse than the keyboard. `x` is
   * right-positive and `y` is FORWARD-positive — converted from the DOM's downward-positive
   * y at the call site, once, rather than leaving two conventions loose in the codebase.
   */
  analog?: { x: number; y: number } | null;
}

/** The boolean half of an intent — the keys a key press can set. */
export type IntentKey = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sneak' | 'sprint';

export const NO_INTENT: PredictIntent = {
  forward: false, back: false, left: false, right: false,
  jump: false, sneak: false, sprint: false,
};

/**
 * Re-exported from physics.ts, which is where it lives now: the path planner needs the same
 * number to work out how far a jump carries the body, and two copies of it would drift.
 */
export { SEED_SPEED } from './physics.js';

/** Terminal-ish, so a fall through unloaded chunks cannot run away. */
const MAX_FALL = 60;

/**
 * The furthest the body may move along an axis before collision is checked again.
 *
 * See `moveAxis`. Under a trapdoor's 0.1875, which is the thinnest collision box in the
 * extracted table that a body has any business being stopped by.
 */
const MAX_SWEEP = 0.15;

/**
 * How fast the predicted position is pulled onto the server's, per second.
 *
 * Deliberately slow. A fast pull eats the lead this class exists to create — the lead IS
 * the hidden latency — while a slow one still removes any persistent bias within a second.
 */
const RECONCILE_RATE = 3.5;
/**
 * Past this much disagreement the pull is abandoned and the position is snapped.
 *
 * This is the teleport / knockback / "fell in a hole the client did not know about" path.
 * Big enough that ordinary approximation never trips it, small enough that a real
 * divergence is corrected before it becomes a walk through scenery.
 */
const RESYNC_BLOCKS = 2.5;

/** Nudging below this is not worth the arithmetic and just jitters. */
const DEADZONE = 0.01;

/**
 * A jump this big is a teleport, a respawn or a dimension change — never locomotion.
 *
 * Kept far above `RESYNC_BLOCKS` because it is the ONE correction that still applies when
 * the server's ordinary motion has been judged unusable: wherever the player really is,
 * they are not 64 blocks from where they were a tenth of a second ago by walking.
 */
const TELEPORT_BLOCKS = 64;

/**
 * How far the server's speed may differ from ours before its clock is judged unreliable.
 *
 * TWO-SIDED, and it has to be. A server running fast drags the player along; a server
 * running slow acts as a brake and then snaps progress away when the gap trips the resync
 * threshold. Both make displacement per real second follow the tick rate, which is the bug.
 * This world targets 200 ticks/s and manages about 145, against vanilla's 20 — so the ratio
 * here is around 7 — but a struggling server sits the other side of 1 and is just as wrong.
 *
 * Compared against what the LOCAL body is doing rather than against a constant, so sprinting
 * and sneaking move the expectation with it instead of tripping the test.
 */
const SERVER_SPEED_TOLERANCE = 2;

/** Below this the body is effectively standing, and any server motion is worth honouring. */
const MOVING_THRESHOLD = 0.5;

/**
 * The most reconciliation may contribute, as a fraction of walking speed.
 *
 * THIS IS WHAT MAKES WALKING SPEED INDEPENDENT OF THE SERVER'S CLOCK, and it is the whole
 * fix in one constant. Reconciliation used to pull at a rate comparable to walking (3.5
 * blocks/s against a walk of 4.3), so a server running fast dragged the player along with
 * it and a server running slow acted as a brake — displacement per real second followed the
 * tick rate in both directions.
 *
 * Bounded at a twelfth of walking speed, the correction can only ever shift the measured
 * speed by that much, whatever the server is doing; locomotion comes from the local
 * simulation, which integrates real seconds. Genuine divergence is still caught, just by
 * `RESYNC_BLOCKS` rather than by out-running the player.
 */
const MAX_CORRECTION_FRACTION = 0.08;

export interface PredictStats {
  /** how far the prediction currently is from the server's reported position, in blocks */
  drift: number;
  /** base walking speed in blocks/s, as measured from the server's own motion */
  speed: number;
  /** how many samples have contributed to `speed`; 0 means it is still the seed */
  calibrations: number;
  /** hard resyncs since join — a teleport, a knockback, or a badly wrong prediction */
  resyncs: number;
  onGround: boolean;
  /** horizontal speed the SERVER's reports imply, blocks per REAL second */
  serverSpeed: number;
  /**
   * False when the server's motion is too fast to be a player moving.
   *
   * Then its position is not a measurement of where the player should be in real time, and
   * this stops reconciling to it — see `reconcile`.
   */
  serverPlausible: boolean;
  /** false when the motion constants are the fallbacks, i.e. physics.json was not loaded */
  measured: boolean;
}

/**
 * A body that walks the streamed voxel world locally and is corrected by the server.
 *
 * Positions are FEET positions, the same convention the bridge's `self` samples use, so
 * nothing has to remember to add or subtract an eye height at the boundary.
 */
export class PredictedBody {
  private pos: [number, number, number] = [0, 0, 0];
  private vel: [number, number, number] = [0, 0, 0];
  private grounded = false;
  private started = false;

  private speed = SEED_SPEED;
  private calibrations = 0;
  private resyncs = 0;
  private drift = 0;

  /** Previous server sample, kept only to measure how fast the server actually moves us. */
  private lastObserved: { pos: [number, number, number]; at: number } | null = null;
  /** The last reconcile target and when, so the server's own speed can be measured. */
  private lastTarget: { pos: [number, number, number]; at: number } | null = null;
  private serverSpeed = 0;
  private serverPlausible = true;
  private serverSamples = 0;
  /** Set for one reconcile when the SERVER's own position jumped between samples. */
  private serverJumped = false;

  constructor(
    private shapes: BlockShapes,
    private motion: MotionConstants = FALLBACK_MOTION,
  ) {}

  /** Swap in the real constants once physics.json has landed. */
  setMotion(motion: MotionConstants): void {
    this.motion = motion;
  }

  /**
   * Swap in a better shape oracle.
   *
   * The body is built before physics.json has been fetched, so it starts on the heuristic
   * tier and is upgraded in place rather than being rebuilt — rebuilding it would drop the
   * position and momentum and snap the camera for no reason the player could see.
   */
  setShapes(shapes: BlockShapes): void {
    this.shapes = shapes;
  }

  /** Point the body at a known-good position and drop all momentum. */
  reset(pos: readonly [number, number, number]): void {
    this.pos = [pos[0], pos[1], pos[2]];
    this.vel = [0, 0, 0];
    this.grounded = false;
    this.started = true;
    this.drift = 0;
    this.lastObserved = null;
  }

  /** False until `reset` has been called, i.e. until a first server sample has landed. */
  get active(): boolean {
    return this.started;
  }

  get position(): [number, number, number] {
    return [this.pos[0], this.pos[1], this.pos[2]];
  }

  /** Feet position plus the game's own eye height — what the camera should sit at. */
  get eye(): [number, number, number] {
    return [this.pos[0], this.pos[1] + this.motion.eyeHeight, this.pos[2]];
  }

  stats(): PredictStats {
    return {
      drift: this.drift,
      speed: this.speed,
      calibrations: this.calibrations,
      resyncs: this.resyncs,
      onGround: this.grounded,
      measured: this.motion.measured,
      serverSpeed: this.serverSpeed,
      serverPlausible: this.serverPlausible,
    };
  }

  /**
   * Advance one frame.
   *
   * `yaw` is the camera's three.js yaw, the same angle the raycast uses, so "walk forward"
   * and "the block the crosshair is on" can never disagree about which way you face.
   */
  step(dt: number, intent: PredictIntent, yaw: number): void {
    if (!this.started || dt <= 0) return;
    const clamped = Math.min(dt, 0.1); // a backgrounded tab must not teleport on return
    this.applyIntent(clamped, intent, yaw);
    this.integrate(clamped);
  }

  private applyIntent(dt: number, intent: PredictIntent, yaw: number): void {
    const [ax, az] = axes(intent, yaw);
    const m = this.motion;
    const mult = intent.sprint ? m.sprintMultiplier : intent.sneak ? m.sneakMultiplier : 1;
    // Horizontal velocity is SET, not accelerated toward. Minecraft's ground friction is
    // stiff enough that the ramp is imperceptible, and setting it is what makes the first
    // frame after a keypress move — which is the entire point of this class.
    this.vel[0] = ax * this.speed * mult;
    this.vel[2] = az * this.speed * mult;
    if (intent.jump && this.grounded) {
      this.vel[1] = m.jumpSpeed;
      this.grounded = false;
    }
    this.vel[1] = Math.max(-MAX_FALL, this.vel[1] - m.gravity * dt);
  }

  /**
   * Move and resolve, one axis at a time.
   *
   * Per-axis is what makes sliding along a wall work: a diagonal into a corner blocks one
   * axis and keeps the other, instead of blocking the whole move and sticking.
   */
  private integrate(dt: number): void {
    const dy = this.vel[1] * dt;
    if (dy < 0 && this.groundUnknown()) {
      // TERRAIN THAT HAS NOT STREAMED IN IS NOT A HOLE.
      //
      // `boxesAt` returns nothing for a chunk the viewer has not loaded, which is right for
      // walking INTO the streaming edge — guessing "wall" there freezes the player against
      // thin air with nothing on screen to explain it. It is exactly wrong for standing ON
      // it: the body fell straight through the floor of every chunk that had not arrived
      // yet, kept accelerating (nothing below is loaded either), and `pushPosition` then
      // teleported the server's bot down into the void after it. Reported from the live
      // server as "it keeps falling into holes and getting stuck", and the "stuck" is the
      // same event: once the body is below the world there is nothing to land on and the
      // server's own position is whatever we last teleported it to, so nothing pulls it
      // back.
      //
      // So downward motion waits for the ground to be knowable. The body hovers for the
      // fraction of a second the chunk takes to arrive and then falls or stands normally,
      // which is a far better wrong answer than a bot at the bottom of the world.
      this.vel[1] = 0;
      this.grounded = true;
      this.moveHorizontal(0, this.vel[0] * dt);
      this.moveHorizontal(2, this.vel[2] * dt);
      return;
    }
    if (this.moveAxis(1, dy)) {
      // Hit something vertically: landed if falling, bonked a ceiling if rising.
      this.grounded = dy < 0;
      this.vel[1] = 0;
    } else if (dy < 0) {
      this.grounded = false;
    }
    this.moveHorizontal(0, this.vel[0] * dt);
    this.moveHorizontal(2, this.vel[2] * dt);
  }

  /**
   * A horizontal move, with the game's own step-up.
   *
   * This is only correct because collision is real shapes now. Against whole cubes the
   * smallest thing to step onto was a full block — something vanilla makes you JUMP over —
   * so a step-up would have climbed every 1-block ledge the server refuses to climb. With
   * the extracted `VoxelShape`s a slab really is 0.5 high and `stepHeight` (0.6, read from
   * `Attributes.STEP_HEIGHT`) catches exactly what vanilla catches.
   */
  private moveHorizontal(axis: 0 | 2, delta: number): void {
    if (delta === 0) return;
    // TERRAIN THAT HAS NOT STREAMED IN IS NOT A DOORWAY, the horizontal twin of the guard in
    // `integrate`. `boxesAt` returns nothing for a chunk the viewer has not loaded, so walking
    // towards one was walking through whatever it contains -- measured against a wall whose chunk
    // was missing: straight through it, 63.5 to 79.70 in four seconds, and through an entirely
    // empty world at full speed. The user reported both halves of this ("theres nothing preventing
    // me from walking through walls in 1p", "the player sinks through the floor", 2026-09-11) and
    // only the sinking half was guarded.
    //
    // Refusing is the same bargain the vertical guard already takes, and self-limiting for the same
    // reason: the chunk arrives in a fraction of a second and the body walks on. Standing still for
    // that fraction is a far better wrong answer than being inside a wall the server can see.
    //
    // NOT the planner's rule, deliberately. nav-world.ts treats unknown as PASSABLE so a route is
    // never planned into a wall it cannot see; this is the body, where the cost of guessing wrong
    // is reversed -- a route that detours still arrives, a body that walks through geometry does not.
    if (this.leadingCellUnknown(axis, delta)) return;
    if (!this.moveAxis(axis, delta)) return;
    if (!this.grounded) return;
    const saved: [number, number, number] = [this.pos[0], this.pos[1], this.pos[2]];
    if (this.moveAxis(1, this.motion.stepHeight)) {
      this.pos = saved;
      return;
    }
    if (this.moveAxis(axis, delta)) {
      // No room up there either: that was a wall, not a step. Put it back.
      this.pos = saved;
      return;
    }
    // Settle back down onto whatever was stepped onto, so the body does not float.
    this.moveAxis(1, -this.motion.stepHeight);
  }

  /**
   * Move along one axis, stopping at the first blocking box. Returns true if blocked.
   *
   * BROKEN INTO SUB-MOVES, and that is not a refinement — it is the fix for a character
   * that fell out of the world. Resolution below is a BISECTION, and a bisection can only
   * find a collision the END of the move is already inside: it moves the body the whole way,
   * asks "is that blocked", and halves back only if the answer is yes. Land past a floor,
   * in the open air underneath it, and the answer is no and the floor was never there.
   *
   * Falling is where that bites, because falling is the only thing here that gets fast.
   * Terminal speed is 60 blocks/s and `step` clamps dt at 0.1, so ONE slow frame can ask
   * for six blocks of travel in a single check — through a one-block floor with a 1.8-block
   * body, which lands clear underneath it about a third of the time. Measured, before this:
   *
   *     17 ms frame    0/100 drops fell through a solid floor
   *     50 ms          5/100
   *     67 ms          32/100
   *
   * A viewer meshing a batch of chunks hitches exactly that much, and the consequence was
   * not a glitch: nothing below the floor is solid either, so the body kept going, and
   * `LiveView.pushPosition` teleported the server's own bot down after it into the void,
   * where there is nothing to land on and nothing to bring it back. Reported from the live
   * server as "it keeps falling into holes and getting stuck".
   *
   * `MAX_SWEEP` is under the thinnest thing with a collision box worth not passing through
   * (a trapdoor, 0.1875). It costs nothing in the common case — a frame of walking is 0.07
   * blocks, one sweep — and only multiplies when the body is moving far enough that it
   * would otherwise be wrong.
   */
  private moveAxis(axis: 0 | 1 | 2, delta: number): boolean {
    if (delta === 0) return false;
    const steps = Math.ceil(Math.abs(delta) / MAX_SWEEP);
    if (steps <= 1) return this.sweep(axis, delta);
    const part = delta / steps;
    for (let i = 0; i < steps; i++) if (this.sweep(axis, part)) return true;
    return false;
  }

  /**
   * One sub-move, resolved by bisection.
   *
   * Eight halvings put the body within about a millimetre of the surface, which is far under
   * what the reconciliation absorbs anyway.
   */
  private sweep(axis: 0 | 1 | 2, delta: number): boolean {
    // A BODY THAT IS ALREADY INSIDE SOMETHING IS ALLOWED TO WALK OUT OF IT.
    //
    // Without this the resolver is a trap with no exit. It works by moving and then halving
    // back until it is clear — so if the body is overlapping geometry BEFORE the move, every
    // candidate position is blocked, the bisection collapses to zero, and the character is
    // frozen for good. It cannot walk out, jump out or fall out.
    //
    // That is not hypothetical. The position is snapped outright by a resync or a teleport,
    // and the world it collides against is streamed — so the body can be put inside a block
    // that the browser thinks is solid without ever having walked into one. Observed on the
    // live server: the bot standing still with the intent reading
    // forward+jump, jumping on the spot for eight seconds, travelling zero blocks, and the
    // walk reporting "stuck" — which is exactly the second half of "it keeps falling into
    // holes and getting stuck".
    //
    // Vanilla pushes an entity out of a block it is inside; this is the cheap equivalent —
    // while overlapping, HORIZONTAL collision does not veto, so the next step carries the
    // body clear and ordinary collision resumes the moment it is.
    //
    // HORIZONTAL ONLY, and that restriction is load bearing. Lifting the veto on the
    // vertical axis too let the body escape DOWNWARDS: buried at y=64, gravity pulled it
    // into the floor block below, which it was also inside, and it sank through the world
    // one block at a time — trading a character that cannot move for a character in the
    // void, which is the worse of the two and the bug next door. Vertical motion keeps its
    // ordinary resolution, which while overlapping resolves to "do not move", so a wedged
    // body holds its height until it has walked out from under whatever it was inside.
    if (axis !== 1 && this.blocked()) {
      this.pos[axis] += delta;
      return false;
    }
    const from = this.pos[axis];
    this.pos[axis] = from + delta;
    if (!this.blocked()) return false;
    let lo = 0;
    let hi = delta;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      this.pos[axis] = from + mid;
      if (this.blocked()) hi = mid;
      else lo = mid;
    }
    this.pos[axis] = from + lo;
    return true;
  }

  /**
   * Is the column the feet are standing over one the viewer has not streamed in?
   *
   * The cell just BELOW the feet, because that is the one that holds the body up. Asked at
   * the body's centre rather than at all four corners of its box: `known` is answered per
   * chunk, so the corners only differ on a chunk boundary, and being half a block late to
   * notice an edge case costs nothing next to the arithmetic in the hot path.
   */
  private groundUnknown(): boolean {
    return !this.shapes.known(
      Math.floor(this.pos[0]),
      Math.floor(this.pos[1] - 0.05),
      Math.floor(this.pos[2]),
    );
  }

  /**
   * Is the cell the body is about to enter one the viewer has not streamed in?
   *
   * Sampled at the leading edge of the body's box plus its own width, so it asks about the cell
   * being moved INTO rather than the one already occupied -- otherwise standing on the boundary of
   * an unloaded chunk would refuse every move including the one walking away from it.
   */
  private leadingCellUnknown(axis: 0 | 2, delta: number): boolean {
    const hw = this.motion.halfWidth;
    const ahead = this.pos[axis] + Math.sign(delta) * (hw + Math.abs(delta));
    const x = axis === 0 ? ahead : this.pos[0];
    const z = axis === 2 ? ahead : this.pos[2];
    // Feet and head: a chunk can be loaded at one height and not the other only at a section
    // boundary, and asking both costs one extra lookup on a path that already does several.
    return !this.shapes.known(Math.floor(x), Math.floor(this.pos[1]), Math.floor(z))
      || !this.shapes.known(Math.floor(x), Math.floor(this.pos[1] + this.motion.height), Math.floor(z));
  }

  /** Does the body's box currently overlap any block's collision box? */
  private blocked(): boolean {
    const [x, y, z] = this.pos;
    const hw = this.motion.halfWidth;
    const h = this.motion.height;
    const self: Box = [x - hw, y, z - hw, x + hw, y + h, z + hw];
    // Only the cells the body's box actually touches. `-1` on the low bound because a
    // block's shape can be taller than its own cell only for oversized shapes, which do
    // not exist in the extracted table; the low sweep still has to include the cell the
    // feet are standing in when y is exactly integral.
    const x0 = Math.floor(self[0]);
    const y0 = Math.floor(self[1]);
    const z0 = Math.floor(self[2]);
    const x1 = Math.floor(self[3] - 1e-7);
    const y1 = Math.floor(self[4] - 1e-7);
    const z1 = Math.floor(self[5] - 1e-7);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          if (this.hits(self, cx, cy, cz)) return true;
        }
      }
    }
    return false;
  }

  /** Does the body overlap any of this cell's collision boxes? */
  private hits(self: Box, x: number, y: number, z: number): boolean {
    const boxes = this.shapes.boxesAt(x, y, z);
    for (const b of boxes) {
      if (
        self[0] < b[3] - 1e-7 && self[3] > b[0] + 1e-7 &&
        self[1] < b[4] - 1e-7 && self[4] > b[1] + 1e-7 &&
        self[2] < b[5] - 1e-7 && self[5] > b[2] + 1e-7
      ) return true;
    }
    return false;
  }

  /**
   * Pull the prediction toward where the server says we are.
   *
   * `target` is the server's dead-reckoned position — the existing extrapolation in
   * live-view, i.e. the best available estimate of "where the player is on the server right
   * now", not the raw sample. Comparing against the raw sample instead would bake the
   * sampling gap into the drift and pull the camera permanently backwards.
   */
  reconcile(target: readonly [number, number, number], dt: number, now = performance.now()): void {
    if (!this.started) return;
    this.measureServer(target, now);
    const dx = target[0] - this.pos[0];
    const dy = target[1] - this.pos[1];
    const dz = target[2] - this.pos[2];
    this.drift = Math.hypot(dx, dy, dz);

    // A teleport is always honoured, however implausible the server's ordinary motion is.
    //
    // MEASURED ON THE SERVER'S OWN MOTION, not on the gap between it and us. Those are
    // different things and confusing them undoes the whole fix: against a server running
    // seven times too fast the gap grows without bound, so after a few seconds of walking
    // it exceeds any threshold and every frame looks like a teleport — the camera gets
    // dragged along at the server's wrong speed by the very branch meant to catch
    // discontinuities. A real teleport is the SERVER's position jumping between two
    // consecutive samples.
    if (this.serverJumped) {
      this.snapTo(target);
      return;
    }

    // THE SERVER'S CLOCK IS NOT OUR CLOCK.
    //
    // Movement is issued as a stateful command the server applies PER TICK, so displacement
    // per real second scales with the tick rate. This world runs a 200/s target and actually
    // manages about 145, against vanilla's 20 — so the server walks the player roughly seven
    // times too fast, and the figure wobbles with load. Reconciling to that drags the camera
    // along at the server's wrong speed and then hard-resyncs when the gap opens, which is
    // what "the controls are completely broken" actually was.
    //
    // The local simulation integrates real seconds against the game's own constants, so it
    // is the thing that is RIGHT. When the server's implied speed is not something a player
    // can do, its position stops being evidence about where the player should be and is
    // ignored — loudly, via `stats().serverPlausible`, never silently.
    if (!this.serverPlausible) return;

    if (this.drift > RESYNC_BLOCKS) {
      this.snapTo(target);
      return;
    }
    if (this.drift < DEADZONE) return;
    const k = 1 - Math.exp(-RECONCILE_RATE * dt);
    // Clamp what the pull may contribute this frame. Without this the correction competes
    // with locomotion and the server's clock leaks into the walking speed — see the note on
    // MAX_CORRECTION_FRACTION.
    const budget = this.speed * MAX_CORRECTION_FRACTION * dt;
    const wanted = this.drift * k;
    const scale = wanted > budget ? budget / wanted : 1;
    this.pos[0] += dx * k * scale;
    this.pos[1] += dy * k * scale;
    this.pos[2] += dz * k * scale;
  }

  /**
   * Is the server's motion consistent with ours?
   *
   * While the body is standing still there is nothing to compare against and anything the
   * server reports — knockback, a push, a piston — is worth taking, so it counts as
   * plausible. While walking, the two should agree to within a factor; when they do not,
   * the server's clock is not measuring the same seconds we are.
   *
   * The trade, stated: a player genuinely stopped by something the local collision model
   * does not know about also reads as "server too slow", and then the camera walks on
   * through it until the drift is visible on the HUD. Real `VoxelShape`s make that rare, and
   * a wrong walking speed every single step is the worse of the two.
   */
  private judgeServer(): boolean {
    const ours = Math.hypot(this.vel[0], this.vel[2]);
    if (ours < MOVING_THRESHOLD) return true;
    const ratio = this.serverSpeed / ours;
    return ratio <= SERVER_SPEED_TOLERANCE && ratio >= 1 / SERVER_SPEED_TOLERANCE;
  }

  private snapTo(target: readonly [number, number, number]): void {
    this.resyncs++;
    this.pos = [target[0], target[1], target[2]];
    this.vel[1] = 0;
    this.drift = 0;
  }

  /**
   * How fast the server's own reports are moving the player, in blocks per REAL second.
   *
   * Horizontal only: falling is legitimately fast and says nothing about the tick rate.
   */
  private measureServer(target: readonly [number, number, number], now: number): void {
    this.serverJumped = false;
    const prev = this.lastTarget;
    this.lastTarget = { pos: [target[0], target[1], target[2]], at: now };
    if (!prev) return;
    const dt = (now - prev.at) / 1000;
    if (dt <= 0.001) return;
    const moved = Math.hypot(target[0] - prev.pos[0], target[2] - prev.pos[2]);
    // A single teleport must not be read as a sustained speed: it is flagged for the
    // teleport branch instead and excluded from the rate estimate.
    if (moved > TELEPORT_BLOCKS) {
      this.serverJumped = true;
      return;
    }
    const observed = moved / dt;
    // The FIRST measurement is taken whole, and the rest are smoothed.
    //
    // Not a nicety: easing up from zero took about a fifth of a second to cross the
    // plausibility ceiling, and a server running seven times too fast covers six blocks in
    // that time — enough to trip the resync threshold and snap the camera once on every
    // single walk. The estimate has to be right before the first correction, not after it.
    this.serverSamples++;
    const alpha = this.serverSamples === 1 ? 1 : Math.min(1, dt * 8);
    this.serverSpeed += (observed - this.serverSpeed) * alpha;
    this.serverPlausible = this.judgeServer();
  }

  /**
   * Learn this server's actual walking speed from its own reports.
   *
   * Called with each raw `self` sample. A pair of samples taken while exactly one
   * horizontal direction was held, with no speed modifier, is a direct measurement of the
   * base speed — mods, attributes, potion effects and block slowdowns all included, because
   * it is the outcome that is measured rather than the rule. Everything else is ignored
   * rather than guessed at.
   */
  observe(sample: readonly [number, number, number], at: number, intent: PredictIntent): void {
    const prev = this.lastObserved;
    this.lastObserved = { pos: [sample[0], sample[1], sample[2]], at };
    if (!prev || !plainWalk(intent)) return;
    const dt = (at - prev.at) / 1000;
    if (dt < 0.05 || dt > 0.5) return;
    const moved = Math.hypot(sample[0] - prev.pos[0], sample[2] - prev.pos[2]);
    const observed = moved / dt;
    // A sample pair that straddles a wall, a door frame or the moment the key went down
    // reads far too slow, and one that straddles a teleport reads absurdly fast. Both are
    // rejected on their face rather than averaged in.
    if (observed < SEED_SPEED * 0.5 || observed > SEED_SPEED * 2.5) return;
    const alpha = this.calibrations === 0 ? 1 : 0.15;
    this.speed += (observed - this.speed) * alpha;
    this.calibrations++;
  }
}

/**
 * Held keys to a unit direction in the camera's frame.
 *
 * The forward vector matches the one the raycast uses (live-controls.ts) exactly, because
 * "walk forward" and "mine what the crosshair is on" disagreeing about which way is forward
 * is precisely the class of bug this project keeps paying for.
 */
export function axes(intent: PredictIntent, yaw: number): [number, number] {
  const a = intent.analog;
  const f = a ? a.y : (intent.forward ? 1 : 0) - (intent.back ? 1 : 0);
  const s = a ? a.x : (intent.right ? 1 : 0) - (intent.left ? 1 : 0);
  if (Math.abs(f) < 1e-6 && Math.abs(s) < 1e-6) return [0, 0];
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // forward = (-sin, -cos), and RIGHT IS (+cos, -sin).
  //
  // It was (-cos, +sin) — the exact negative — so A walked right and D walked left. The comment
  // asserted the wrong vector and the code implemented the comment, which is why it survived: the
  // forward half is shared with the raycast and checked constantly, and nothing anywhere used the
  // strafe half. Checked against the compass rather than re-derived: yaw 0 looks down -Z, which is
  // north, and a player facing north has EAST (+X) on their right, so s=1 must give (+1, 0).
  const x = f * -sin + s * cos;
  const z = f * -cos + s * -sin;
  const len = Math.hypot(x, z);
  // A stick pushed half way walks at half speed; the boolean path is always full magnitude
  // because a key is either down or it is not.
  const scale = a ? Math.min(1, Math.hypot(f, s)) : 1;
  return [(x / len) * scale, (z / len) * scale];
}

/** Exactly one horizontal direction, no speed modifier — the only measurable case. */
function plainWalk(intent: PredictIntent): boolean {
  if (intent.sprint || intent.sneak || intent.jump) return false;
  const held = [intent.forward, intent.back, intent.left, intent.right].filter(Boolean);
  return held.length === 1;
}
