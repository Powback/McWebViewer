/**
 * Where the world says it starts.
 *
 * The free camera used to open on the first non-empty chunk of the first region loaded,
 * which is a function of region-file iteration order and nothing else — on the reference
 * server that put the page hundreds of blocks from the settlement every time it opened.
 * The world already records where it wants people to arrive: `Data.SpawnX/Y/Z` in
 * `level.dat`, the same point the server drops a new player on. This reads it.
 *
 * `level.dat` is a gzipped NBT compound; the region reader already carries both codecs, so
 * this costs nothing new. It is served read-only next to the region files (`/dev/level.dat`
 * in nginx and the Vite dev mount) and fetched once at boot. Anything that goes wrong —
 * no file, a truncated fetch, a world with no spawn tag — yields null and the caller keeps
 * its old fallback; the camera must never fail to appear because a metadata read did.
 */

import { gunzipSync } from 'fflate';
import { parseNbt, type NbtCompound } from '../core/nbt.js';

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** `Data.SpawnX/Y/Z` from a level.dat, gzipped or not. Null when any of the three is absent. */
export function readSpawn(levelDat: Uint8Array): SpawnPoint | null {
  let raw = levelDat;
  if (raw.length > 2 && raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1]) {
    try { raw = gunzipSync(raw); } catch { return null; }
  }
  let root: NbtCompound;
  try { root = parseNbt(raw); } catch { return null; }
  const data = root.Data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return spawnOf(data as NbtCompound);
}

function spawnOf(d: NbtCompound): SpawnPoint | null {
  const [x, y, z] = [d.SpawnX, d.SpawnY, d.SpawnZ];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  return { x, y, z };
}

/** Fetch and read the served level.dat; null on any failure, never a throw. */
export async function fetchSpawn(url = '/dev/level.dat'): Promise<SpawnPoint | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return readSpawn(new Uint8Array(await r.arrayBuffer()));
  } catch {
    return null;
  }
}
