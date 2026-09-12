/**
 * How long a block takes to break, and how far through you are.
 *
 * Every input is extracted or data, none of it guessed:
 *
 *   hardness    `physics.json`, from `BlockState.getDestroySpeed` — all 26,684 states
 *   tool speed  `physics.json`, from the item's TOOL data component (vanilla and modded
 *               tools both use it, so this is not a table of known tools)
 *   which tool  `tags.json`, from `data/<ns>/tags/block/mineable/*.json` in the jars
 *
 * WHY THE TAGS ARE A SEPARATE BAKE and not part of the extraction: `Bootstrap.bootStrap()`
 * builds the registries but never loads datapack tags, so every tag the harness sees is
 * EMPTY. The first version of the tool extraction emitted those empty lists and every tool
 * silently matched nothing — the numbers all looked plausible and every block took bare-hand
 * time. The rules carry the tag ID instead, and the bake resolves it from the jars, merging
 * every pack's copy the way Minecraft does: `mineable/pickaxe` ends up with 6,934 blocks
 * here, 6,504 of them modded.
 *
 * The formula is vanilla's: damage per tick is `speed / hardness`, divided by 30 when the
 * tool can harvest the block and 100 when it cannot, and the block breaks when the
 * accumulated damage reaches 1.
 */

import type { PhysicsData } from './physics.js';

export interface ToolRule {
  tag?: string | null;
  blocks?: string[];
  speed?: number | null;
  correct?: boolean | null;
}

export interface ToolInfo {
  id: string;
  defaultSpeed: number;
  rules: ToolRule[];
}

/** Tag id -> block ids, from the bake. */
export type TagIndex = Record<string, string[]>;

/** Ticks per second, for turning a tick count into a duration. */
const TPS = 20;
/** Vanilla's divisors: a harvesting tool is over three times faster than a wrong one. */
const HARVEST_DIVISOR = 30;
const NON_HARVEST_DIVISOR = 100;

export interface BreakInputs {
  physics: PhysicsData | null;
  tags: TagIndex | null;
  /** the held item id, or null for a bare hand */
  tool: string | null;
}

/** The block name without its properties. */
function blockName(stateKey: string): string {
  const i = stateKey.indexOf('[');
  return i < 0 ? stateKey : stateKey.slice(0, i);
}

function hardnessOf(physics: PhysicsData | null, stateKey: string): number | null {
  if (!physics) return null;
  const t = physics as unknown as { blocks: Record<string, { h?: number }> };
  const row = t.blocks[stateKey] ?? t.blocks[blockName(stateKey)];
  return row && typeof row.h === 'number' ? row.h : null;
}

function toolsOf(physics: PhysicsData | null): ToolInfo[] {
  return (physics as unknown as { tools?: ToolInfo[] } | null)?.tools ?? [];
}

/** Does a rule cover this block? */
export function ruleMatches(rule: ToolRule, block: string, tags: TagIndex | null): boolean {
  if (rule.blocks?.length && rule.blocks.includes(block)) return true;
  if (!rule.tag) return false;
  const members = tags?.[rule.tag];
  return members ? members.includes(block) : false;
}

export interface ToolEffect {
  speed: number;
  /** true when the tool harvests the block, which is what makes it over 3x faster */
  correct: boolean;
}

/**
 * The speed and harvest flag for a tool against a block.
 *
 * Rules are evaluated in order and the LAST matching one wins for each property, which is
 * how a tool can both be "wrong for diamond-tier blocks" and "fast on pickaxe blocks":
 * vanilla lists the exclusion first and the speed second.
 */
export function toolEffect(inputs: BreakInputs, stateKey: string): ToolEffect {
  const block = blockName(stateKey);
  const tool = toolsOf(inputs.physics).find((t) => t.id === inputs.tool);
  if (!tool) return { speed: 1, correct: false };
  let speed = tool.defaultSpeed || 1;
  let correct = false;
  for (const rule of tool.rules) {
    if (!ruleMatches(rule, block, inputs.tags)) continue;
    if (typeof rule.speed === 'number') speed = rule.speed;
    if (typeof rule.correct === 'boolean') correct = rule.correct;
  }
  return { speed, correct };
}

/**
 * Seconds to break a block, or null when it cannot be broken or is not known.
 *
 * Returns 0 for an instant-break block (hardness 0: grass, torches), which is a real answer
 * and distinct from `null`.
 */
export function breakSeconds(inputs: BreakInputs, stateKey: string): number | null {
  const hardness = hardnessOf(inputs.physics, stateKey);
  if (hardness === null) return null;
  // Vanilla's own sentinel for bedrock, barriers and portal frames.
  if (hardness < 0) return null;
  if (hardness === 0) return 0;
  const { speed, correct } = toolEffect(inputs, stateKey);
  const divisor = correct ? HARVEST_DIVISOR : NON_HARVEST_DIVISOR;
  const perTick = speed / hardness / divisor;
  if (perTick <= 0) return null;
  // Vanilla accumulates per tick and breaks when the total reaches 1, so the time is a whole
  // number of ticks — a block is never 0.97 ticks.
  return Math.ceil(1 / perTick) / TPS;
}

/**
 * How far through breaking a block we are, 0..1, and which of the 10 crack stages to draw.
 *
 * Stage is `floor(progress * 10)` clamped to 0..9, which is exactly how many
 * `destroy_stage_N` textures vanilla ships.
 */
export function breakStage(progress: number): number {
  if (!(progress > 0)) return -1;
  return Math.max(0, Math.min(9, Math.floor(progress * 10)));
}

/**
 * Tracks one in-progress dig.
 *
 * Resets whenever the targeted block changes, because progress on one block must never
 * carry over to the next — in vanilla, looking away and back starts again.
 */
export class BreakTracker {
  private target: string | null = null;
  private elapsed = 0;
  private total: number | null = null;

  /** Currently-targeted block key, or null when not digging. */
  get block(): string | null {
    return this.target;
  }

  get progress(): number {
    if (this.total === null || this.total <= 0) return this.total === 0 ? 1 : 0;
    return Math.max(0, Math.min(1, this.elapsed / this.total));
  }

  get stage(): number {
    return this.target === null ? -1 : breakStage(this.progress);
  }

  /**
   * Advance. `key` is the targeted block's state key and position, or null when not digging.
   *
   * The caller passes a key that includes the POSITION, not just the state: two adjacent
   * stone blocks are the same state and must not share progress.
   */
  update(key: string | null, seconds: number | null, dt: number): void {
    if (key !== this.target) {
      this.target = key;
      this.elapsed = 0;
      this.total = seconds;
      return;
    }
    if (key === null) return;
    this.total = seconds;
    this.elapsed += dt;
  }

  reset(): void {
    this.target = null;
    this.elapsed = 0;
    this.total = null;
  }
}
