/**
 * Turtle upgrades: the pickaxe, modem, speaker or scanner bolted to a turtle's side.
 *
 * A turtle's block STATE says only which way it faces. What it carries lives in its block
 * entity — `LeftUpgrade` / `RightUpgrade`, each `{ id, components }`, the shape the
 * ComputerCraft API saves — and in game the turtle's renderer composites the upgrade's
 * model onto the body every frame. The mesher keys geometry by state, so upgrades need a
 * state of their own: this module mints a synthetic one,
 *
 *     mcwv:turtle_upgrade[facing=north,on=true,side=left,upgrade=computercraft:wireless_modem_normal]
 *
 * which the registry bakes like any other block, the bake tool collects from every block
 * entity carrying those fields (one key per facing so a turtle can turn without a re-bake),
 * and the mesher emits at the entity's own position. Nothing here names a block or a mod:
 * ANY block entity with `LeftUpgrade`/`RightUpgrade` is a turtle.
 *
 * WHICH MODEL — one generic path, data first:
 *   1. The upgrade DEFINITION, `data/<ns>/computercraft/turtle_upgrade/<name>.json` (the
 *      CC:T API's datapack registry): `type`, `item`.
 *   2. A SIDED MODEL by the convention every mod that ships one follows,
 *      `<namespace>:block/turtle_<name>_<side>`, tried over the upgrade's, the type's and
 *      the item's namespace and names (with a `_turtle`/`turtle_` affix stripped): CC:T's
 *      `turtle_speaker_left`, `turtle_crafting_table_left`, Advanced Peripherals'
 *      `turtle_geoscanner_left` all resolve this way from the jars alone.
 *   3. Else the ITEM's model — what CC:T's own `flatItem` modeller renders for tools:
 *      a generated item (has `layer0`) becomes a one-texel card stood on the side; a block
 *      item (has elements — a modem, a chest) is the block model fitted into the footprint
 *      of the mod's `turtle_upgrade_base_<side>` model, so a modem is a modem on the side.
 *
 * WHAT STAYS JAVA, AND HOW IT IS HANDLED. CC:T registers its modem models in code
 * (`turtle_modem_{normal|advanced}_{on|off}_{side}`) with no data mapping from the upgrade
 * to them, so a modem takes path 3 from its item — right shape and texture, without the
 * on/off glow. The flat-item placement matrix is Java too; only its two offsets (±0.4065,
 * read from the jar's constant pool) are numbers, the rest is "stand the item upright on the
 * side, image top toward the front", checked against the game.
 *
 * The turtle blockstate's rotation (north 0, east 90, south 180, west 270) is applied last,
 * exactly as it is to the body.
 */

import type { NbtCompound } from '../core/nbt.js';
import { canonicalStateKey } from '../core/chunk.js';
import {
  bakeModel,
  type BakedModel,
  type BakedQuad,
  type Direction,
  type ModelLoader,
  type RawModel,
} from '../assets/model.js';
import { parseId, readJson, type Pack } from '../assets/pack.js';

export const TURTLE_UPGRADE_STATE = 'mcwv:turtle_upgrade';

export type TurtleSide = 'left' | 'right';
export const TURTLE_SIDES: readonly TurtleSide[] = ['left', 'right'];
/** Every facing a turtle blockstate has; a key is baked per facing so turning needs no re-bake. */
export const TURTLE_FACINGS = ['north', 'east', 'south', 'west'] as const;
const TURTLE_YAW: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };
/** The flat-item offset from the block centre, CC:T's constant. */
const FLAT_ITEM_OFFSET = 0.4065;

export interface TurtleUpgrade {
  /** upgrade id, e.g. `computercraft:wireless_modem_normal`, `minecraft:diamond_pickaxe` */
  id: string;
  /** the `computercraft:on` component — a modem with a channel open glows */
  on: boolean;
}
export type TurtleUpgrades = Partial<Record<TurtleSide, TurtleUpgrade>>;

/** `LeftUpgrade` / `RightUpgrade` of a block entity. Null when it has neither — not a turtle, or bare. */
export function readTurtleUpgrades(be: NbtCompound): TurtleUpgrades | null {
  const out: TurtleUpgrades = {};
  const left = readUpgrade(be.LeftUpgrade);
  const right = readUpgrade(be.RightUpgrade);
  if (left) out.left = left;
  if (right) out.right = right;
  return left || right ? out : null;
}

