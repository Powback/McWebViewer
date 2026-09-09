/**
 * Entities.
 *
 * Entities split into honestly-different cases, and the audit reports them separately
 * rather than averaging them into one reassuring percentage:
 *
 *  block-model  the entity's geometry IS a block model we already have
 *               (falling_block carries its BlockState in NBT; contraption blocks too)
 *  contraption  Create-family contraptions: the entity NBT embeds a full palette +
 *               block list, so we render them with the ordinary block pipeline under a
 *               single entity transform. This is the interesting modded case and it
 *               needs no Java at all.
 *  invisible    entities vanilla itself draws nothing for (markers, glue anchors)
 *  extracted-model  geometry is built in Java, and the offline extraction captured that
 *               Java LayerDefinition as data (harness/out/entity-models.json) AND a
 *               texture for it exists. entity-geometry.ts turns it into quads, so these
 *               really do reach the screen.
 *  java-model   geometry is built in Java and the extraction did NOT produce usable
 *               geometry for it — no resolved model, or a texture path no jar supplies.
 *               Still reported as NOT covered.
 */

import type { NbtCompound, NbtList } from '../core/nbt.js';
import { LongBits } from '../core/nbt.js';
import { canonicalStateKey } from '../core/chunk.js';
import type { BakedQuad } from '../assets/model.js';
import { DIR_VEC } from '../assets/model.js';
import type { RenderableState } from './registry.js';
import { facesInward, quadOutward, type StateSource } from './mesher.js';
import type { SpriteRect, TextureAtlas } from './atlas.js';
import type { LayerBuffers, Layer } from './mesher.js';

export type EntityStrategy =
  | 'block-model'
  | 'contraption'
  | 'invisible'
  | 'extracted-model'
  | 'java-model'
  | 'unhandled';

/**
 * Whatever can answer "do we have drawable geometry for this entity type?".
 * `EntityModelSet` in entity-geometry.ts implements it; passing it in rather than
 * importing it keeps this module free of the geometry pipeline (and of a cycle), and
 * lets the audit and the renderer each apply their own "is the texture available" test.
 */
export interface EntityGeometrySource {
  hasGeometry(id: string): boolean;
}

/**
 * Explicit classification. Anything not listed is decided by whether the extraction has
 * geometry for it; with no extraction to consult it falls through to 'java-model', which
 * is the pessimistic answer — a mob we have never heard of is assumed to need the bake.
 */
export const ENTITY_STRATEGY: Record<string, EntityStrategy> = {
  'minecraft:falling_block': 'block-model',
  'minecraft:marker': 'invisible',
  'minecraft:item_display': 'invisible',
  'minecraft:block_display': 'block-model',
  'minecraft:text_display': 'invisible',
  'minecraft:interaction': 'invisible',
  'minecraft:area_effect_cloud': 'invisible',
  'minecraft:fishing_bobber': 'invisible',
  // Create's super glue and the Aeronautics discovery pins draw a small sprite/quad,
  // not a model. Vanilla-equivalent handling would be a billboard; until we draw them
  // they are honestly 'unhandled', not 'invisible'.
  'create:super_glue': 'unhandled',
  'simulated:honey_glue': 'unhandled',
  'aeronauticsdiscovery:pin': 'unhandled',
};

/** Contraption entity ids grow with every Create addon, so match structurally. */
export function isContraptionId(id: string): boolean {
  return id.includes('contraption') || id.endsWith(':carriage_contraption');
}

export function classifyEntity(id: string, geometry?: EntityGeometrySource): EntityStrategy {
  if (isContraptionId(id)) return 'contraption';
  const s = ENTITY_STRATEGY[id];
  if (s) return s;
  // Without a geometry source we cannot know, and the pessimistic answer is the honest
  // one: assume the bake does not cover it.
  return geometry?.hasGeometry(id) ? 'extracted-model' : 'java-model';
}

// ---------------------------------------------------------------------------
// Contraptions

export interface ContraptionBlock {
  x: number;
  y: number;
  z: number;
  stateKey: string;
}

export interface DecodedContraption {
  id: string;
  /** world position of the entity */
  pos: [number, number, number];
  /** rotation in degrees about `axis`, for bearing-style contraptions */
  angle: number;
  axis: 'X' | 'Y' | 'Z' | null;
  /** the anchor block the contraption was assembled around */
  anchor: [number, number, number] | null;
  blocks: ContraptionBlock[];
}

function asList(v: unknown): NbtCompound[] {
  return Array.isArray(v) ? (v as NbtCompound[]) : [];
}

