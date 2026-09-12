/**
 * Positional sound.
 *
 * The viewer had no audio at all. This plays the sound the GAME says a block makes, at the
 * place it happened, with distance falloff — driven by two data sets that are both already
 * generic across mods:
 *
 *   physics.json   each block state's SoundType (break / step / place / hit / fall event
 *                  names), extracted from the real game by the harness, because SoundType
 *                  is a Java constant and cannot be read out of any data file
 *   sounds/index   each event's variant FILES, resolved from Mojang's `sounds.json`
 *
 * So a modded block that reuses `SoundType.STONE` — which is what mods overwhelmingly do —
 * gets the right sound with no per-mod code and no list of block names anywhere.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG HERE:
 *
 * 1. **A browser will not play anything until the user has interacted with the page.**
 *    `AudioContext` starts `suspended` and stays there. Sound that silently never plays is
 *    the worst outcome, so `state` is reported and the HUD says when audio is waiting for a
 *    click rather than leaving it looking broken.
 *
 * 2. **Every sound must be cheap to miss — but missing must be RARE.** Decoding is
 *    asynchronous and a break can happen before its file has arrived. A sound that is not
 *    ready is DROPPED, never queued: a queued sound plays late, at the wrong moment, which
 *    is worse than silence.
 *
 *    Relying on that alone was not good enough, and measuring the real job rather than a
 *    proxy is what caught it. Four real block edits produced `played: 0, notLoaded: 4` —
 *    every one resolved to the correct event and variant and was then dropped, because a
 *    lazy cache means the FIRST break of each material is always silent, and for a rare
 *    block always silent. So `preload()` warms the events the loaded world can actually
 *    make, and lazy fetching is only the backstop for what it missed.
 *
 * 3. **Volume is not distance.** Vanilla attenuates over roughly 16 blocks scaled by the
 *    sound's own volume, and a sound at the far edge should be inaudible rather than
 *    quietly present. `PannerNode` with a linear model and an explicit `maxDistance` gives
 *    that; an inverse model never quite reaches zero and leaves a wash of distant noise.
 */

/** One playable variant of an event. */
export interface SoundVariant {
  file: string;
  volume: number;
  pitch: number;
  weight: number;
}

export interface SoundIndex {
  version: string;
  events: Record<string, SoundVariant[]>;
}

/** How far a sound of volume 1 carries, in blocks. Vanilla's rolloff is about this. */
const BASE_RANGE = 16;
/** Never start more than this many sounds in one frame; a cascade of block updates otherwise roars. */
const MAX_PER_FRAME = 6;
/** Two identical sounds at the same block within this many ms are one event, not two. */
const DEDUPE_MS = 60;

export interface SoundEngineDeps {
  /** where the sound files are served from, e.g. `/sounds` */
  base: string;
  status?: (msg: string) => void;
}

/**
 * Pick a variant, honouring `weight`.
 *
 * Vanilla weights variants so some are rarer; ignoring that makes a footstep loop sound
 * mechanical in a way people notice without being able to say why.
 */
export function pickVariant(variants: readonly SoundVariant[], roll = Math.random()): SoundVariant | null {
  if (!variants.length) return null;
  let total = 0;
  for (const v of variants) total += Math.max(0, v.weight) || 1;
  let at = roll * total;
  for (const v of variants) {
    at -= Math.max(0, v.weight) || 1;
    if (at <= 0) return v;
  }
  return variants[variants.length - 1];
}