function readUpgrade(v: unknown): TurtleUpgrade | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as NbtCompound;
  if (typeof c.id !== 'string' || !c.id) return null;
  const comps = c.components;
  const on = !!comps && typeof comps === 'object' && !Array.isArray(comps)
    && (comps as NbtCompound)['computercraft:on'] === 1;
  return { id: c.id, on };
}

export function upgradeStateKey(facing: string, side: TurtleSide, up: TurtleUpgrade): string {
  return canonicalStateKey(TURTLE_UPGRADE_STATE, {
    facing, side, upgrade: up.id, on: String(up.on),
  });
}

/** The synthetic keys a turtle with these upgrades needs at this facing. */
export function upgradeStateKeys(facing: string, ups: TurtleUpgrades | null): string[] {
  if (!ups) return [];
  const out: string[] = [];
  for (const side of TURTLE_SIDES) {
    const u = ups[side];
    if (u) out.push(upgradeStateKey(facing, side, u));
  }
  return out;
}

/** The keys for every facing — what the bake collects so a turtle may turn later. */
export function upgradeStateKeysAllFacings(ups: TurtleUpgrades | null): string[] {
  const out: string[] = [];
  for (const f of TURTLE_FACINGS) out.push(...upgradeStateKeys(f, ups));
  return out;
}

// ---------------------------------------------------------------------------
// Baking

interface UpgradeDef {
  type?: string;
  item?: string;
}

function upgradeDefPath(id: string): string {
  const r = parseId(id);
  return `data/${r.namespace}/computercraft/turtle_upgrade/${r.path}.json`;
}

/** `<ns>:block/turtle_<name>_<side>` over every namespace and name the definition offers. */
export function sidedModelCandidates(upgradeId: string, def: UpgradeDef, side: TurtleSide): string[] {
  const ids = [upgradeId, def.type, def.item].filter((v): v is string => typeof v === 'string' && v.includes(':'));
  const namespaces = new Set<string>();
  const names = new Set<string>();
  for (const id of ids) {
    const r = parseId(id);
    namespaces.add(r.namespace);
    const base = r.path.split('/').pop() ?? r.path;
    names.add(base);
    names.add(base.replace(/_turtle$/, '').replace(/^turtle_/, ''));
  }
  const out: string[] = [];
  for (const ns of namespaces) for (const n of names) out.push(`${ns}:block/turtle_${n}_${side}`);
  return out;
}

/**
 * Bake one synthetic upgrade state. Null when the packs define nothing drawable for it —
 * the turtle then renders bare, as it did before.
 */
export function bakeTurtleUpgrade(
  pack: Pack,
  models: ModelLoader,
  props: Record<string, string>,
): BakedModel | null {
  const parsed = parseUpgradeProps(props);
  if (!parsed) return null;
  const { side, yaw, upgradeId } = parsed;

  const def = readJson<UpgradeDef>(pack, upgradeDefPath(upgradeId)) ?? {};
  const exact = sidedModelCandidates(upgradeId, def, side);
  const namespaces = new Set(exact.map((c) => c.split(':')[0]));
  const fuzzy = nearestSidedModel(pack, namespaces, exact, side, parsed.on);
  for (const id of [...exact, ...(fuzzy ? [fuzzy] : [])]) {
    if (!models.resolve(id)) continue;
    const baked = models.bake(id, { model: id, y: yaw });
    if (baked && baked.quads.length) return baked;
  }
  return bakeItemUpgrade(models, def.item ?? upgradeId, side, yaw, namespaces);
}

/**
 * The mod's own sided turtle model whose NAME shares the most words with the upgrade —
 * for the models a mod registers in code under a name the convention does not predict.
 * CC:T's `turtle_modem_normal_on_left` for upgrade `wireless_modem_normal` shares
 * `modem`, `normal`; nothing else in its `block/turtle_*_left` set comes close. Every
 * candidate namespace's `models/block/turtle_*_<side>.json` is scanned; a model whose name
 * carries an `on`/`off` word must match the upgrade's state. Null when nothing shares a
 * word — the item path takes over, never a guess.
 */
