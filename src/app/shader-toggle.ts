/**
 * The shaderpack selector.
 *
 * The WebGPU/Iris pipeline has been in this repo for a while and there has never been a way
 * to reach it from the page — `?shaders=<id>` on the URL was the entire interface, plus a
 * backtick key to toggle it back off once it was running. A feature nobody can find is a
 * feature nobody has ("we have shaders implemented where is the shader selection?" — the
 * user, 2026-09-11). This puts it next to the source toggle, in the same left column.
 *
 * **WHY IT RELOADS, like the source toggle does.** `ShaderView.create` compiles a whole
 * pipeline, claims its own canvas over the renderer's, and the mesher has to know the pack's
 * `mc_Entity.x` block-id table BEFORE it meshes anything (`main.ts` sets `ctx.blockIdOf` from
 * the bundle at startup). Swapping packs in place would mean re-meshing every loaded section
 * against a different id table while the old pipeline still owns the canvas. Setting the URL
 * and reloading is atomic: the page comes up wholly on one pack or wholly on none, and the
 * URL that produced it is shareable.
 *
 * The pure functions are separate from the DOM so the URL rules can be tested without a
 * browser, which is where the interesting mistakes are — losing `?source=` on the way to a
 * shaderpack would silently drop someone back onto the wrong world.
 */

/** One pack the server has built and is serving. */
export interface ShaderPackInfo {
  id: string;
  /** Human name; falls back to the id when the index does not carry one. */
  name?: string;
}

/** "no pack" is a real choice and needs a name of its own in the rotation. */
export const SHADERS_OFF = null;

/**
 * The URL that selects `id`, or turns shaders off when it is null, preserving everything
 * else about the current one.
 *
 * `?source=`, `?auto=1` and the rest have to survive: the source toggle rebuilds the URL the
 * same way for the same reason, and a control that quietly resets the others would be worse
 * than no control.
 */
export function urlForShaders(href: string, id: string | null): string {
  const url = new URL(href);
  if (id === null) url.searchParams.delete('shaders');
  else url.searchParams.set('shaders', id);
  return url.toString();
}

/**
 * The pack the URL currently asks for: an id, or null for none.
 *
 * A BARE `?shaders` MEANS THE DEFAULT PACK, because that is what `startShaders` does with it
 * (`want || 'sildurs-lite'`) — so the control has to agree, or the button would read "off"
 * while a pack was plainly rendering.
 */
export function shadersFromUrl(href: string, fallback: string): string | null {
  const v = new URL(href).searchParams.get('shaders');
  if (v === null) return null;
  return v || fallback;
}

/**
 * What pressing the button selects next: off, then each pack in turn, then off again.
 *
 * A cycle rather than a dropdown because there is realistically one pack built at a time and
 * a select element for a single option is a worse control than a button that says what it is
 * about to do. It stays correct for any number of packs.
 */
export function nextPack(packs: readonly ShaderPackInfo[], current: string | null): string | null {
  if (packs.length === 0) return null;
  const i = packs.findIndex((p) => p.id === current);
  // Not in the list (an id typed into the URL by hand) counts as the end of the rotation, so
  // the next press turns shaders off rather than jumping somewhere unrelated.
  if (i < 0) return current === null ? packs[0]!.id : null;
  return i + 1 < packs.length ? packs[i + 1]!.id : null;
}

/** What the control should read, given the packs and what is selected. */
export function shaderLabel(
  packs: readonly ShaderPackInfo[] | null,
  current: string | null,
): { label: string; title: string; disabled: boolean } {
  if (packs === null) return { label: 'shaders: ...', title: 'looking for shaderpacks', disabled: true };
  if (packs.length === 0) {
    return {
      label: 'shaders: none built',
      title: "No shaderpack is served. Build one with 'npm run build-shaderpack'.",
      disabled: true,
    };
  }
  const name = (id: string) => packs.find((p) => p.id === id)?.name ?? id;
  const target = nextPack(packs, current);
  return {
    label: current === null ? 'shaders: off' : `shaders: ${name(current)}`,
    title: target === null
      ? 'Click to turn shaders off; the view reloads.'
      : `Click to load ${name(target)}; the view reloads.`,
    disabled: false,
  };
}

/**
 * The packs the server is serving.
 *
 * Two URLs for the same reason `ShaderView.fetchBundle` tries two: production serves the
 * read-only `.cache` mount at `/shaderpacks/`, the Vite dev server at `/dev/shaderpack/`.
 * A missing or unparseable index is "no packs", never an exception — the selector is an
 * enhancement and must not be able to break the page it sits on.
 */
export async function fetchPacks(
  fetcher: typeof fetch = fetch,
): Promise<ShaderPackInfo[]> {
  for (const url of ['/shaderpacks/index.json', '/dev/shaderpack/index.json']) {
    const r = await fetcher(url).catch(() => null);
    if (!r?.ok) continue;
    const body = await r.json().catch(() => null);
    const packs = Array.isArray(body) ? body : (body as { packs?: unknown })?.packs;
    if (!Array.isArray(packs)) continue;
    return packs
      .map((p): ShaderPackInfo | null => {
        if (typeof p === 'string') return { id: p };
        const id = (p as { id?: unknown })?.id;
        if (typeof id !== 'string' || !id) return null;
        const name = (p as { name?: unknown })?.name;
        return typeof name === 'string' ? { id, name } : { id };
      })
      .filter((p): p is ShaderPackInfo => p !== null);
  }
  return [];
}

export interface ShaderToggleDeps {
  root: HTMLElement;
  /** the default pack id a bare `?shaders` means; must match `startShaders` */
  fallbackId: string;
  go?: (url: string) => void;
  href?: () => string;
}

export class ShaderToggle {
  private el: HTMLButtonElement;
  /** null while the index is still being fetched — the button is disabled until then. */
  private packs: ShaderPackInfo[] | null = null;

  constructor(private deps: ShaderToggleDeps) {
    const existing = document.getElementById('shaders') as HTMLButtonElement | null;
    this.el = existing ?? document.createElement('button');
    this.el.id = 'shaders';
    this.el.type = 'button';
    this.el.addEventListener('click', () => this.flip());
    if (!existing) (document.getElementById('topleft') ?? deps.root).append(this.el);
    this.render();
  }

  setPacks(packs: ShaderPackInfo[]): void {
    this.packs = packs;
    this.render();
  }

  private current(): string | null {
    return shadersFromUrl((this.deps.href ?? (() => location.href))(), this.deps.fallbackId);
  }

  private render(): void {
    const { label, title, disabled } = shaderLabel(this.packs, this.current());
    this.el.textContent = label;
    this.el.title = title;
    this.el.disabled = disabled;
    this.el.classList.toggle('on', this.current() !== null && !disabled);
  }

  private flip(): void {
    if (!this.packs?.length) return;
    const target = nextPack(this.packs, this.current());
    // Say what is about to happen before it happens: compiling a pack takes a moment and a
    // button that appears to do nothing is the thing this project keeps fixing.
    this.el.textContent = target === null ? 'turning shaders off...' : `loading ${target}...`;
    this.el.disabled = true;
    const go = this.deps.go ?? ((u: string) => { location.href = u; });
    go(urlForShaders((this.deps.href ?? (() => location.href))(), target));
  }
}
