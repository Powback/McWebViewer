/**
 * The world-source toggle: a control that flips between `bridge` and `spacetime`.
 *
 * Switching used to mean editing a URL by hand or setting an env var and restarting a
 * container. This puts it on screen.
 *
 * **WHY IT RELOADS, deliberately.** The two sources do not just differ in where rows come
 * from — they load different terrain, different entity streams, and one of them opens a
 * bridge socket that keeps a `save-all flush` running on a live server. Swapping all of that
 * in place means tearing down and rebuilding the entity tracks, the computer registry, the
 * terrain namer's caches, the flush timer and the section meshes, with every one of those a
 * chance to leave half the page on the old source. A half-switched viewer is worse than a
 * one-second reload, because it looks like it worked.
 *
 * So the toggle sets `?source=` and reloads, which is atomic by construction: the page comes
 * up wholly on one source or wholly on the other, and the URL that produced it is visible
 * and shareable. The button says so rather than pretending the switch is free.
 *
 * The URL is also exactly the top of the existing precedence chain (URL beats the served
 * config beats the default), so the control composes with how the source was already
 * selected instead of adding a fourth rule — and the HUD keeps reporting which layer
 * decided, so "I clicked it" and "the deployment is set that way" stay distinguishable.
 */

import type { WorldSourceConfig, WorldSourceKind } from './world-source.js';

export interface SourceToggleDeps {
  root: HTMLElement;
  /** navigate to a URL; injected so the behaviour is testable without a browser */
  go?: (url: string) => void;
  /** the current page URL; injected for the same reason */
  href?: () => string;
}

/** The other source — what pressing the button switches to. */
export function otherSource(kind: WorldSourceKind): WorldSourceKind {
  return kind === 'bridge' ? 'spacetime' : 'bridge';
}

/**
 * The URL that selects `kind`, preserving everything else about the current one.
 *
 * Rebuilt from the real URL rather than assembled from scratch so that `?auto=1`, a chosen
 * shaderpack or any other parameter survives the switch — losing those would make the
 * toggle feel like it reset the page.
 */
export function urlForSource(href: string, kind: WorldSourceKind): string {
  const url = new URL(href);
  url.searchParams.set('source', kind);
  return url.toString();
}

/** What the control should read, given the resolved source. */
export function toggleLabel(source: WorldSourceConfig | null): { label: string; title: string } {
  if (!source) {
    return { label: 'source: ...', title: 'resolving the world source' };
  }
  const target = otherSource(source.kind);
  return {
    label: `source: ${source.kind}`,
    title: source.kind === 'bridge'
      ? `RCON bridge + save files. Click to switch to spacetime (${target}); the view reloads.`
      : `SpacetimeDB, no bridge. Click to switch back to the bridge (${target}); the view reloads.`,
  };
}

export class SourceToggle {
  private el: HTMLButtonElement;
  private note: HTMLSpanElement;
  private source: WorldSourceConfig | null = null;

  constructor(private deps: SourceToggleDeps) {
    // IN THE LEFT COLUMN, NOT A FLOATING BOX. This used to create its own fixed container at
    // top:8px right:8px -- the very coordinates #topright already occupies -- so two control groups
    // overlapped, one drawn over the other by z-index alone. It now lives in #topleft above the HUD
    // text, which is the "where this data comes from" side of the screen. Markup and styling are in
    // index.html; this only drives them.
    const existing = document.getElementById('source') as HTMLButtonElement | null;
    this.el = existing ?? document.createElement('button');
    this.el.id = 'source';
    this.el.type = 'button';
    this.el.addEventListener('click', () => this.flip());

    const note = document.getElementById('source-note') as HTMLSpanElement | null;
    this.note = note ?? document.createElement('span');
    this.note.id = 'source-note';

    // Only when the page has no such markup (tests, embeds) does it fall back to appending.
    if (!existing) {
      const host = document.getElementById('topleft') ?? deps.root;
      host.append(this.el, this.note);
    }
    this.render();
  }

  /** Called once the source has actually been resolved. */
  setSource(source: WorldSourceConfig): void {
    this.source = source;
    this.render();
  }

  private render(): void {
    const { label, title } = toggleLabel(this.source);
    this.el.textContent = label;
    this.el.title = title;
    this.el.disabled = this.source === null;
    this.el.classList.toggle('spacetime', this.source?.kind === 'spacetime');
    // Which layer chose it, so a deployment setting and a click are distinguishable.
    this.note.textContent = this.source ? `[${this.source.origin}]` : '';
  }

  private flip(): void {
    if (!this.source) return;
    const target = otherSource(this.source.kind);
    const href = (this.deps.href ?? (() => location.href))();
    // Say what is about to happen before it happens: the reload takes a moment and a
    // button that appears to do nothing is the thing this project keeps fixing.
    this.el.textContent = `switching to ${target}...`;
    this.el.disabled = true;
    const go = this.deps.go ?? ((u: string) => { location.href = u; });
    go(urlForSource(href, target));
  }
}