export function nearestSidedModel(
  pack: Pack,
  namespaces: ReadonlySet<string>,
  exactCandidates: readonly string[],
  side: TurtleSide,
  on: boolean,
): string | null {
  const wanted = wantedWords(exactCandidates, side);
  let best: { id: string; score: number } | null = null;
  for (const ns of namespaces) {
    for (const path of pack.list(`assets/${ns}/models/block/turtle_`)) {
      const scored = scoreSidedModel(path, side, on, wanted);
      if (scored && (!best || scored.score > best.score)) best = { id: `${ns}:block/${scored.name}`, score: scored.score };
    }
  }
  return best?.id ?? null;
}

/** The words of the upgrade's own names, as the exact candidates spell them. */
function wantedWords(exactCandidates: readonly string[], side: TurtleSide): Set<string> {
  const wanted = new Set<string>();
  for (const c of exactCandidates) {
    const name = c.slice(c.indexOf('turtle_') + 'turtle_'.length, -(side.length + 1));
    for (const t of name.split('_')) if (t && t !== 'turtle') wanted.add(t);
  }
  return wanted;
}

/** One `turtle_*_<side>.json` model file: its shared-word score, or null if it does not apply. */
function scoreSidedModel(
  path: string, side: TurtleSide, on: boolean, wanted: ReadonlySet<string>,
): { name: string; score: number } | null {
  const m = /^assets\/[^/]+\/models\/block\/(turtle_(.+)_(left|right))\.json$/.exec(path);
  if (!m || m[3] !== side) return null;
  const tokens = m[2].split('_');
  const hasOn = tokens.includes('on');
  const hasOff = tokens.includes('off');
  // A model that names a state must be the upgrade's state.
  if ((hasOn || hasOff) && hasOn !== on) return null;
  const score = tokens.filter((t) => wanted.has(t)).length;
  return score > 0 ? { name: m[1], score } : null;
}

interface UpgradeProps { side: TurtleSide; yaw: number; upgradeId: string; on: boolean }

/** The synthetic state's properties, validated; null for a key this module did not mint. */
function parseUpgradeProps(props: Record<string, string>): UpgradeProps | null {
  const side = props.side as TurtleSide;
  const facing = props.facing ?? 'north';
  const upgradeId = props.upgrade ?? '';
  if (!TURTLE_SIDES.includes(side) || !upgradeId || !(facing in TURTLE_YAW)) return null;
  return { side, yaw: TURTLE_YAW[facing], upgradeId, on: props.on === 'true' };
}

/** Path 3: the upgrade drawn as its item — a card for a generated item, the block for a block item. */
function bakeItemUpgrade(
  models: ModelLoader, itemId: string, side: TurtleSide, yaw: number, namespaces: ReadonlySet<string>,
): BakedModel | null {
  const r = parseId(itemId);
  const id = `${r.namespace}:item/${r.path}`;
  const resolved = models.resolve(id);
  if (!resolved) return null;
  if (resolved.model.elements?.length) return bakeBlockItemUpgrade(models, id, side, yaw, namespaces);
  const sprite = resolved.model.textures?.layer0;
  return sprite ? bakeFlatItem(sprite, side, yaw) : null;
}

/**
 * A generated item stood upright on the side as CC:T's flat-item modeller places it: a
 * one-texel card at x = 0.5 -+ 0.4065, spanning the block's height and depth, image x up
 * the turtle and image top toward the FRONT (checked against the game: a mining turtle's
 * pick head is up and forward). Probing bakeModel's face-UV conventions gives that as
 * rotation 90 with both uv axes flipped on the left, u flipped on the right.
 */
function bakeFlatItem(sprite: string, side: TurtleSide, yaw: number): BakedModel {
  const x = side === 'left' ? 16 * (0.5 - FLAT_ITEM_OFFSET) : 16 * (0.5 + FLAT_ITEM_OFFSET);
  const face: Direction = side === 'left' ? 'west' : 'east';
  const uv: [number, number, number, number] = side === 'left' ? [16, 16, 0, 0] : [16, 0, 0, 16];
  const card: RawModel = {
    textures: { layer0: sprite },
    elements: [{
      from: [x - 0.5, 0, 0],
      to: [x + 0.5, 16, 16],
      shade: false,
      faces: { [face]: { uv, texture: '#layer0', rotation: 90 } },
    }],
  };
  const baked = bakeModel(card, { model: '', y: yaw });
  return { ...baked, fullCube: false, fullCubeTextures: undefined, renderType: 'cutout' };
}

