/**
 * Entity collision boxes, as the running game reports them.
 *
 * Kept in its own module rather than on the physics table because the renderer needs it per
 * frame (a spawner's cage scales its mob by it) and `app/physics.ts` is the movement
 * integrator's, not the renderer's. Installed from the baked bundle, which is where the
 * extraction's numbers arrive in the browser.
 *
 * Unset is a legitimate state: `sizeOf` answers null and the caller falls back to vanilla's
 * behaviour for a mob that fits in one block, which is the least wrong guess available.
 */

export interface EntitySize {
  w: number;
  h: number;
}

let sizes: Record<string, EntitySize> | undefined;

export function setEntitySizes(table: Record<string, EntitySize> | undefined): void {
  sizes = table;
}

export function sizeOf(entityType: string): EntitySize | null {
  return sizes?.[entityType] ?? null;
}

/** How many types are known; 0 when the bundle carried none. For diagnostics. */
export function knownSizeCount(): number {
  return sizes ? Object.keys(sizes).length : 0;
}