/** Vanilla randomises pitch slightly per play; without it repeated sounds sound looped. */
export function jitterPitch(base: number, roll = Math.random()): number {
  return base * (0.9 + roll * 0.2);
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private index: SoundIndex | null = null;
  private buffers = new Map<string, AudioBuffer | null>();
  private pending = new Set<string>();
  private startedThisFrame = 0;
  private recent = new Map<string, number>();
  private masterGain: GainNode | null = null;

  readonly stats = { played: 0, dropped: 0, notReady: 0, events: 0, preloaded: 0 };
  muted = false;

  constructor(private deps: SoundEngineDeps) {}

  /** Load the manifest. Safe to call before any user gesture; no context is created yet. */
  async load(): Promise<boolean> {
    try {
      const res = await fetch(`${this.deps.base}/index.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.index = (await res.json()) as SoundIndex;
      this.stats.events = Object.keys(this.index.events ?? {}).length;
      return true;
    } catch (e) {
      this.deps.status?.(
        `sound: no index at ${this.deps.base}/index.json (${(e as Error).message})`
        + ' — run `npm run fetch-sounds`; the viewer is SILENT');
      return false;
    }
  }

  get ready(): boolean {
    return this.index !== null;
  }

  /** `running`, `suspended` (waiting for a gesture), or `off` (no context yet). */
  get state(): string {
    if (!this.ctx) return 'off';
    return this.ctx.state;
  }

  /**
   * Create or resume the context. MUST be called from a user gesture handler.
   *
   * Browsers block audio until the user has interacted, and they do it silently. Calling
   * this from a click is the only thing that makes sound work at all.
   */
  async resume(): Promise<void> {
    if (!this.ctx) {
      const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /**
   * Decode the files for these events up front.
   *
   * Called with the events the blocks actually present in the world can make, so the cost
   * is proportional to what is on screen rather than to the whole 515-event index — and it
   * stays generic, because the event list comes from the world's own block palette rather
   * than from a list of sounds somebody chose.
   *
   * Only the first few variants of each event are warmed: that is enough for the first
   * break to be audible, and the rest arrive through the ordinary lazy path well before
   * anyone notices they were not there.
   */
  async preload(events: Iterable<string>, variantsEach = 2, concurrency = 8): Promise<void> {
    if (!this.index || !this.ctx) return;
    const files: string[] = [];
    for (const event of events) {
      const variants = this.index.events[event.replace(/^minecraft:/, '')];
      for (const v of (variants ?? []).slice(0, variantsEach)) {
        if (!this.buffers.has(v.file)) files.push(v.file);
      }
    }
    let at = 0;
    const worker = async (): Promise<void> => {
      while (at < files.length) {
        const file = files[at++];
        if (!this.buffers.has(file) && !this.pending.has(file)) await this.fetchBuffer(file);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    this.stats.preloaded = this.buffers.size;
  }

  /** Point the listener at the camera. Call once a frame. */
  setListener(pos: readonly [number, number, number], forward: readonly [number, number, number]): void {
    const l = this.ctx?.listener;
    if (!l) return;
    // Both APIs exist in the wild: the positional-audio properties are newer than the
    // setters, and Safari still ships only the setters.
    if (l.positionX) {
      l.positionX.value = pos[0];
      l.positionY.value = pos[1];
      l.positionZ.value = pos[2];
      l.forwardX.value = forward[0];
      l.forwardY.value = forward[1];
      l.forwardZ.value = forward[2];
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(pos[0], pos[1], pos[2]);
      (l as unknown as { setOrientation(...a: number[]): void })
        .setOrientation(forward[0], forward[1], forward[2], 0, 1, 0);
    }
    this.startedThisFrame = 0;
  }

  /**
   * Play one event at a world position.
   *
   * Returns false when nothing was played, and says why through `stats` — a silent failure
   * that nobody can count is how an audio bug survives.
   */
  play(
    event: string,
    pos: readonly [number, number, number],
    opts: { volume?: number; pitch?: number } = {},
  ): boolean {
    if (!this.audible()) return false;
    if (this.startedThisFrame >= MAX_PER_FRAME) { this.stats.dropped++; return false; }
    const variants = this.index!.events[event.replace(/^minecraft:/, '')];
    if (!variants?.length) { this.stats.dropped++; return false; }
    if (this.isRepeat(event, pos)) return false;
    const variant = pickVariant(variants);
    if (!variant) { this.stats.dropped++; return false; }
    const ready = this.readyVariant(variants, variant);
    if (!ready) { this.stats.notReady++; return false; }
    this.start(this.buffers.get(ready.file)!, pos, ready, opts);
    return true;
  }

  private start(
    buffer: AudioBuffer,
    pos: readonly [number, number, number],
    variant: SoundVariant,
    opts: { volume?: number; pitch?: number },
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = jitterPitch((opts.pitch ?? 1) * variant.pitch);
    const volume = (opts.volume ?? 1) * variant.volume;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    // Linear, with an explicit ceiling: an inverse model never reaches zero and leaves a
    // wash of barely-audible noise from every distant block change in the world.
    panner.distanceModel = 'linear';
    panner.refDistance = 1;
    panner.maxDistance = Math.max(4, BASE_RANGE * Math.max(volume, 0.25));
    panner.rolloffFactor = 1;
    panner.positionX.value = pos[0];
    panner.positionY.value = pos[1];
    panner.positionZ.value = pos[2];
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, volume);
    src.connect(gain).connect(panner).connect(this.masterGain!);
    src.start();
    this.startedThisFrame++;
    this.stats.played++;
  }

  /** Can anything be played at all right now? */
  private audible(): boolean {
    return !this.muted && this.index !== null && this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Has this exact sound already fired at this block within the dedupe window?
   *
   * One logical edit can surface as several rows; playing each would double-trigger.
   */
  private isRepeat(event: string, pos: readonly [number, number, number]): boolean {
    const key = `${event}@${Math.round(pos[0])},${Math.round(pos[1])},${Math.round(pos[2])}`;
    const now = this.ctx!.currentTime * 1000;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return true;
    this.recent.set(key, now);
    if (this.recent.size > 512) this.recent.clear();
    return false;
  }

  /**
   * The chosen variant if it is decoded, otherwise ANY decoded variant of the same event.
   *
   * Variants of an event are interchangeable by design — that is what a variant is — so
   * substituting one is not a compromise, it is the same sound with different randomness.
   * Without this, preloading one variant per event while `pickVariant` chose uniformly at
   * random meant most plays still found nothing decoded: measured at 4 played / 4 MISSED
   * across eight real block edits. With it, the event is audible as soon as any one of its
   * files has landed, and the rest fill in behind.
   *
   * The originally-picked variant is still requested, so the full set warms up and the
   * randomness comes back.
   */
  private readyVariant(
    variants: readonly SoundVariant[], picked: SoundVariant,
  ): SoundVariant | null {
    if (this.buffer(picked.file)) return picked;
    for (const v of variants) {
      if (v !== picked && this.buffers.get(v.file)) return v;
    }
    return null;
  }

  /**
   * A decoded buffer, or null while it is still being fetched.
   *
   * Deliberately never awaited by `play`: a sound that arrives after its moment is worse
   * than one that never plays, so the first occurrence of an event warms the cache and the
   * next one is audible.
   */
  private buffer(file: string): AudioBuffer | null {
    const hit = this.buffers.get(file);
    if (hit !== undefined) return hit;
    if (!this.pending.has(file)) void this.fetchBuffer(file);
    return null;
  }

  private async fetchBuffer(file: string): Promise<void> {
    this.pending.add(file);
    try {
      const res = await fetch(`${this.deps.base}/ogg/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decoded = await this.ctx!.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(file, decoded);
    } catch {
      // Cached as null so a missing file is not re-fetched on every single block break.
      this.buffers.set(file, null);
    } finally {
      this.pending.delete(file);
    }
  }

  hudLine(): string {
    if (!this.index) return ' | sound: OFF (no index)';
    if (this.state !== 'running') {
      return ` | sound: ${this.state === 'suspended' ? 'click to enable' : 'off'}`;
    }
    return ` | sound: ${this.stats.played}`
      + (this.stats.preloaded ? `/${this.stats.preloaded} loaded` : '')
      + (this.stats.notReady ? ` (${this.stats.notReady} MISSED, not loaded)` : '');
  }
}
