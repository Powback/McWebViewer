/**
 * Resolve block tags from the pack stack.
 *
 * Needed because a tool's mining rules name a TAG — `minecraft:mineable/pickaxe` — and the
 * harness cannot resolve it: `Bootstrap.bootStrap()` builds the registries but never loads
 * datapack tags, so every tag HolderSet there is empty. Tags are data and ship in the jars,
 * so they are resolved here instead, which also means a modded tool's tag works for free.
 *
 * TAGS MERGE, THEY DO NOT OVERRIDE. Minecraft concatenates every pack's copy of a tag —
 * that is how a mod adds its stone to `mineable/pickaxe` without shipping vanilla's list —
 * so this walks EVERY pack rather than asking the stack for the winning file. Using
 * `PackStack.get` here would silently drop every mod's additions and leave modded blocks
 * looking like they need no tool.
 *
 * `replace: true` is honoured: a pack that sets it is deliberately discarding what came
 * before, and ignoring that would merge two lists the author meant to be one.
 */

import { BLOCK_TAG_PATH, PackStack, type Pack } from '../assets/pack.js';

/** Tag id (`minecraft:mineable/pickaxe`) -> the block ids in it, fully expanded. */
export type TagIndex = Record<string, string[]>;

const decoder = new TextDecoder();

/** `data/minecraft/tags/block/mineable/pickaxe.json` -> `minecraft:mineable/pickaxe`. */
export function tagIdFromPath(path: string): string | null {
  const m = /^data\/([^/]+)\/tags\/block\/(.+)\.json$/.exec(path);
  return m ? `${m[1]}:${m[2]}` : null;
}

interface RawTag { values: string[]; replace: boolean }

/** Read every pack's copy of every block tag, in stack order. */
function collect(pack: Pack): Map<string, RawTag[]> {
  const packs = pack instanceof PackStack ? pack.packs : [pack];
  const out = new Map<string, RawTag[]>();
  for (const p of packs) {
    for (const path of p.list('data/')) {
      if (!BLOCK_TAG_PATH.test(path) || !path.endsWith('.json')) continue;
      const id = tagIdFromPath(path);
      const parsed = id ? readTagFile(p, path) : null;
      if (!id || !parsed) continue;
      (out.get(id) ?? out.set(id, []).get(id)!).push(parsed);
    }
  }
  return out;
}

/** One tag file, or null when it is missing or not JSON. */
function readTagFile(p: Pack, path: string): RawTag | null {
  const bytes = p.get(path);
  if (!bytes) return null;
  try {
    const o = JSON.parse(decoder.decode(bytes)) as { values?: unknown; replace?: unknown };
    const values = Array.isArray(o.values)
      ? o.values.map(entryId).filter((v): v is string => !!v)
      : [];
    return { values, replace: o.replace === true };
  } catch {
    return null;
  }
}

/** An entry is `"ns:id"`, `"#ns:tag"`, or `{ id, required }`. */
function entryId(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

/**
 * Expand every tag to the block ids it contains.
 *
 * `#other:tag` references are followed, with a visited set — a cycle in the data must not
 * hang the bake, and tag cycles do occur in the wild.
 */
export function bakeTags(pack: Pack): TagIndex {
  const raw = collect(pack);
  const done: TagIndex = {};

  const expand = (id: string, seen: Set<string>): string[] => {
    if (done[id]) return done[id];
    if (seen.has(id)) return [];
    seen.add(id);
    const parts = raw.get(id) ?? [];
    const out = new Set<string>();
    for (const part of parts) {
      // A `replace` layer discards everything beneath it, as the format says.
      if (part.replace) out.clear();
      for (const v of part.values) {
        if (v.startsWith('#')) for (const sub of expand(v.slice(1), seen)) out.add(sub);
        else out.add(v);
      }
    }
    seen.delete(id);
    const list = [...out];
    done[id] = list;
    return list;
  };

  for (const id of raw.keys()) expand(id, new Set());
  return done;
}
