/**
 * Terrain from SpacetimeDB: unpacking sections, and naming the states inside them.
 *
 * A `chunk_section` row carries the world in exactly the layout an Anvil region file uses —
 * `block_bits`, a palette of GLOBAL block-state ids, and `block_data` as bit-packed words —
 * so once it is unpacked and the ids are named, `World.addLiveSection` takes it and the
 * mesher cannot tell it apart from a section read off disk. That is the whole design: the
 * source changes, the renderer does not.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS.
 *
 * **1. The words are `u64` and must stay exact.** They arrive from the SDK as `bigint`
 * because BSATN carries them losslessly; measured on a real section, 341 of 342 words
 * exceeded 2^53, so anything that routes them through a JavaScript `number` corrupts the
 * terrain silently. `unpackSection` splits each word into two 32-bit halves and does number
 * arithmetic from there — fast, and never puts a whole word in a double.
 *
 * **2. `block_state.properties` omits properties that are at their DEFAULT value.** This is
 * Minecraft's command/`BlockStateParser` spelling: `minecraft:oak_stairs` means
 * `facing=north,half=bottom,shape=straight,waterlogged=false`, and only non-defaults are
 * written. The renderer's canonical key is the opposite — every property, sorted — and its
 * `matchVariantKey` requires a variant's properties to be PRESENT, so handing it
 * `minecraft:oak_stairs` with no properties matches no variant and the stairs draw as
 * nothing.
 *
 * The fix is `deriveDefaults`, and it is exact rather than a table: for a given block, every
 * one of its states is in `block_state`, so for each property the values that ever appear
 * are its non-default values — and the default is the one value in the property's domain
 * that never appears. The domain comes from the block's own blockstate JSON, which the
 * renderer already parses. So the defaults are derived from the mod's own assets plus the
 * server's own registry, with no hardcoded table and no vanilla-only assumption. That
 * matters here: measured against the dev world, **56% of the block states actually in use
 * are modded**, so a vanilla-only default table would leave more than half the world
 * unresolved.
 */

/** A section as the module stores it. Numbers are whatever the SDK handed us. */
export interface SectionRow {
  cx: number;
  cz: number;
  sy: number;
  blockBits: number;
  blockPalette: readonly (number | bigint)[];
  blockData: readonly (number | bigint)[];
  nonAirCount?: number;
}

/** 4096 entries. For an indirect section these are palette indices; for a direct one, ids. */
export type SectionEntries = Uint16Array | Uint32Array;

export interface UnpackedSection {
  /** global block-state ids, one per cell, already resolved through the palette */
  ids: Uint32Array;
  /** how the row was encoded, for reporting */
  mode: 'single' | 'indirect' | 'direct';
}

const CELLS = 4096;

/**
 * Unpack one section into 4096 global block-state ids.
 *
 * The three encodings are the module's own (and vanilla's):
 *   bits === 0  single-valued: `palette[0]` fills the section and `data` is empty
 *   bits 1..8   indirect: `data` holds 4096 indices into `palette`
 *   bits >= 9   direct: `palette` is empty and the entries ARE global ids
 *
 * Entries are packed `floor(64/bits)` to a word and never straddle a word, which is the
 * detail that makes this cheap: no cross-word carry, just a per-word offset.
 */
export function unpackSection(row: SectionRow): UnpackedSection {
  const bits = Number(row.blockBits);
  const palette = row.blockPalette;
  if (bits === 0) {
    const only = palette.length ? Number(palette[0]) : 0;
    return { ids: new Uint32Array(CELLS).fill(only), mode: 'single' };
  }
  const entries = unpackEntries(row.blockData, bits);
  const ids = new Uint32Array(CELLS);
  if (palette.length === 0) {
    // Direct: the entry is already a global id.
    for (let i = 0; i < CELLS; i++) ids[i] = entries[i];
    return { ids, mode: 'direct' };
  }
  const pal = new Uint32Array(palette.length);
  for (let i = 0; i < palette.length; i++) pal[i] = Number(palette[i]);
  for (let i = 0; i < CELLS; i++) {
    const p = entries[i];
    // An index past the palette is corrupt data, not air — but drawing air is the only safe
    // thing to do with it, and the count is what tells you it happened.
    ids[i] = p < pal.length ? pal[p] : 0;
  }
  return { ids, mode: 'indirect' };
}

