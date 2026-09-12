/**
 * Fetch the vanilla sound files the world actually needs, and bake an index for them.
 *
 * WHY THIS EXISTS SEPARATELY FROM `fetch-assets.mjs`. Block models and textures live in
 * `client.jar`, which is why that script fetches the jar. Sounds do NOT: the jar contains
 * zero `.ogg` files and no `sounds.json` (checked, not assumed). They live in Mojang's
 * hashed asset index, which is a second download entirely.
 *
 * WHY NOT ALL OF THEM. The 1.21.1 index holds 3,727 `.ogg` files totalling **720 MB** —
 * music, ambience, mob calls, records. A viewer that plays block sounds needs a small
 * fraction of that, so this fetches only what is REFERENCED: the break / step / place / hit
 * / fall events named by the SoundTypes the harness extracted into `physics.json`, resolved
 * through `sounds.json` to their individual variant files.
 *
 * That keeps the download at a few megabytes and — more importantly — keeps it GENERIC:
 * the list comes from what the game says each block sounds like, not from a hand-written
 * set of sounds someone thought to include. Adding a mod whose blocks reuse vanilla
 * SoundTypes needs no change here at all.
 *
 * Like the client jar, these are cached under `.cache/` and NEVER redistributed — Mojang's
 * EULA forbids shipping game files.
 *
 *   node scripts/fetch-sounds.mjs [--physics public/physics.json] [--out .cache/sounds]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PHYSICS = flag('--physics', 'public/physics.json');
const OUT = flag('--out', '.cache/sounds');
const VERSION = flag('--version', '1.21.1');

mkdirSync(OUT, { recursive: true });

/** Mojang's per-object URL: first two hex characters of the hash, then the whole hash. */
const objectUrl = (hash) => `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function assetIndex() {
  const cached = join('.cache', `asset-index-${VERSION}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const versionFile = join('.cache', `${VERSION}.json`);
  if (!existsSync(versionFile)) {
    throw new Error(`missing ${versionFile} — run 'npm run fetch-assets' first`);
  }
  const meta = JSON.parse(readFileSync(versionFile, 'utf8'));
  const index = await getJson(meta.assetIndex.url);
  writeFileSync(cached, JSON.stringify(index));
  return index;
}

/** Every sound EVENT the extracted SoundTypes name. */
function eventsFromPhysics() {
  if (!existsSync(PHYSICS)) {
    throw new Error(`missing ${PHYSICS} — run harness/run.sh so the SoundTypes are extracted`);
  }
  const physics = JSON.parse(readFileSync(PHYSICS, 'utf8'));
  const events = new Set();
  for (const s of physics.sounds ?? []) {
    for (const k of ['breakSound', 'stepSound', 'placeSound', 'hitSound', 'fallSound']) {
      // Strip the namespace: `sounds.json` is keyed by the bare event path.
      if (s[k]) events.add(String(s[k]).replace(/^minecraft:/, ''));
    }
  }
  return events;
}

/**
 * An entry in `sounds.json` is either a bare path or an object.
 *
 * `type: "event"` means it POINTS AT ANOTHER EVENT rather than at a file — following it as
 * a filename downloads a 404 and leaves that sound silently missing, which is exactly the
 * kind of gap that is invisible until someone asks why stone is quiet.
 */
function variantsOf(entry, sounds, seen = new Set()) {
  const def = sounds[entry];
  if (!def || seen.has(entry)) return [];
  seen.add(entry);
  const out = [];
  for (const raw of def.sounds ?? []) {
    out.push(...oneVariant(raw, sounds, seen));
  }
  return out;
}

/** One `sounds` entry: a file, or a pointer at another event to splice in. */
function oneVariant(raw, sounds, seen) {
  const s = typeof raw === 'string' ? { name: raw } : raw;
  if (!s?.name) return [];
  if (s.type === 'event') return variantsOf(s.name.replace(/^minecraft:/, ''), sounds, seen);
  return [{
    name: s.name.replace(/^minecraft:/, ''),
    volume: s.volume ?? 1,
    pitch: s.pitch ?? 1,
    weight: s.weight ?? 1,
  }];
}

/** Every referenced event -> its files, plus the set of assets to download. */
function resolveAll(events, sounds, objects) {
  const manifest = {};
  const wanted = new Map();
  let missingEvents = 0;
  for (const event of [...events].sort()) {
    const variants = variantsOf(event, sounds);
    if (!variants.length) { missingEvents++; continue; }
    const kept = [];
    for (const v of variants) {
      const assetPath = `minecraft/sounds/${v.name}.ogg`;
      const meta = objects[assetPath];
      if (!meta) continue; // named by sounds.json but absent from the index
      wanted.set(assetPath, meta.hash);
      kept.push({ file: `${v.name}.ogg`, volume: v.volume, pitch: v.pitch, weight: v.weight });
    }
    if (kept.length) manifest[event] = kept;
  }
  return { manifest, wanted, missingEvents };
}

async function main() {
  console.log(`reading sound events from ${PHYSICS}`);
  const events = eventsFromPhysics();
  console.log(`  ${events.size} distinct sound events referenced by block SoundTypes`);

  const index = await assetIndex();
  const objects = index.objects;

  // sounds.json itself.
  const soundsMeta = objects['minecraft/sounds.json'];
  if (!soundsMeta) throw new Error('the asset index has no minecraft/sounds.json');
  const soundsPath = join(OUT, 'sounds.json');
  if (!existsSync(soundsPath)) {
    const res = await fetch(objectUrl(soundsMeta.hash));
    writeFileSync(soundsPath, Buffer.from(await res.arrayBuffer()));
  }
  const sounds = JSON.parse(readFileSync(soundsPath, 'utf8'));

  // Resolve events to files, and build the manifest the browser reads.
  const { manifest, wanted, missingEvents } = resolveAll(events, sounds, objects);
  console.log(`  ${Object.keys(manifest).length} events resolve to files`
    + `, ${missingEvents} named no file, ${wanted.size} distinct .ogg to fetch`);

  let fetched = 0;
  let bytes = 0;
  let already = 0;
  for (const [assetPath, hash] of wanted) {
    const rel = assetPath.replace(/^minecraft\/sounds\//, '');
    const dest = join(OUT, 'ogg', rel);
    if (existsSync(dest) && statSync(dest).size > 0) { already++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    const res = await fetch(objectUrl(hash));
    if (!res.ok) { console.warn(`  ! ${res.status} for ${assetPath}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    fetched++;
    bytes += buf.length;
    if (fetched % 50 === 0) console.log(`  ${fetched} fetched...`);
  }

  writeFileSync(join(OUT, 'index.json'), JSON.stringify({
    version: VERSION,
    generated: new Date().toISOString(),
    events: manifest,
  }));
  console.log(`fetched ${fetched} files (${(bytes / 1e6).toFixed(1)} MB)`
    + `, ${already} already present`);
  console.log(`wrote ${join(OUT, 'index.json')} with ${Object.keys(manifest).length} events`);
}

main().catch((e) => {
  console.error(`fetch-sounds failed: ${e.message}`);
  process.exit(1);
});
