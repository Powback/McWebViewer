/**
 * Proof that the spacetime source actually carries the world, run against the DEV REPLICA.
 *
 * The claim being tested is not "SpacetimeDB works" — it is that `../mcspacetime`'s protocol
 * client puts enough in the database, in the right shape, for this viewer to render from it
 * and to see edits live. So this connects the same way the browser does (the generated
 * bindings + the official SDK), and checks four things:
 *
 *   1. TERRAIN   chunk sections arrive, in the vanilla paletted-container layout, and their
 *                palette ids resolve through `block_state` to real block names.
 *   2. U64       `block_data` words survive as exact `bigint`. This matters more than it
 *                looks: the words are bit-packed and routinely exceed 2^53, so any path that
 *                puts them through a JavaScript `number` corrupts terrain SILENTLY. The SDK
 *                uses BSATN, which carries them exactly — this asserts it rather than
 *                trusting it.
 *   3. EDITS     a `setblock` issued while this is running arrives as a `block_change` row.
 *   4. ENTITIES  entity rows move, at a rate the flush-based path cannot reach.
 *
 * NEVER point this at the live server. The dev replica (`../mcspacetime/devserver`, offline
 * mode, port 25566) exists precisely so development needs neither a Microsoft account nor
 * the production world.
 *
 *   npx tsx src/tools/spacetime-proof.ts [--uri http://127.0.0.1:3200] [--db mcspacetime]
 *                                        [--seconds 25]
 */

import { DbConnection } from '../module_bindings/index.js';
import { unpackSection } from '../app/spacetime-terrain.js';

interface Opts { uri: string; db: string; seconds: number; verify: string }

function parseArgs(argv: string[]): Opts {
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return {
    uri: get('--uri', 'http://127.0.0.1:3200'),
    db: get('--db', 'mcspacetime'),
    seconds: Number(get('--seconds', '25')),
    // `--verify x,y,z`: decode that exact cell out of its section and name it. This is the
    // check that pins the cell ORDER as well as the bit unpacking — place a known block
    // there first and the answer must be that block.
    verify: get('--verify', ''),
  };
}

/** Resolve a block-state id to its name over the HTTP SQL endpoint. */
async function blockName(uri: string, db: string, id: number | bigint): Promise<string> {
  const res = await fetch(`${uri.replace(/\/$/, '')}/v1/database/${db}/sql`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: `SELECT name FROM block_state WHERE id = ${id}`,
  });
  if (!res.ok) return `<sql ${res.status}>`;
  const body = (await res.json()) as Array<{ rows?: unknown[][] }>;
  const row = body[0]?.rows?.[0];
  return typeof row?.[0] === 'string' ? row[0] : '<not found>';
}

function line(s: string): void {
  process.stdout.write(`${s}\n`);
}

/**
 * Decode one named cell and say what block is in it.
 *
 * The strongest check available without a second implementation: place a known block with
 * `setblock`, point this at the same coordinates, and the decoded state must be that block.
 * It exercises the chunk/section maths, the bit unpacking AND the cell order
 * `(y<<8)|(z<<4)|x` — the last of which no count-based check can ever catch.
 */
async function verifyCell(
  c: { db: Record<string, { iter(): Iterable<Record<string, unknown>> }> },
  opts: Opts,
): Promise<void> {
  if (!opts.verify) return;
  const [x, y, z] = opts.verify.split(',').map((n) => Number(n.trim()));
  if (![x, y, z].every(Number.isFinite)) {
    line(`\n--verify: could not read "${opts.verify}" as x,y,z`);
    return;
  }
  const cx = x >> 4, cz = z >> 4, sy = y >> 4;
  const index = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
  const sec = [...c.db.chunkSection.iter()].find(
    (s) => Number(s.cx) === cx && Number(s.cz) === cz && Number(s.sy) === sy);
  line(`\nVERIFY CELL (${x},${y},${z}) -> chunk(${cx},${cz}) sy=${sy} index=${index}`);
  if (!sec) {
    line('  that section is not loaded — is the bot near it?');
    return;
  }
  const { ids } = unpackSection({
    cx, cz, sy,
    blockBits: Number(sec.blockBits),
    blockPalette: sec.blockPalette as (number | bigint)[],
    blockData: sec.blockData as (number | bigint)[],
  });
  const id = ids[index];
  line(`  decoded state id ${id} = ${await blockName(opts.uri, opts.db, id)}`);
}

