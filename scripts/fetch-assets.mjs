/**
 * Downloads the vanilla client jar the same way the launcher does.
 *
 * Cached in .cache/ and NEVER redistributed — Mojang's EULA forbids shipping game files.
 * Block models and textures live in client.jar, NOT in the asset index (that holds
 * sounds and lang files), which is why we fetch the jar itself.
 *
 *   node scripts/fetch-assets.mjs [version]
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const version = process.argv[2] ?? '1.21.1';
mkdirSync('.cache', { recursive: true });
const out = `.cache/client-${version}.jar`;

if (existsSync(out)) {
  console.log(`${out} already present (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  process.exit(0);
}

const manifest = await (
  await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
).json();
const entry = manifest.versions.find((v) => v.id === version);
if (!entry) throw new Error(`version ${version} not found in Mojang's version manifest`);

const meta = await (await fetch(entry.url)).json();
const size = (meta.downloads.client.size / 1e6).toFixed(1);
console.log(`downloading ${version} client jar (${size} MB) ...`);

const buf = new Uint8Array(await (await fetch(meta.downloads.client.url)).arrayBuffer());
writeFileSync(out, buf);
writeFileSync(`.cache/${version}.json`, JSON.stringify(meta));
console.log(`wrote ${out}`);