/**
 * Create's `Contraption.writeBlocksCompound`: a HashMapPalette of BlockStates plus a
 * list of {Pos: long (BlockPos.asLong), State: int (palette index)}.
 *
 * BlockPos.asLong packs as  x:26 | y:12 | z:26  with y in the low bits:
 *   (x & 0x3FFFFFF) << 38 | (z & 0x3FFFFFF) << 12 | (y & 0xFFF)
 * all three signed. We decode via BigInt because these are genuinely 64-bit and this
 * runs once per contraption, not per block face.
 */
export function decodeContraption(entity: NbtCompound): DecodedContraption | null {
  const id = (entity.id as string) ?? 'unknown';
  const contraption = entity.Contraption as NbtCompound | undefined;
  if (!contraption) return null;
  const blocksTag = contraption.Blocks as NbtCompound | undefined;
  if (!blocksTag) return null;

  const palette = decodePalette(asList(blocksTag.Palette));
  const blocks = decodeBlockList(asList(blocksTag.BlockList), palette);

  return {
    id,
    pos: decodeEntityPos(entity),
    angle: typeof entity.Angle === 'number' ? entity.Angle : 0,
    axis: (entity.Axis as 'X' | 'Y' | 'Z') ?? null,
    anchor: decodeAnchor(contraption),
    blocks,
  };
}

/** The HashMapPalette: each entry is a BlockState name plus its properties. */
function decodePalette(paletteTag: NbtCompound[]): string[] {
  return paletteTag.map((e) => {
    const name = e.Name as string;
    const props = e.Properties as NbtCompound | undefined;
    let p: Record<string, string> | undefined;
    if (props) {
      p = {};
      for (const k in props) p[k] = String(props[k]);
    }
    return canonicalStateKey(name, p);
  });
}

/** The BlockList: {Pos: long (BlockPos.asLong), State: int (palette index)} entries. */
function decodeBlockList(blockList: NbtCompound[], palette: string[]): ContraptionBlock[] {
  const blocks: ContraptionBlock[] = [];
  for (const b of blockList) {
    const posRaw = b.Pos;
    if (typeof posRaw !== 'bigint') continue;
    const stateIdx = (b.State as number) ?? 0;
    const stateKey = palette[stateIdx];
    if (!stateKey) continue;
    const { x, y, z } = unpackBlockPos(posRaw);
    blocks.push({ x, y, z, stateKey });
  }
  return blocks;
}

/** World position of the contraption entity itself. */
function decodeEntityPos(entity: NbtCompound): [number, number, number] {
  const posTag = entity.Pos as NbtList | undefined;
  return Array.isArray(posTag)
    ? [Number(posTag[0]), Number(posTag[1]), Number(posTag[2])]
    : [0, 0, 0];
}

/**
 * `Anchor` is informational only — rendering uses `Pos`. Create's encoding of it has
 * not been pinned down here and the observed values are not plausible block
 * coordinates, so it is range-checked and dropped rather than reported wrongly.
 */
function decodeAnchor(contraption: NbtCompound): [number, number, number] | null {
  const anchorTag = contraption.Anchor;
  let anchor: [number, number, number] | null = null;
  if (anchorTag instanceof Int32Array && anchorTag.length === 3) {
    anchor = [anchorTag[0], anchorTag[1], anchorTag[2]];
  } else if (typeof anchorTag === 'bigint') {
    const a = unpackBlockPos(anchorTag);
    anchor = [a.x, a.y, a.z];
  }
  if (anchor && (Math.abs(anchor[0]) > 3e7 || Math.abs(anchor[1]) > 4096 || Math.abs(anchor[2]) > 3e7)) {
    anchor = null;
  }
  return anchor;
}

/** net.minecraft.core.BlockPos.asLong inverse. */
export function unpackBlockPos(v: bigint): { x: number; y: number; z: number } {
  const sign = (n: bigint, bits: bigint) => {
    const m = 1n << (bits - 1n);
    return Number((n ^ m) - m);
  };
  const x = sign((v >> 38n) & 0x3ffffffn, 26n);
  const z = sign((v >> 12n) & 0x3ffffffn, 26n);
  const y = sign(v & 0xfffn, 12n);
  return { x, y, z };
}

// ---------------------------------------------------------------------------
// Meshing an arbitrary set of blocks (used by contraptions)

export interface BlockSetMesh {
  layers: Partial<Record<Layer, LayerBuffers>>;
  quadCount: number;
  /** states in the set that produced no geometry */
  unresolved: string[];
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  n = 0;
}

