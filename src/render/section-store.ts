/**
 * The scene's section meshes, and everything that has to happen when one goes away.
 *
 * THE BUG THIS OWNS. A section mesh is a BufferGeometry built by hand, five attributes and
 * an index, ~160 KB of typed arrays for a busy section. Nothing in three.js frees that for
 * you: dropping the last reference to a Mesh returns the JS arrays to the GC but leaves the
 * GL buffers allocated until `geometry.dispose()` is called. And the viewer's own counters
 * (`quads`, `sections`) only ever went up, so a session that meshed and dropped the same
 * hillside twenty times reported twenty hillsides — the HUD agreed with the leak instead of
 * exposing it.
 *
 * Split out of viewer.ts so this is testable: `Viewer` needs a WebGL context and cannot be
 * constructed in a test, but this needs only a `THREE.Object3D` to parent to, so the
 * release path — replace a section, evict a section, clear the world — runs for real in
 * `section-store.test.ts` against real geometries.
 */

import * as THREE from 'three';

/** What the store holds for one key: a world section, or a free-standing entity mesh. */
export interface SectionEntry {
  meshes: THREE.Mesh[];
  /**
   * World centre of the section. Cached rather than re-derived: the per-frame view pass
   * used to run a regex over every key every frame, which at the 6000 sections that were
   * resident before the budget existed is 360,000 regex executions a second, each one
   * allocating a match array.
   *
   * Null for an entity mesh, which moves under `setEntityTransform` and whose owner
   * reconciles it every poll — so the section budget must never be what removes it.
   */
  centre: [number, number, number] | null;
  /** attribute + index bytes AS BUILT; see the note on `releaseAfterUpload` */
  bytes: number;
  quads: number;
}

/** Attribute and index bytes of a geometry. Read before the arrays are released. */
export function geometryBytes(geom: THREE.BufferGeometry): number {
  let n = geom.index?.array?.byteLength ?? 0;
  for (const attr of Object.values(geom.attributes)) {
    n += (attr as THREE.BufferAttribute).array?.byteLength ?? 0;
  }
  return n;
}

function releaseArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: unknown }).array = null;
}

/**
 * Let go of the CPU copy of a geometry once the GPU has it.
 *
 * Section geometry is written once and never read back: nothing in this project raycasts
 * against it (raycast.ts walks the voxel world instead), nothing edits it in place, and a
 * changed section is re-meshed from scratch. After the upload the typed arrays are a second
 * copy of something the driver already holds — and at the ~900 MB this viewer was reaching,
 * that second copy IS the crash. The tab dies on its JS heap while the GPU is fine.
 *
 * `onUpload` fires from WebGLAttributes once the buffer exists, so `count`, `itemSize` and
 * the cached GL buffer all survive; only `array` goes. The price is that a lost WebGL
 * context can no longer be recovered by re-uploading — but this renderer has no
 * context-restore path at all, so that is not a recovery being given up.
 */
export function releaseAfterUpload(geom: THREE.BufferGeometry): void {
  geom.index?.onUpload(releaseArray);
  for (const attr of Object.values(geom.attributes)) {
    (attr as THREE.BufferAttribute).onUpload(releaseArray);
  }
}

export class SectionStore {
  private entries = new Map<string, SectionEntry>();
  private totalQuads = 0;
  private totalBytes = 0;

  constructor(private parent: THREE.Object3D) {}

  /**
   * Take ownership of a built section: parent its meshes, measure them, and arrange for
   * their CPU arrays to be dropped once uploaded. Replaces — and disposes — whatever was
   * under `key`, which is what makes a live re-mesh safe: region-sync re-meshes the same
   * key every time a turtle steps, and without the replace-disposes rule that is a leak of
   * one section per block moved.
   */
  add(
    key: string,
    meshes: THREE.Mesh[],
    opts: { centre: [number, number, number] | null; quads: number },
  ): void {
    this.remove(key);
    let bytes = 0;
    for (const m of meshes) {
      bytes += geometryBytes(m.geometry as THREE.BufferGeometry);
      releaseAfterUpload(m.geometry as THREE.BufferGeometry);
      this.parent.add(m);
    }
    this.entries.set(key, { meshes, centre: opts.centre, bytes, quads: opts.quads });
    this.totalBytes += bytes;
    this.totalQuads += opts.quads;
  }

  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    for (const m of entry.meshes) {
      this.parent.remove(m);
      m.geometry.dispose();
    }
    this.totalBytes -= entry.bytes;
    this.totalQuads -= entry.quads;
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
    // Belt and braces: the loop above brings both totals to zero, and if it ever does not,
    // a stale byte total would silently shrink the budget for the rest of the session.
    this.totalBytes = 0;
    this.totalQuads = 0;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): SectionEntry | undefined {
    return this.entries.get(key);
  }

  /** Every entry, sections and entity meshes alike. */
  [Symbol.iterator](): IterableIterator<[string, SectionEntry]> {
    return this.entries[Symbol.iterator]();
  }

  /** Keys and entries, sections and entity meshes alike. */
  all(): IterableIterator<[string, SectionEntry]> {
    return this.entries[Symbol.iterator]();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Entries that are world sections — the ones the budget governs. */
  get sectionCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.centre) n++;
    return n;
  }

  get quads(): number {
    return this.totalQuads;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}
