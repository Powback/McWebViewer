import { defineConfig, type Plugin } from 'vite';
import { readdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `bytes=0-8191` against a file of `size`, or null for absent/unsatisfiable headers. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number; size: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? { start, end, size } : null;
}

/**
 * Dev-only read-only mount of the reference world + mod jars.
 *
 * This exists so the renderer can be exercised without hand-dropping 128 jars on every
 * reload. It is strictly GET-only and refuses anything outside the two configured
 * directories — the reference world must never be written to.
 */
const REF = process.env.MCWV_REF ?? '/Users/macback/Projects/minecraft-create121/data';
const MODS = join(REF, 'mods');
const REGIONS = join(REF, 'world', 'region');
const ENTITIES = join(REF, 'world', 'entities');
const CLIENT_JAR = join(process.cwd(), '.cache', 'client-1.21.1.jar');

// Which regions to autoload. A full region is ~1024 chunks; two is plenty to prove
// cross-chunk culling works without waiting on a 130 MB fetch.
const AUTOLOAD_REGIONS = (process.env.MCWV_REGIONS ?? 'r.-1.0.mca').split(',');

function devMount(): Plugin {
  return {
    name: 'mcwv-dev-mount',
    configureServer(server) {
      // Baked assets, so `npm run dev` takes the same path production does rather than
      // silently falling back to fetching jars.
      server.middlewares.use('/baked', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return next();
        const path = join(process.cwd(), '.cache', 'baked', name);
        if (!existsSync(path)) return next();
        res.setHeader('content-type', name.endsWith('.png') ? 'image/png' : 'application/json');
        return createReadStream(path).pipe(res);
      });
      server.middlewares.use('/dev', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);

        if (url === '/manifest.json') {
          const jars = existsSync(MODS) ? readdirSync(MODS).filter((f) => f.endsWith('.jar')) : [];
          const body = JSON.stringify({
            jars: ['client-1.21.1.jar', ...jars],
            regions: AUTOLOAD_REGIONS,
            entityRegions: AUTOLOAD_REGIONS.filter((r) => existsSync(join(ENTITIES, r))),
          });
          res.setHeader('content-type', 'application/json');
          return res.end(body);
        }

        /**
         * Byte ranges are honoured because the live sync depends on them: it reads a
         * region file's 8 KB header, not its 12 MB body, to find out which chunks
         * changed. nginx does this for free in production; without it here, dev and
         * production would take measurably different code paths through the same
         * feature, which is exactly where a bug hides.
         */
        const send = (path: string) => {
          if (!existsSync(path)) { res.statusCode = 404; return res.end('not found'); }
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('accept-ranges', 'bytes');
          res.setHeader('cache-control', 'no-store');
          const range = parseRange(req.headers.range, statSync(path).size);
          if (!range) return createReadStream(path).pipe(res);
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${range.start}-${range.end}/${range.size}`);
          return createReadStream(path, { start: range.start, end: range.end }).pipe(res);
        };

        if (url.startsWith('/jar/')) {
          const name = url.slice(5);
          if (name.includes('/') || name.includes('..')) { res.statusCode = 400; return res.end(); }
          return send(name === 'client-1.21.1.jar' ? CLIENT_JAR : join(MODS, name));
        }
        if (url.startsWith('/shaderpack/')) {
          const name = url.slice(12);
          if (name.includes('/') || name.includes('..')) { res.statusCode = 400; return res.end(); }
          res.setHeader('content-type', 'application/json');
          return send(join(process.cwd(), '.cache', 'shaderpacks', name));
        }
        if (url.startsWith('/region/')) {
          const name = url.slice(8);
          if (name.includes('/') || name.includes('..')) { res.statusCode = 400; return res.end(); }
          return send(join(REGIONS, name));
        }
        if (url.startsWith('/entities/')) {
          const name = url.slice(10);
          if (name.includes('/') || name.includes('..')) { res.statusCode = 400; return res.end(); }
          return send(join(ENTITIES, name));
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [devMount()],
  server: {
    port: 5180,
    strictPort: true,
    // Same path production serves the bridge on, so `?live` needs no URL override in dev.
    // Point MCWV_BRIDGE_WS at the container if you are not running the bridge locally.
    proxy: {
      '/live': { target: process.env.MCWV_BRIDGE_WS ?? 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: { target: 'es2022' },
});
