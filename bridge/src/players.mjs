/**
 * Parsing the console output of the three read-only commands the observer uses.
 *
 * There is no protocol here — RCON hands back the same text a human would see in the
 * server console, so the "protocol" is a set of message formats that vary between
 * versions and mods. Every parser below therefore fails to `null`/`[]` rather than
 * throwing or guessing: a viewer that draws no player is a bug, a viewer that draws a
 * player at NaN is a crash.
 *
 * Formats, as emitted by vanilla 1.21.1 (NeoForge does not change them):
 *
 *   list             There are 2 of a max of 20 players online: Alice, Bob
 *   data get … Pos       Alice has the following entity data: [12.5d, 64.0d, -3.2d]
 *   data get … Rotation  Alice has the following entity data: [90.0f, 0.5f]
 *   data get … Dimension Alice has the following entity data: "minecraft:overworld"
 *
 * and, when the player left between the `list` and the `data get`:
 *
 *   No entity was found
 */

/**
 * Minecraft usernames are 3..16 of [A-Za-z0-9_]. This is enforced rather than assumed,
 * because every name from `list` is interpolated into a subsequent command — a name is
 * attacker-controlled input on any server that lets strangers join, and an unvalidated
 * one is a command injection into a live server's console.
 */
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

/** `There are N of a max of M players online: a, b` -> ['a', 'b']. */
export function parsePlayerList(text) {
  if (typeof text !== 'string') return [];
  const colon = text.lastIndexOf(':');
  if (colon < 0) return [];
  return text
    .slice(colon + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => NAME_RE.test(s));
}

export function isValidPlayerName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** The `[...]` payload of a `data get`, or null if the command did not return one. */
function bracketed(text) {
  if (typeof text !== 'string') return null;
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  return open >= 0 && close > open ? text.slice(open + 1, close) : null;
}

/**
 * NBT list elements carry a type suffix (`12.5d`, `90.0f`, `3b`). parseFloat stops at the
 * suffix, which is exactly what we want, but it also happily parses '' as NaN — so each
 * element is checked rather than trusted.
 */
function numbers(payload, count) {
  const parts = payload.split(',').map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== count || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/** `[12.5d, 64.0d, -3.2d]` -> [12.5, 64, -3.2]. */
export function parsePos(text) {
  const payload = bracketed(text);
  return payload === null ? null : numbers(payload, 3);
}

/** `[90.0f, 0.5f]` -> { yaw: 90, pitch: 0.5 }, in DEGREES, as the game stores them. */
export function parseRotation(text) {
  const payload = bracketed(text);
  const n = payload === null ? null : numbers(payload, 2);
  return n ? { yaw: n[0], pitch: n[1] } : null;
}

/** `... entity data: "minecraft:overworld"` -> 'minecraft:overworld'. */
export function parseDimension(text) {
  if (typeof text !== 'string') return null;
  const m = /"([a-z0-9_.-]+:[a-z0-9_./-]+)"/.exec(text);
  return m ? m[1] : null;
}
