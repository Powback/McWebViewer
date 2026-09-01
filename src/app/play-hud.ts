/**
 * The playing HUD: hotbar, health, hunger, XP, chat, inventory and containers.
 *
 * Built as DOM rather than drawn into the WebGL canvas. Everything here is text, boxes and
 * 32px icons — the things HTML is already good at — and keeping it out of the render loop
 * means the frame budget stays spent on the world.
 *
 * ONE RULE runs through all of it: **never draw a number the server did not give us.**
 * Every panel has a "not read yet" state that looks different from zero. A health bar
 * showing full because the poll has not landed is the same class of lie as controls that
 * accept input and do nothing, and this project has already fixed that once.
 */

import type { ItemIcons } from '../render/item-icons.js';

export interface Stack {
  slot: number;
  id: string;
  count: number;
}

export interface Vitals {
  health: number | null;
  food: number | null;
  xpLevel: number | null;
  xpProgress: number | null;
  selectedSlot: number | null;
  dead: boolean;
}

export interface ChatMessage {
  kind: string;
  from: string | null;
  text: string;
}

export interface ContainerView {
  id: string | null;
  items: Stack[] | null;
  pos: [number, number, number];
}

const HOTBAR_SLOTS = 9;
const MAX_CHAT_LINES = 60;
/** Vanilla: 20 health points = 10 hearts, 20 food points = 10 drumsticks. */
const MAX_HEALTH = 20;
const MAX_FOOD = 20;

