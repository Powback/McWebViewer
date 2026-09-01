/**
 * Reading the bot's state out of the server, in tiers.
 *
 * Everything here is a vanilla `data get`, so it works on any server and needs no mod —
 * only the *acting* half needs SiliconeDolls. There is no push channel, so the only
 * question is what to ask for and how often, and the answer is different per field:
 *
 *   FAST    Pos                       drives the camera; anything slower than ~10 Hz
 *                                     reads as lag no amount of smoothing hides
 *   VITALS  Health, food, XP, slot    changes at human speed; 2 Hz is invisible
 *   SLOW    Inventory                 expensive and rarely changes; on demand + 1/2 Hz
 *
 * RCON commands are serialised (see rcon.mjs), so these tiers share one pipe and the
 * command budget is the sum. Measured on the reference server: round trip is ~6.5 ms
 * median, ~50 ms p95 — one server tick, because commands are drained on the tick thread.
 * That 50 ms is a floor no polling rate can beat.
 */

import { looksTruncated, parseDataGet } from './snbt.mjs';

/** Vanilla player inventory: 0-8 hotbar, 9-35 main, 100-103 armour, -106 offhand. */
export const HOTBAR_SLOTS = 9;
export const MAIN_SLOTS = 36;

const VITALS = [
  ['health', 'Health'],
  ['food', 'foodLevel'],
  ['xpLevel', 'XpLevel'],
  ['xpProgress', 'XpP'],
  ['selectedSlot', 'SelectedItemSlot'],
  ['deathTime', 'DeathTime'],
];

/** `data get entity <name> <path>`, parsed, or null. */
async function get(run, name, path) {
  try {
    return parseDataGet(await run(`data get entity ${name} ${path}`));
  } catch {
    return null;
  }
}

/** Position only. The one read that happens at camera rate. */
export async function readPos(run, name) {
  const pos = await get(run, name, 'Pos');
  return Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite) ? pos : null;
}

export async function readRotation(run, name) {
  const rot = await get(run, name, 'Rotation');
  return Array.isArray(rot) && rot.length === 2 && rot.every(Number.isFinite)
    ? { yaw: rot[0], pitch: rot[1] }
    : null;
}

/**
 * Health, hunger, XP and the selected slot.
 *
 * Six separate reads rather than one `data get entity <name>`: the whole player NBT is
 * far past RCON's 4096-byte cap on this modpack (measured — it comes back cut off at
 * exactly 4096), so the single-read version is not merely wasteful, it is wrong.
 */
export async function readVitals(run, name) {
  const out = {};
  for (const [key, path] of VITALS) {
    const v = await get(run, name, path);
    out[key] = typeof v === 'number' ? v : null;
  }
  // A player with 0 health that has not yet respawned is dead; DeathTime counts up from
  // the moment they die, so either signal alone has a window where it reads wrong.
  out.dead = out.health !== null && out.health <= 0;
  return out;
}

function normaliseStack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slot = typeof raw.Slot === 'number' ? raw.Slot : null;
  if (slot === null || typeof raw.id !== 'string') return null;
  return { slot, id: raw.id, count: typeof raw.count === 'number' ? raw.count : 1 };
}

/**
 * The whole inventory, with a fallback that exists because of a real limit.
 *
 * One `data get … Inventory` is a single command and covers almost every case. But a
 * full inventory of modded items carries component trees, and vanilla RCON TRUNCATES a
 * reply at 4096 bytes rather than splitting it across packets — so on a full inventory
 * the reply is invalid SNBT. When that happens the read falls back to one command per
 * slot using an NBT path filter (`Inventory[{Slot:0b}]`), which is 36 commands but always
 * correct.
 *
 * The alternative — parsing whatever survived truncation — would render a partial
 * inventory as if it were complete, which is indistinguishable from items vanishing.
 */
export async function readInventory(run, name, { slots = MAIN_SLOTS } = {}) {
  let reply;
  try {
    reply = await run(`data get entity ${name} Inventory`);
  } catch {
    return { stacks: [], truncated: false, failed: true };
  }
  if (!looksTruncated(reply)) {
    const parsed = parseDataGet(reply);
    if (Array.isArray(parsed)) {
      return { stacks: parsed.map(normaliseStack).filter(Boolean), truncated: false };
    }
  }
  return { ...(await readInventoryPerSlot(run, name, slots)), truncated: true };
}

async function readInventoryPerSlot(run, name, slots) {
  const stacks = [];
  for (let slot = 0; slot < slots; slot++) {
    const raw = await get(run, name, `Inventory[{Slot:${slot}b}]`);
    const stack = normaliseStack(raw);
    if (stack) stacks.push(stack);
  }
  return { stacks };
}

/**
 * A block's NBT — how container contents are read.
 *
 * There is no "open the chest and tell me what is in it" command, and a fake player
 * opening a container does not expose its contents over RCON. But a chest IS its block
 * entity, so reading the block is both simpler and more truthful than trying to scrape a
 * GUI that has no representation here.
 */
export async function readBlock(run, x, y, z) {
  try {
    const data = parseDataGet(await run(`data get block ${x} ${y} ${z}`));
    if (!data || typeof data !== 'object') return null;
    const items = Array.isArray(data.Items) ? data.Items.map(normaliseStack).filter(Boolean) : null;
    return { id: typeof data.id === 'string' ? data.id : null, items, pos: [x, y, z] };
  } catch {
    return null;
  }
}
