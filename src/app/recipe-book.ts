/**
 * The recipe browser.
 *
 * Every recipe in every installed mod, searchable, with "what makes this" and "what uses
 * this" — built from `recipes.json`, which is baked from the mods' own data with no
 * per-mod code (see server/recipe-bake.ts). 12,488 recipes across 73 types here.
 *
 * DOM rather than drawn into the WebGL canvas, for the same reason the rest of the HUD is:
 * this is text, boxes and 32px icons, which is what HTML is already good at, and keeping it
 * out of the render loop leaves the frame budget on the world.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *
 * - **It does not pretend a tag is an item.** A recipe that takes `#c:stones` is shown as a
 *   tag, because expanding it needs the tag files and this does not have them. Showing one
 *   arbitrary member would be a plausible lie about what the recipe accepts.
 * - **It does not let you craft.** Read-only is not a limitation of this panel, it is the
 *   transport: crafting means clicking slots in a container GUI, which is a packet a
 *   command-driven fake player has no way to send. The panel says so rather than offering a
 *   button that cannot work.
 */

import type { Recipe, RecipeIngredient } from '../assets/recipes.js';
import type { ItemIcons } from '../render/item-icons.js';

export interface RecipeBundleView {
  recipes: Recipe[];
  madeBy: Record<string, number[]>;
  usedIn: Record<string, number[]>;
  stats: { files: number; parsed: number; unreadable: number; types: number };
}

/** Trim a namespaced id for display: `create:andesite_alloy` -> `andesite alloy`. */
export function shortId(id: string): string {
  return id.replace(/^[^:]+:/, '').replace(/_/g, ' ');
}

/**
 * Search the bundle.
 *
 * Matches the recipe's OUTPUTS first and its id second, because "show me how to make X" is
 * what a recipe search is for; matching inputs too would bury the thing you asked for under
 * everything that happens to consume it.
 */
export function searchRecipes(bundle: RecipeBundleView, query: string, limit = 60): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: number[] = [];
  const partial: number[] = [];
  // THE WHOLE LIST IS SCANNED, deliberately. An earlier version stopped once it had enough
  // candidates, which meant a query like "stone" filled up on `andesite_slab_from_..._
  // stonecutting` and returned before it ever reached `minecraft:stone` — the exact match
  // was ranked first among results that never included it. Only the PARTIALS are capped;
  // 12,488 string compares is nothing next to getting the top hit wrong.
  bundle.recipes.forEach((r, i) => {
    for (const o of r.outputs) {
      const id = o.id.toLowerCase();
      if (id === q || shortId(id) === q) { exact.push(i); return; }
      if (id.includes(q)) { if (partial.length < limit * 4) partial.push(i); return; }
    }
    if (r.id.toLowerCase().includes(q) && partial.length < limit * 4) partial.push(i);
  });
  return [...exact, ...partial].slice(0, limit);
}

/** A one-line summary of a recipe, used for the list and for tests. */
export function describeRecipe(r: Recipe): string {
  const outs = r.outputs.map((o) => `${o.count > 1 ? `${o.count}x ` : ''}${shortId(o.id)}`
    + (o.chance !== undefined && o.chance < 1 ? ` (${Math.round(o.chance * 100)}%)` : ''));
  const ins = r.inputs.map(ingredientLabel);
  return `${outs.join(', ') || '?'}  <=  ${ins.join(' + ') || '?'}  [${shortId(r.type)}]`;
}

export function ingredientLabel(i: RecipeIngredient): string {
  const amount = i.amount !== undefined && i.amount !== 1 ? `${i.amount} ` : '';
  if (i.kind === 'tag') return `${amount}#${shortId(i.id)}`;
  if (i.kind === 'fluid') return `${amount}${shortId(i.id)} (fluid)`;
  return `${amount}${shortId(i.id)}`;
}

export interface RecipeBookDeps {
  root: HTMLElement;
  getIcons: () => ItemIcons | null;
}

/**
 * The panel itself.
 *
 * Hidden until asked for, because it is a reference tool rather than something you watch.
 */
export class RecipeBook {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private list: HTMLDivElement;
  private note: HTMLDivElement;
  private bundle: RecipeBundleView | null = null;
  visible = false;

  constructor(private deps: RecipeBookDeps) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;top:44px;right:8px;width:420px;max-height:70vh;'
      + 'overflow:auto;z-index:19;background:rgba(16,16,18,0.94);color:#ddd;'
      + 'border:1px solid #555;border-radius:6px;padding:10px;'
      + 'font:12px system-ui,sans-serif;display:none;';

    const title = document.createElement('div');
    title.textContent = 'Recipes';
    title.style.cssText = 'font-weight:600;margin-bottom:6px;';

    this.input = document.createElement('input');
    this.input.placeholder = 'search an item, e.g. andesite alloy';
    this.input.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 7px;'
      + 'background:#111;color:#eee;border:1px solid #555;border-radius:4px;font:inherit;';
    this.input.addEventListener('input', () => this.render());
    // The world must not receive these keystrokes as movement.
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      this.input.addEventListener(ev, (e) => e.stopPropagation());
    }

    this.note = document.createElement('div');
    this.note.style.cssText = 'color:#888;margin:6px 0;';

    this.list = document.createElement('div');

    this.el.append(title, this.input, this.note, this.list);
    deps.root.appendChild(this.el);
  }

  setBundle(bundle: RecipeBundleView): void {
    this.bundle = bundle;
    this.render();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.input.focus();
  }

  get typing(): boolean {
    return this.visible && document.activeElement === this.input;
  }

  private render(): void {
    if (!this.bundle) {
      this.note.textContent = 'recipes not baked — run `npm run bake-assets`';
      return;
    }
    const s = this.bundle.stats;
    const q = this.input.value;
    const hits = searchRecipes(this.bundle, q);
    this.note.textContent = q
      ? `${hits.length} shown`
      : `${s.parsed} recipes, ${s.types} types`
        + (s.unreadable ? ` — ${s.unreadable} could not be read` : '')
        + '. Read-only: crafting needs container clicks the bridge cannot send.';
    this.list.replaceChildren(...hits.map((i) => this.row(this.bundle!.recipes[i])));
  }

  private row(r: Recipe): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 2px;'
      + 'border-top:1px solid #333;';
    const first = r.outputs[0];
    const icon = first ? this.deps.getIcons()?.get(first.id) ?? null : null;
    if (icon) {
      // COPY the icon rather than appending it. `ItemIcons.get` caches and returns one
      // canvas per item, so appending it here would MOVE it out of wherever else it is
      // already shown — the hotbar, another row — and that item would silently vanish from
      // there. It can also be an OffscreenCanvas, which has no style and cannot be a child.
      const cell = document.createElement('canvas');
      cell.width = icon.width;
      cell.height = icon.height;
      cell.style.cssText = 'width:28px;height:28px;image-rendering:pixelated;flex:0 0 auto;';
      cell.getContext('2d')?.drawImage(icon as CanvasImageSource, 0, 0);
      row.appendChild(cell);
    }
    const text = document.createElement('div');
    text.textContent = describeRecipe(r);
    text.style.cssText = 'flex:1 1 auto;line-height:1.35;';
    row.appendChild(text);
    return row;
  }
}