/**
 * Mesh a free-standing set of blocks with self-culling. Reuses the block registry and
 * atlas, which is exactly the point: a Create contraption is just blocks, so it renders
 * through the same path as terrain and needs no bespoke Create code.
 */
export function meshBlockSet(
  blocks: ContraptionBlock[],
  registry: StateSource,
  atlas: TextureAtlas,
): BlockSetMesh {
  const byPos = new Map<string, string>();
  for (const b of blocks) byPos.set(`${b.x},${b.y},${b.z}`, b.stateKey);

  const builders: Partial<Record<Layer, Builder>> = {};
  const unresolved = new Set<string>();
  let quadCount = 0;

  for (const b of blocks) {
    const state = registry.resolve(b.stateKey);
    if (!state.quads.length) {
      if (state.provenance !== 'air') unresolved.add(b.stateKey);
      continue;
    }
    const bd = (builders[layerFor(state.renderType)] ??= new Builder());

    for (const q of state.quads as BakedQuad[]) {
      if (isQuadCulled(q, b, byPos, registry)) continue;
      const sprite = atlas.get(q.texture);
      if (!sprite) continue;

      appendQuad(bd, q, b, sprite);
      quadCount++;
    }
  }

  return { layers: finishLayers(builders), quadCount, unresolved: [...unresolved] };
}

const SHADE: Record<string, number> = {
  down: 0.5, up: 1.0, north: 0.8, south: 0.8, west: 0.6, east: 0.6,
};

function layerFor(renderType: RenderableState['renderType']): Layer {
  return renderType === 'translucent'
    ? 'translucent'
    : renderType === 'solid'
      ? 'solid'
      : 'cutout';
}

/** A quad is dropped when the neighbour it faces inside the same set fully occludes it. */
function isQuadCulled(
  q: BakedQuad,
  b: ContraptionBlock,
  byPos: Map<string, string>,
  registry: StateSource,
): boolean {
  if (!q.cullface) return false;
  const d = DIR_VEC[q.cullface];
  const nk = `${b.x + d[0]},${b.y + d[1]},${b.z + d[2]}`;
  const neighbour = byPos.get(nk);
  return Boolean(neighbour && registry.resolve(neighbour).opaqueFullCube);
}

function appendQuad(bd: Builder, q: BakedQuad, b: ContraptionBlock, sprite: SpriteRect): void {
  // Contraptions are lit by the level they fly through; without that context,
  // full brightness plus vanilla directional shading reads correctly.
  const v = q.shade ? SHADE[q.facing] : 1;
  const su = sprite.u1 - sprite.u0;
  const sv = sprite.v1 - sprite.v0;
  const base = bd.n;
  for (let i = 0; i < 4; i++) {
    bd.pos.push(
      q.positions[i * 3] + b.x,
      q.positions[i * 3 + 1] + b.y,
      q.positions[i * 3 + 2] + b.z,
    );
    bd.nor.push(q.normal[0], q.normal[1], q.normal[2]);
    bd.uv.push(sprite.u0 + q.uvs[i * 2] * su, sprite.v0 + q.uvs[i * 2 + 1] * sv);
    bd.col.push(v, v, v, 1);
  }
  // Same rule as the terrain mesher (see SectionBuilder.quad): vanilla's corner order is
  // counter-clockwise-from-outside for the side faces but clockwise for the horizontal
  // ones, and a variant rotation reorders corners again. A fixed index order therefore
  // back-face-culled every top and bottom here — a live turtle drew as an open box you
  // looked into, its lid gone and the inside of its far walls showing — while the same
  // state meshed as terrain was fine. Deriving the winding from the geometry cannot
  // disagree with the geometry.
  if (facesInward(q.positions, quadOutward(q))) {
    bd.idx.push(base + 2, base + 1, base, base, base + 3, base + 2);
  } else {
    bd.idx.push(base, base + 1, base + 2, base + 2, base + 3, base);
  }
  bd.n += 4;
}

function finishLayers(
  builders: Partial<Record<Layer, Builder>>,
): Partial<Record<Layer, LayerBuffers>> {
  const layers: Partial<Record<Layer, LayerBuffers>> = {};
  for (const k of ['solid', 'cutout', 'translucent'] as Layer[]) {
    const b = builders[k];
    if (!b || !b.idx.length) continue;
    layers[k] = {
      positions: new Float32Array(b.pos),
      normals: new Float32Array(b.nor),
      uvs: new Float32Array(b.uv),
      colors: new Float32Array(b.col),
      indices: new Uint32Array(b.idx),
    };
  }
  return layers;
}

void LongBits;