/** Checks 1 and 2: sections arrive in the vanilla layout, and their u64 words stay exact. */
async function reportTerrain(
  c: { db: Record<string, { iter(): Iterable<Record<string, unknown>> }> },
  opts: Opts,
): Promise<void> {
  const chunks = [...c.db.chunk.iter()];
  const sections = [...c.db.chunkSection.iter()];
  line(`\nTERRAIN: ${chunks.length} chunks, ${sections.length} sections`);

  const solid = sections
    .filter((s) => Number(s.nonAirCount) > 200 && Number(s.blockBits) > 0)
    .sort((a, b) => Number(b.nonAirCount) - Number(a.nonAirCount))[0];
  if (!solid) {
    line('  NO populated section found — is the bot running and in a loaded area?');
    return;
  }
  const palette = solid.blockPalette as (number | bigint)[];
  const data = solid.blockData as (number | bigint)[];
  line(`  section (${solid.cx},${solid.sy},${solid.cz})`
    + ` bits=${solid.blockBits} palette=${palette.length} words=${data.length}`
    + ` nonAir=${solid.nonAirCount}`);
  const names = await Promise.all(palette.slice(0, 6).map((id) => blockName(opts.uri, opts.db, id)));
  line(`  palette resolves to: ${names.join(', ')}`);

  const over = (w: number | bigint) => typeof w === 'bigint' && w > BigInt(Number.MAX_SAFE_INTEGER);
  const bigs = data.filter(over);
  line(`  U64 fidelity: ${bigs.length}/${data.length} words exceed 2^53;`
    + ` typeof word = ${typeof data[0]}`);
  const anyBig = bigs[0];
  if (anyBig === undefined) return;
  const exact = BigInt(anyBig as bigint);
  const throughNumber = BigInt(Math.trunc(Number(anyBig)));
  line(`    example ${exact}`);
  line(`    same value through a JS number: ${throughNumber}`
    + `  => ${exact === throughNumber ? 'no loss' : 'WOULD HAVE BEEN CORRUPTED'}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const ws = opts.uri.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
  line(`connecting to ${ws} / ${opts.db}`);

  const conn = await new Promise<never>((resolve, reject) => {
    DbConnection.builder()
      .withUri(ws)
      .withDatabaseName(opts.db)
      .onConnectError((_c: unknown, e: Error) => reject(e))
      .onConnect((c: unknown) => resolve(c as never))
      .build();
  });

  const c = conn as unknown as {
    db: Record<string, {
      onInsert(cb: (ctx: unknown, row: Record<string, unknown>) => void): void;
      onUpdate(cb: (ctx: unknown, o: Record<string, unknown>, r: Record<string, unknown>) => void): void;
      iter(): Iterable<Record<string, unknown>>;
    }>;
    subscriptionBuilder(): { onApplied(cb: () => void): { subscribe(q: string[]): unknown } };
    disconnect(): void;
  };

  const edits: string[] = [];
  let moves = 0;
  const movers = new Set<string>();

  c.db.blockChange.onInsert((_ctx, r) => {
    edits.push(`(${r.x},${r.y},${r.z}) -> state ${r.newStateId}`);
  });
  c.db.entity.onUpdate((_ctx, _o, r) => {
    moves++;
    movers.add(String(r.typeName));
  });

  await new Promise<void>((resolve) => {
    c.subscriptionBuilder().onApplied(() => resolve()).subscribe([
      'SELECT * FROM chunk',
      'SELECT * FROM chunk_section',
      'SELECT * FROM entity',
      'SELECT * FROM block_change',
    ]);
  });
  line('subscription applied');

  await reportTerrain(c, opts);
  await verifyCell(c, opts);

  // ---- 3 + 4: live edits and entity motion --------------------------------
  line(`\nwatching for ${opts.seconds}s — run a setblock on the DEV server now`);
  const before = edits.length;
  await new Promise((r) => setTimeout(r, opts.seconds * 1000));

  // Grouped by position, because this pack has a mod that rewrites ONE block about once a
  // second (an `aeronauticsdiscovery:pin` marker out at x=20481032). Printing the last few
  // raw rows shows only that, and buries the edit the operator just made — which is the
  // whole thing being demonstrated.
  const fresh = edits.slice(before);
  const byPos = new Map<string, number>();
  for (const e of fresh) byPos.set(e, (byPos.get(e) ?? 0) + 1);
  line(`\nLIVE EDITS: ${fresh.length} block_change rows across ${byPos.size} distinct positions`);
  for (const [pos, n] of [...byPos].sort((a, b) => a[1] - b[1])) {
    line(`  ${pos}${n > 1 ? `   (x${n} — a mod rewriting the same block)` : '   <= a one-off edit'}`);
  }
  line(`\nENTITY MOTION: ${moves} position updates in ${opts.seconds}s`
    + ` across ${movers.size} type(s): ${[...movers].join(', ') || '—'}`);
  line(`  the flush path would have managed at most ${Math.floor(opts.seconds / 2)}`
    + ' (2 s floor, and 5 s in the default config)');

  c.disconnect();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`spacetime-proof failed: ${(e as Error).message}\n`);
  process.exit(1);
});