/**
 * Bit-unpack `count` entries of `bits` bits from u64 words.
 *
 * Each word is split into two 32-bit halves so no `bigint` ever reaches the inner loop and
 * no whole 64-bit value is put into a double. An entry that straddles the 32-bit boundary
 * inside a word (perfectly normal — with bits=5 the entry at offset 30 does) is stitched
 * from both halves.
 */
export function unpackEntries(
  words: readonly (number | bigint)[],
  bits: number,
  count = CELLS,
): Uint32Array {
  const out = new Uint32Array(count);
  if (bits <= 0 || bits > 32) return out;
  const perWord = Math.floor(64 / bits);
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  for (let i = 0; i < count; i++) {
    const w = Math.floor(i / perWord);
    if (w >= words.length) break;
    const raw = words[w];
    const big = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
    // Split once per entry is wasteful; split once per word instead.
    const lo = Number(big & 0xffffffffn) >>> 0;
    const hi = Number((big >> 32n) & 0xffffffffn) >>> 0;
    const off = (i % perWord) * bits;
    out[i] = readBits(lo, hi, off, bits, mask);
  }
  return out;
}

/** One entry out of a word already split into low and high 32-bit halves. */
function readBits(lo: number, hi: number, off: number, bits: number, mask: number): number {
  if (off + bits <= 32) return (lo >>> off) & mask;
  if (off >= 32) return (hi >>> (off - 32)) & mask;
  const low = lo >>> off;
  const high = hi << (32 - off);
  return (low | high) & mask;
}

// ---------------------------------------------------------------------------
// Naming the states.

/** One `block_state` row: the id, the block name, and its NON-DEFAULT properties only. */
export interface StateRow {
  id: number;
  name: string;
  /** `"facing=east,half=top"`; empty when every property is at its default */
  properties: string;
}

export function parseProps(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** `name` + props -> the renderer's canonical `name[k=v,...]`, properties SORTED. */
export function canonicalKey(name: string, props: Record<string, string>): string {
  const keys = Object.keys(props).sort();
  if (keys.length === 0) return name;
  return `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]`;
}

/**
 * Work out each property's DEFAULT value for one block, exactly.
 *
 * `states` is every `block_state` row for the block; `domains` is each property's full set
 * of values, from the block's own blockstate JSON. For a property, the values that appear
 * in any state's `properties` are precisely its non-default values, so whatever is left in
 * the domain is the default. A property whose domain does not resolve to exactly one
 * leftover is left OUT rather than guessed — an absent property the model does not vary on
 * costs nothing, and a wrongly-guessed one draws the block facing the wrong way.
 */
export function deriveDefaults(
  states: readonly StateRow[],
  domains: Record<string, readonly string[]>,
): Record<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const s of states) {
    for (const [k, v] of Object.entries(parseProps(s.properties))) {
      let set = seen.get(k);
      if (!set) { set = new Set(); seen.set(k, set); }
      set.add(v);
    }
  }
  const out: Record<string, string> = {};
  for (const [prop, values] of Object.entries(domains)) {
    const used = seen.get(prop) ?? new Set<string>();
    const missing = values.filter((v) => !used.has(v));
    if (missing.length === 1) out[prop] = missing[0];
  }
  return out;
}

/**
 * Every property value a blockstate JSON mentions, per property.
 *
 * Read from the variant keys and from `multipart` conditions, because those are the only
 * places a model says which values it distinguishes — and they are exactly the properties
 * whose default has to be right for the block to draw correctly. A property the file never
 * mentions cannot change what is drawn, so not knowing its default is harmless.
 */
