/**
 * Which pipeline the live world comes from.
 *
 * There are now two, and they are genuinely different architectures rather than two
 * settings of one:
 *
 *   bridge     the original. An RCON bridge polls players/turtles and asks the server to
 *              `save-all flush`; the browser then re-reads the Anvil region files over HTTP
 *              Range requests. No accounts, no protocol client — and entities move only as
 *              often as the server writes them to disk (≥2 s, backing off to 120 s under
 *              load). PARITY-AUDIT.md §4 calls that out as the reason mobs look frozen.
 *
 *   spacetime  ../mcspacetime runs a headless Minecraft 1.21.1 protocol client that joins
 *              as a real player — full NeoForge handshake, no server-side mod — and mirrors
 *              what it sees into SpacetimeDB as live rows. Entities arrive at PACKET rate.
 *
 * **`bridge` stays the default and is untouched.** The spacetime path is additive: it
 * replaces where entity samples come FROM, not the renderer that draws them, so everything
 * downstream (interpolation, meshes, name tags, item icons) is the same code in both modes.
 *
 * SWITCHABLE WITHOUT A REBUILD. Three layers, first match wins:
 *
 *   1. `?source=spacetime` on the URL — for trying it on one tab without touching anything
 *   2. `/dev/source.json`, written by the container entrypoint from env — the deployed
 *      setting, exactly the pattern `/dev/manifest.json` already uses
 *   3. the built-in default, `bridge`
 *
 * ONE THING THAT DOES NOT MOVE: monitor text. A ComputerCraft terminal's contents are not
 * on the Minecraft wire at all — the protocol client cannot see them any more than the
 * bridge can — so `screen.json` stays the source for monitor panels in BOTH modes. Said
 * here because "we have a live protocol client now" is exactly the moment someone would
 * assume otherwise.
 */

export type WorldSourceKind = 'bridge' | 'spacetime';

export interface WorldSourceConfig {
  kind: WorldSourceKind;
  /** SpacetimeDB base URL, e.g. `http://mcspacetime.pow` */
  stdbUri: string;
  /** module/database name */
  database: string;
  /** where the setting came from, for the HUD — a silent default is how a toggle confuses people */
  origin: 'url' | 'config' | 'default';
}

export const DEFAULT_SOURCE: WorldSourceConfig = {
  kind: 'bridge',
  stdbUri: 'http://mcspacetime.pow',
  database: 'mcspacetime',
  origin: 'default',
};

/** Only the two known values are honoured; anything else is ignored rather than guessed. */
export function parseKind(v: unknown): WorldSourceKind | null {
  return v === 'bridge' || v === 'spacetime' ? v : null;
}

/**
 * Fold the URL query and the served config into a decision.
 *
 * Pure, so the precedence is testable without a browser or a server.
 */
export function resolveSource(
  search: string,
  served: unknown,
  base: WorldSourceConfig = DEFAULT_SOURCE,
): WorldSourceConfig {
  const cfg = (served && typeof served === 'object' ? served : {}) as Record<string, unknown>;
  const out: WorldSourceConfig = {
    ...base,
    stdbUri: typeof cfg.stdbUri === 'string' && cfg.stdbUri ? cfg.stdbUri : base.stdbUri,
    database: typeof cfg.database === 'string' && cfg.database ? cfg.database : base.database,
  };
  const fromConfig = parseKind(cfg.source);
  if (fromConfig) {
    out.kind = fromConfig;
    out.origin = 'config';
  }
  // The URL wins, so one tab can try the new path without changing the deployment.
  const fromUrl = parseKind(new URLSearchParams(search).get('source'));
  if (fromUrl) {
    out.kind = fromUrl;
    out.origin = 'url';
  }
  return out;
}

/**
 * Read the served config, then resolve.
 *
 * A missing or unreadable `/dev/source.json` is normal — it only exists in the container —
 * and falls through to the URL and the default rather than failing the page.
 */
export async function loadSource(
  search: string = typeof location === 'undefined' ? '' : location.search,
  url = '/dev/source.json',
): Promise<WorldSourceConfig> {
  let served: unknown = null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) served = await res.json();
  } catch {
    served = null;
  }
  return resolveSource(search, served);
}

export function describeSource(c: WorldSourceConfig): string {
  if (c.kind === 'bridge') return `source: bridge (save files + RCON)${c.origin === 'default' ? '' : ` [${c.origin}]`}`;
  return `source: spacetime (${c.database} @ ${c.stdbUri}) [${c.origin}]`;
}