/** The box a sided upgrade occupies when the mod ships no model of its own (model units). */
const DEFAULT_UPGRADE_BOX: Record<TurtleSide, { from: [number, number, number]; to: [number, number, number] }> = {
  left: { from: [0.5, 4.5, 3.5], to: [2, 12.5, 11.5] },
  right: { from: [14, 4.5, 3.5], to: [15.5, 12.5, 11.5] },
};

/**
 * A block item (a modem, a chest) fitted into the side footprint: its block model, turned
 * so its front (`north`) looks out of the turtle's side, then scaled into the box the mod's
 * own `turtle_upgrade_base_<side>` model occupies — read from the jar when it exists, so
 * the footprint is the mod's, not ours. Then the turtle's yaw.
 */
function bakeBlockItemUpgrade(
  models: ModelLoader, itemModel: string, side: TurtleSide, yaw: number, namespaces: ReadonlySet<string>,
): BakedModel | null {
  // north -> west for the left side is a y rotation of 270 in vanilla's sense; -> east is 90.
  const faceOut = models.bake(itemModel, { model: itemModel, y: side === 'left' ? 270 : 90 });
  if (!faceOut || !faceOut.quads.length) return null;
  const box = upgradeBox(models, side, namespaces);
  const quads = fitQuads(faceOut.quads, box).map((q) => rotateQuadY(q, yaw));
  return { ...faceOut, quads, fullCube: false, fullCubeTextures: undefined };
}

/**
 * The footprint a sided upgrade occupies, from whichever involved mod ships a
 * `turtle_upgrade_base_<side>` model (the upgrade's, its type's or its item's namespace);
 * a stated default otherwise.
 */
function upgradeBox(
  models: ModelLoader, side: TurtleSide, namespaces: ReadonlySet<string>,
): { from: [number, number, number]; to: [number, number, number] } {
  for (const ns of namespaces) {
    const el = models.resolve(`${ns}:block/turtle_upgrade_base_${side}`)?.model.elements?.[0];
    if (el) return { from: el.from, to: el.to };
  }
  return DEFAULT_UPGRADE_BOX[side];
}

/** Scale and translate a quad set so its bounding box becomes `box` (model units -> blocks). */
function fitQuads(quads: BakedQuad[], box: { from: [number, number, number]; to: [number, number, number] }): BakedQuad[] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const q of quads) for (let i = 0; i < 4; i++) for (let a = 0; a < 3; a++) {
    const v = q.positions[i * 3 + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  const scale = [0, 1, 2].map((a) => (box.to[a] - box.from[a]) / 16 / Math.max(max[a] - min[a], 1e-6));
  return quads.map((q) => {
    const p = new Float32Array(12);
    for (let i = 0; i < 4; i++) for (let a = 0; a < 3; a++) {
      p[i * 3 + a] = box.from[a] / 16 + (q.positions[i * 3 + a] - min[a]) * scale[a];
    }
    return { ...q, positions: p, cullface: null };
  });
}

const RING: Direction[] = ['north', 'east', 'south', 'west'];

/** The turtle's own yaw about the block centre, in vanilla's y-rotation sense (90 carries north to east). */
function rotateQuadY(q: BakedQuad, yaw: number): BakedQuad {
  const steps = ((yaw / 90) | 0) & 3;
  if (!steps) return q;
  const p = new Float32Array(q.positions);
  for (let i = 0; i < 4; i++) {
    let x = p[i * 3] - 0.5, z = p[i * 3 + 2] - 0.5;
    for (let k = 0; k < steps; k++) [x, z] = [-z, x];
    p[i * 3] = x + 0.5; p[i * 3 + 2] = z + 0.5;
  }
  const i = RING.indexOf(q.facing);
  const facing = i < 0 ? q.facing : RING[(i + steps) & 3];
  return { ...q, positions: p, facing };
}