/** `minecraft:diamond_sword` -> `Diamond Sword`, for slots with no baked icon. */
export function prettyItemName(id: string): string {
  const path = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return path.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface PlayHudDeps {
  root: HTMLElement;
  icons: () => ItemIcons | null;
  /** select a hotbar slot, 0-based */
  onSelectSlot: (slot: number) => void;
  onChat: (message: string) => void;
  /** the chat box took or released the keyboard; controls must not fight it */
  onTypingChange: (typing: boolean) => void;
}

export class PlayHud {
  private hotbarEl = el('div', 'mcwv-hotbar');
  private vitalsEl = el('div', 'mcwv-vitals');
  private chatEl = el('div', 'mcwv-chat');
  private chatLog = el('div', 'mcwv-chat-log');
  private chatInput = el('input', 'mcwv-chat-input');
  private panelEl = el('div', 'mcwv-panel');
  private deathEl = el('div', 'mcwv-death');
  private slots: HTMLElement[] = [];

  private stacks: Stack[] = [];
  private vitals: Vitals | null = null;
  private selected = 0;
  private panelMode: 'none' | 'inventory' | 'container' = 'none';
  private container: ContainerView | null = null;

  visible = false;

  constructor(private deps: PlayHudDeps) {
    this.build();
  }

  private build(): void {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = el('div', 'mcwv-slot');
      slot.addEventListener('click', () => this.deps.onSelectSlot(i));
      this.slots.push(slot);
      this.hotbarEl.appendChild(slot);
    }
    this.chatInput.type = 'text';
    this.chatInput.maxLength = 200;
    this.chatInput.placeholder = 'say something, Enter to send, Esc to cancel';
    this.chatEl.append(this.chatLog, this.chatInput);
    this.deathEl.hidden = true;
    this.panelEl.hidden = true;

    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        this.chatInput.value = '';
        this.closeChat();
        if (text) this.deps.onChat(text);
      } else if (e.key === 'Escape') {
        this.chatInput.value = '';
        this.closeChat();
      }
    });
    this.chatInput.addEventListener('blur', () => this.deps.onTypingChange(false));

    const root = this.deps.root;
    root.append(this.vitalsEl, this.hotbarEl, this.chatEl, this.panelEl, this.deathEl);
    this.setVisible(false);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    for (const node of [this.vitalsEl, this.hotbarEl, this.chatEl]) node.hidden = !on;
    if (!on) {
      this.panelEl.hidden = true;
      this.deathEl.hidden = true;
      this.panelMode = 'none';
    }
  }

  // -------------------------------------------------------------------------
  // Chat

  openChat(): void {
    if (!this.visible) return;
    this.chatInput.classList.add('open');
    this.chatInput.focus();
    this.deps.onTypingChange(true);
  }

  closeChat(): void {
    this.chatInput.classList.remove('open');
    this.chatInput.blur();
    this.deps.onTypingChange(false);
  }

  get typing(): boolean {
    return document.activeElement === this.chatInput;
  }

  addChat(msg: ChatMessage): void {
    const line = el('div', `mcwv-chat-line mcwv-chat-${msg.kind}`);
    line.textContent = msg.from ? `<${msg.from}> ${msg.text}` : msg.text;
    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > MAX_CHAT_LINES) {
      this.chatLog.removeChild(this.chatLog.firstChild!);
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // State in

  setInventory(stacks: Stack[]): void {
    this.stacks = stacks;
    this.renderHotbar();
    if (this.panelMode === 'inventory') this.renderPanel();
  }

  setVitals(v: Vitals): void {
    this.vitals = v;
    if (typeof v.selectedSlot === 'number') this.selected = v.selectedSlot;
    this.renderVitals();
    this.renderHotbar();
    this.deathEl.hidden = !v.dead;
    if (v.dead) {
      this.deathEl.textContent = 'You died. Press R to respawn.';
    }
  }

  setContainer(view: ContainerView | null): void {
    this.container = view;
    if (view) {
      this.panelMode = 'container';
      this.renderPanel();
    } else if (this.panelMode === 'container') {
      this.panelMode = 'none';
      this.panelEl.hidden = true;
    }
  }

  toggleInventory(): void {
    this.panelMode = this.panelMode === 'inventory' ? 'none' : 'inventory';
    if (this.panelMode === 'none') this.panelEl.hidden = true;
    else this.renderPanel();
  }

  get panelOpen(): boolean {
    return this.panelMode !== 'none';
  }

  closePanel(): void {
    this.panelMode = 'none';
    this.panelEl.hidden = true;
    this.container = null;
  }

  // -------------------------------------------------------------------------
  // Rendering

  private stackAt(slot: number): Stack | undefined {
    return this.stacks.find((s) => s.slot === slot);
  }

  private renderHotbar(): void {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      this.paintSlot(this.slots[i], this.stackAt(i));
      this.slots[i].classList.toggle('selected', i === this.selected);
    }
  }

  /** One slot: icon if the bake has one, otherwise the item's name so it is still legible. */
  private paintSlot(node: HTMLElement, stack: Stack | undefined): void {
    node.textContent = '';
    node.title = stack ? `${prettyItemName(stack.id)} (${stack.id})` : '';
    if (!stack) return;
    const icon = this.deps.icons()?.get(stack.id) ?? null;
    if (icon) {
      const img = el('canvas', 'mcwv-icon');
      img.width = icon.width;
      img.height = icon.height;
      img.getContext('2d')!.drawImage(icon as unknown as CanvasImageSource, 0, 0);
      node.appendChild(img);
    } else {
      node.appendChild(el('span', 'mcwv-noicon', prettyItemName(stack.id).slice(0, 8)));
    }
    if (stack.count > 1) node.appendChild(el('span', 'mcwv-count', String(stack.count)));
  }

  /**
   * Health, hunger and XP.
   *
   * `null` renders as `--`, not as zero. "The poll has not landed" and "you are on your
   * last half heart" must never look the same.
   */
  private renderVitals(): void {
    const v = this.vitals;
    this.vitalsEl.textContent = '';
    if (!v) {
      this.vitalsEl.appendChild(el('span', 'mcwv-stat', 'reading state...'));
      return;
    }
    this.vitalsEl.appendChild(bar('health', v.health, MAX_HEALTH, '#e2483c'));
    this.vitalsEl.appendChild(bar('food', v.food, MAX_FOOD, '#c08a3e'));
    const xp = v.xpLevel === null ? '--' : String(v.xpLevel);
    const lvl = el('span', 'mcwv-stat mcwv-xp', `XP ${xp}`);
    this.vitalsEl.appendChild(lvl);
  }

  private renderPanel(): void {
    this.panelEl.hidden = false;
    this.panelEl.textContent = '';
    if (this.panelMode === 'container') this.renderContainer();
    else this.renderInventoryPanel();
  }

  private renderInventoryPanel(): void {
    this.panelEl.appendChild(el('div', 'mcwv-panel-title', 'Inventory'));
    this.panelEl.appendChild(this.grid(this.stacks, 36));
    this.panelEl.appendChild(el(
      'div',
      'mcwv-panel-note',
      'Read-only: a command-driven player cannot move items between slots. '
        + 'Number keys 1-8 change the held slot; Q drops it.',
    ));
  }

  private renderContainer(): void {
    const c = this.container;
    const name = c?.id ? prettyItemName(c.id) : 'Container';
    this.panelEl.appendChild(el('div', 'mcwv-panel-title', `${name} at ${c?.pos.join(', ')}`));
    if (!c || c.items === null) {
      this.panelEl.appendChild(el(
        'div',
        'mcwv-panel-note',
        'That block holds no readable inventory.',
      ));
      return;
    }
    this.panelEl.appendChild(this.grid(c.items, 27));
    this.panelEl.appendChild(el('div', 'mcwv-panel-note', 'Read straight from the block.'));
  }

  private grid(stacks: Stack[], count: number): HTMLElement {
    const wrap = el('div', 'mcwv-grid');
    const bySlot = new Map(stacks.map((s) => [s.slot, s]));
    for (let i = 0; i < count; i++) {
      const node = el('div', 'mcwv-slot');
      this.paintSlot(node, bySlot.get(i));
      wrap.appendChild(node);
    }
    return wrap;
  }
}

/** A labelled bar that shows `--` when the value has not been read. */
function bar(label: string, value: number | null, max: number, colour: string): HTMLElement {
  const wrap = el('span', 'mcwv-stat');
  wrap.appendChild(el('span', 'mcwv-stat-label', label));
  const track = el('span', 'mcwv-bar');
  const fill = el('span', 'mcwv-bar-fill');
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  fill.style.width = `${(pct * 100).toFixed(1)}%`;
  fill.style.background = colour;
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el('span', 'mcwv-stat-num', value === null ? '--' : value.toFixed(0)));
  return wrap;
}
