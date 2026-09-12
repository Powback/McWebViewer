/**
 * Item frames: an entity whose appearance is a block model.
 *
 * This one was mis-filed for a while on a sentence that sounded authoritative — "no entity
 * model by design" — which is TRUE and does not imply what it was used to imply. An item
 * frame has no `EntityModel`, and it has a perfectly ordinary block model:
 *
 *     blockstates/item_frame.json   map=false -> block/item_frame, map=true -> block/item_frame_map
 *     models/block/item_frame.json  -> template_item_frame, five elements
 *
 * Vanilla's `ItemFrameRenderer` calls `BlockRenderDispatcher.renderSingleBlock` on exactly
 * that model and positions it by the entity's facing. So the renderer already had every
 * piece — the blockstate resolver, the mesher, the textures — and only the wiring was
 * missing. A classification label had been read as if it described the draw path.
 *
 * WHAT THIS WORLD CONTAINS, measured before building: 3 `minecraft:item_frame`, all facing
 * south, all with `ItemRotation` 0, all holding a modded item. **0 `glow_item_frame` and 0
 * framed maps** — both are implemented anyway because they are a state key each and the cost
 * of getting them wrong later is higher than the cost of handling them now, but neither is
 * verifiable here and both are category 2 until a world has one.
 */

/**
 * Block states an ENTITY needs but no block ever places, so the world scan cannot find them.
 * The bake adds these explicitly; without that they resolve to zero quads.
 */
export const ENTITY_BLOCK_STATES: readonly string[] = [
  'minecraft:item_frame[map=false]',
  'minecraft:item_frame[map=true]',
  'minecraft:glow_item_frame[map=false]',
  'minecraft:glow_item_frame[map=true]',
];

/** `Facing` is a `Direction` ordinal: down, up, north, south, west, east. */
export type FrameFacing = 0 | 1 | 2 | 3 | 4 | 5;

export interface FrameAppearance {
  /** the block state to mesh */
  stateKey: string;
  /** degrees about Y, in the same convention `addEntityMesh` uses for mobs */
  yawDeg: number;
  /** degrees about X, baked into the geometry — a frame on the floor or ceiling */
  pitchDeg: number;
}

/**
 * `Direction.toYRot()`: south is 0 and it advances clockwise. Down and up have no yaw.
 */
const Y_ROT: Record<number, number> = { 2: 180, 3: 0, 4: 90, 5: 270 };

/**
 * How to orient the frame's block model for a given facing.
 *
 * The model as authored occupies z 15..16 — its backing is at +z, so it faces NORTH. Mob
 * models face north too, which is why the yaw uses the same `180 - yRot` convention the
 * entity path already uses rather than inventing a second one.
 *
 * A frame lying on the floor or stuck to the ceiling needs a pitch as well, and
 * `addEntityMesh` takes only one axis — so the pitch is baked into the geometry and the yaw
 * stays a per-instance transform.
 */
export function frameAppearance(facing: number, isMap: boolean, glow: boolean): FrameAppearance {
  const name = glow ? 'minecraft:glow_item_frame' : 'minecraft:item_frame';
  const stateKey = `${name}[map=${isMap}]`;
  if (facing === 0) return { stateKey, yawDeg: 0, pitchDeg: 90 };
  if (facing === 1) return { stateKey, yawDeg: 0, pitchDeg: -90 };
  return { stateKey, yawDeg: 180 - (Y_ROT[facing] ?? 0), pitchDeg: 0 };
}

/** Whether a stack is a filled map, which vanilla draws with a different model. */
export function isFramedMap(itemId: string | null | undefined): boolean {
  return itemId === 'minecraft:filled_map';
}

/**
 * Where the framed item sits, in the frame's own space before the frame's yaw is applied.
 *
 * Vanilla lifts the item just clear of the backing board so it does not z-fight it. The
 * frame's backing is the `z 15..16` slab, so "just in front" is a small negative z.
 */
export const ITEM_LIFT_FROM_BOARD = -0.045;

/** `ItemRotation` is 0..7 in 45-degree steps, turning the item within the frame. */
export function itemRotationDeg(rotation: number | null | undefined): number {
  const n = typeof rotation === 'number' && Number.isFinite(rotation) ? rotation : 0;
  return ((n % 8) + 8) % 8 * 45;
}

/** The parts of a built mesh this rotation touches. */
export interface PitchableMesh {
  layers: Partial<Record<string, {
    positions: Float32Array;
    normals: Float32Array | Int8Array;
  }>>;
}

/**
 * Rotate a built block mesh about X, for a frame on the floor or the ceiling.
 *
 * `addEntityMesh` carries one rotation axis and the yaw already uses it, so the pitch is
 * baked into the vertices instead. Positions and normals both turn; leaving the normals
 * would light a floor frame as though it were still on a wall.
 *
 * Returns the mesh unchanged at zero pitch, which is every frame in this world.
 */
export function pitchMesh<T extends PitchableMesh>(mesh: T, pitchDeg: number): T {
  if (!pitchDeg) return mesh;
  const a = (pitchDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (const buf of Object.values(mesh.layers)) {
    if (!buf) continue;
    rotateXTriples(buf.positions, c, s);
    // Normals are snorm8; rotating them in place keeps the encoding, since a rotation is
    // norm-preserving and 127 stays 127.
    rotateXTriples(buf.normals, c, s);
  }
  return mesh;
}

function rotateXTriples(a: Float32Array | Int8Array, c: number, s: number): void {
  for (let i = 0; i < a.length; i += 3) {
    const y = a[i + 1];
    const z = a[i + 2];
    a[i + 1] = Math.round((y * c - z * s) * 1e6) / 1e6;
    a[i + 2] = Math.round((y * s + z * c) * 1e6) / 1e6;
  }
}