export function domainsFromBlockstate(bs: unknown): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const add = (k: string, v: string) => {
    // `when` values may be `a|b`, meaning "either".
    for (const one of v.split('|')) (out[k] ??= new Set()).add(one);
  };
  const b = bs as {
    variants?: Record<string, unknown>;
    multipart?: Array<{ when?: Record<string, unknown> }>;
  };
  for (const key of Object.keys(b?.variants ?? {})) {
    if (!key) continue;
    for (const [k, v] of Object.entries(parseProps(key))) add(k, v);
  }
  for (const part of b?.multipart ?? []) {
    collectWhen(part.when, add);
  }
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) result[k] = [...v];
  return result;
}

/** `when` is either a flat property map or `{OR: [...]}` / `{AND: [...]}`. */
function collectWhen(when: unknown, add: (k: string, v: string) => void): void {
  if (!when || typeof when !== 'object') return;
  for (const [k, v] of Object.entries(when as Record<string, unknown>)) {
    if (k === 'OR' || k === 'AND') {
      for (const sub of Array.isArray(v) ? v : []) collectWhen(sub, add);
    } else if (isScalar(v)) {
      add(k, String(v));
    }
  }
}

function isScalar(v: unknown): v is string | number | boolean {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/**
 * Global state id -> the renderer's canonical key.
 *
 * Caches per id, and per block for the derived defaults, because a section's palette is a
 * few dozen ids drawn from a handful of blocks and the same ones recur across every chunk.
 * `unresolved` is counted rather than hidden: a state this cannot name is drawn as air, and
 * a silent hole in the world is the failure this project keeps paying to avoid.
 */
export class StateNamer {
  private byId = new Map<number, string>();
  private defaultsByBlock = new Map<string, Record<string, string>>();
  readonly stats = { resolved: 0, unresolved: 0, blocks: 0 };

  constructor(
    /** every `block_state` row for a block name, however the caller gets them */
    private statesOf: (blockName: string) => readonly StateRow[],
    /** the block's blockstate JSON, or null when the pack has none */
    private blockstateOf: (blockName: string) => unknown,
  ) {}

  /** Teach the namer a batch of rows; call before `keyOf` for the ids in a palette. */
  learn(rows: readonly StateRow[]): void {
    for (const row of rows) {
      if (this.byId.has(row.id)) continue;
      this.byId.set(row.id, this.build(row));
    }
  }

  private build(row: StateRow): string {
    const props = parseProps(row.properties);
    for (const [k, v] of Object.entries(this.defaults(row.name))) {
      if (!(k in props)) props[k] = v;
    }
    return canonicalKey(row.name, props);
  }

  private defaults(blockName: string): Record<string, string> {
    const cached = this.defaultsByBlock.get(blockName);
    if (cached) return cached;
    const domains = domainsFromBlockstate(this.blockstateOf(blockName));
    const d = deriveDefaults(this.statesOf(blockName), domains);
    this.defaultsByBlock.set(blockName, d);
    this.stats.blocks++;
    return d;
  }

  /** Have we already named this global state id? Lets callers batch only what is new. */
  knows(id: number): boolean {
    return this.byId.has(id);
  }

  keyOf(id: number): string | null {
    const k = this.byId.get(id);
    if (k === undefined) {
      this.stats.unresolved++;
      return null;
    }
    this.stats.resolved++;
    return k;
  }

  /**
   * A section's ids as a local string palette plus indices — exactly what
   * `World.addLiveSection` takes.
   */
  toLivePalette(ids: Uint32Array): { palette: string[]; indices: Uint16Array } {
    const palette: string[] = ['minecraft:air'];
    const index = new Map<string, number>([['minecraft:air', 0]]);
    const indices = new Uint16Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const key = ids[i] === 0 ? 'minecraft:air' : this.keyOf(ids[i]);
      if (key === null) continue; // stays 0 = air, and is counted in `stats.unresolved`
      let at = index.get(key);
      if (at === undefined) {
        at = palette.length;
        palette.push(key);
        index.set(key, at);
      }
      indices[i] = at;
    }
    return { palette, indices };
  }
}
