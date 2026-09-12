/**
 * Which sound a block makes, and when to play it.
 *
 * The lookup is the easy half and it is entirely data-driven: `physics.json` carries each
 * block state's SoundType, extracted from the real game (a `SoundType` is a Java constant,
 * so there is no data file to read it from and no way to be generic without extracting it).
 * A modded block that reuses `SoundType.STONE` — which is what mods overwhelmingly do —
 * therefore sounds right with no per-mod code.
 *
 * The interesting half is WHEN. Two triggers, because they are the two the viewer can
 * honestly know about:
 *
 *   block changes   something broke or was placed. Air-to-solid is a place, solid-to-air is
 *                   a break, and solid-to-different-solid is a place of the new block. The
 *                   sound belongs to the block that LEFT in a break and the one that ARRIVED
 *                   in a place — using the wrong one makes mining stone sound like air.
 *
 *   footsteps       the local body's own movement. Driven by DISTANCE TRAVELLED rather than
 *                   by a timer, so walking slowly gives slow footfalls and stopping gives
 *                   silence, and read from the block actually being stood on.
 *
 * What is deliberately NOT here: mob sounds, ambience and music. Those are events on the
 * Minecraft wire (`ClientboundSoundPacket`) that neither the save files nor the current
 * module carry — see the note in PARITY-AUDIT.md. Inventing them from block state would be
 * guessing at when the game made a noise, which is worse than silence.
 */

import type { PhysicsData } from './physics.js';

/** The five events a SoundType names. */
export interface BlockSound {
  breakSound: string | null;
  stepSound: string | null;
  placeSound: string | null;
  hitSound: string | null;
  fallSound: string | null;
  volume: number;
  pitch: number;
}

/**
 * Resolve a canonical block state key to its SoundType.
 *
 * Falls back to the plain block id the same way the collision lookup does, because the
 * extraction collapses blocks whose states all agree onto one row.
 */
export function soundFor(physics: PhysicsData | null, stateKey: string): BlockSound | null {
  if (!physics) return null;
  const table = physics as unknown as { sounds?: BlockSound[]; blocks: Record<string, { snd?: number }> };
  const info = table.blocks[stateKey] ?? table.blocks[stateKey.split('[')[0]];
  if (!info || info.snd === undefined || info.snd < 0) return null;
  return table.sounds?.[info.snd] ?? null;
}

/** Air, in every spelling the game uses. */
function isAir(key: string): boolean {
  const name = key.split('[')[0];
  return name === 'minecraft:air' || name === 'minecraft:cave_air' || name === 'minecraft:void_air';
}

export type ChangeKind = 'break' | 'place' | 'none';

/**
 * What a block change sounds like.
 *
 * Returns which SIDE of the change owns the sound, because that is the bit that is easy to
 * get backwards: breaking stone plays *stone's* break sound, not air's.
 */
export function changeKind(oldKey: string | null, newKey: string | null): ChangeKind {
  const wasAir = !oldKey || isAir(oldKey);
  const isNowAir = !newKey || isAir(newKey);
  if (wasAir && isNowAir) return 'none';
  if (!wasAir && isNowAir) return 'break';
  return 'place';
}

/** The event name for a change, or null when there is nothing to play. */
export function eventForChange(
  physics: PhysicsData | null,
  oldKey: string | null,
  newKey: string | null,
): { event: string; volume: number; pitch: number } | null {
  const kind = changeKind(oldKey, newKey);
  if (kind === 'none') return null;
  const key = kind === 'break' ? oldKey : newKey;
  if (!key) return null;
  const sound = soundFor(physics, key);
  const event = kind === 'break' ? sound?.breakSound : sound?.placeSound;
  if (!sound || !event) return null;
  // Vanilla plays block break/place at a fraction of the SoundType's volume; full volume on
  // every block update in a busy Create base is genuinely painful.
  return { event, volume: sound.volume * 0.8, pitch: sound.pitch };
}

/**
 * Footstep pacing.
 *
 * Vanilla steps on distance, not on a clock. Keeping that means a sneaking player's steps
 * are sparse and a sprinting one's are rapid, without any speed special-casing — and a
 * player standing still is silent, which a timer would get wrong.
 */
export const STEP_DISTANCE = 2.2;

/**
 * Every sound event the blocks in this world can make.
 *
 * Driven by the world's own block palette, so preloading costs what the world needs rather
 * than the whole index — and so a modded world warms its modded blocks' sounds without any
 * of them being named here.
 */
/**
 * Every block sound event the GAME has, regardless of what is loaded right now.
 *
 * The palette-driven list is the right thing to warm FIRST — it is what the world can make
 * this second — but it is not sufficient on its own: someone can place a block type the
 * loaded world has never contained, and measuring that case showed 3 of 4 real edits still
 * dropped for want of a buffer. The SoundType palette is bounded (a hundred-odd events for
 * every block in the game and every mod that reuses them), so warming one variant of each in
 * the background covers the rest without fetching the whole 515-event index.
 */
export function allBlockEvents(physics: PhysicsData | null): string[] {
  const table = physics as unknown as { sounds?: BlockSound[] } | null;
  const out = new Set<string>();
  for (const s of table?.sounds ?? []) {
    for (const e of [s.breakSound, s.stepSound, s.placeSound]) {
      if (e && e !== 'minecraft:intentionally_empty') out.add(e);
    }
  }
  return [...out];
}

export function eventsForPalette(
  physics: PhysicsData | null,
  palette: Iterable<string>,
): string[] {
  const out = new Set<string>();
  for (const key of palette) {
    const s = soundFor(physics, key);
    if (!s) continue;
    for (const e of [s.breakSound, s.stepSound, s.placeSound]) {
      if (e && e !== 'minecraft:intentionally_empty') out.add(e);
    }
  }
  return [...out];
}

export class Footsteps {
  private travelled = 0;
  private last: [number, number, number] | null = null;

  /**
   * Fold in a position. Returns true when a step should sound.
   *
   * Vertical movement is excluded: falling down a shaft is not walking, and counting it
   * makes a long drop machine-gun footsteps all the way down.
   */
  update(pos: readonly [number, number, number], onGround: boolean): boolean {
    const prev = this.last;
    this.last = [pos[0], pos[1], pos[2]];
    if (!prev || !onGround) return false;
    const moved = Math.hypot(pos[0] - prev[0], pos[2] - prev[2]);
    // A resync or teleport is not a walk; counting it fires a burst of steps at once.
    if (moved > 3) return false;
    this.travelled += moved;
    if (this.travelled < STEP_DISTANCE) return false;
    this.travelled = 0;
    return true;
  }

  reset(): void {
    this.travelled = 0;
    this.last = null;
  }
}
