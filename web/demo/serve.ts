// Phase 2 demo server — serves web/demo/ statically on :5180 and proxies
// /tiles/* to the dev API server (:3000). Throwaway, no dependencies beyond
// Bun itself (see ROADMAP.md Phase 2 exit criteria).
//
// Why proxy instead of fetching :3000 directly from the browser: the shared
// `@basics/core` createApp() applies Hono's secureHeaders() globally, which
// sets `Cross-Origin-Resource-Policy: same-origin` on every response
// (including tiles) and runs *after* route handlers, so it can't be
// overridden per-route from server/services/tiles.ts. CORP (unlike CORS) is
// enforced independently by the browser and blocks cross-origin WebGL
// texture loads even with `Access-Control-Allow-Origin: *` present. Proxying
// through this same-origin server sidesteps the issue without touching
// shared framework code. See README/report for the full CORS/CORP finding.
import { join, extname } from 'node:path';

const ROOT = import.meta.dir;
const PORT = 5180;
const API_ORIGIN = 'http://localhost:3000';

const CONTENT_TYPE: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
};

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname.startsWith('/tiles/')) {
            return fetch(`${API_ORIGIN}${url.pathname}`);
        }

        const relPath = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = Bun.file(join(ROOT, relPath));
        if (!(await file.exists())) return new Response('Not found', { status: 404 });
        const type = CONTENT_TYPE[extname(relPath)] ?? 'application/octet-stream';
        return new Response(file, { headers: { 'Content-Type': type } });
    },
});

console.log(`Phase 2 demo: http://localhost:${PORT} (proxying /tiles/* to ${API_ORIGIN})`);
