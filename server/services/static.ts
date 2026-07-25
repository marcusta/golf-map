/**
 * Serve-mode static hosting for the built web app (T63, §10).
 *
 * On the VPS the recommendation is still Caddy in front (TLS, HTTP/2, a real
 * static file server — see docs/reference/vps-serve-runbook.md), but the box
 * must also work with nothing in front of it: `SERVER_MODE=serve bun main.ts`
 * behind a plain port forward should render the app. That is what this is.
 *
 * The web build (`web/dist`) has TWO html entries:
 *   index.html   — the desktop app, owning pushState routes like /course/<id>
 *   mobile.html  — the mobile companion, owning pushState routes under /m/*
 *
 * Both need an SPA fallback, and they need different ones, which is why this
 * cannot be a stock static handler. `vite dev` has the same split as a dev-only
 * middleware (web/vite.config.ts `mobileSpaFallback`); this is its production
 * counterpart, and the two must agree.
 *
 * Mount it LAST, after /api and /tiles, so a real route always wins over the
 * fallback.
 */
import { Hono } from 'hono';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8',
};

/** Vite emits content-hashed filenames under this prefix — safe to pin forever. */
const HASHED_ASSET_DIR = '/assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * The html entries are NOT hashed and point at the hashed bundles, so a stale
 * cached document is a stale app. Revalidate every time.
 */
const NO_CACHE = 'no-cache';

export const DESKTOP_ENTRY = 'index.html';
export const MOBILE_ENTRY = 'mobile.html';

/**
 * Prefixes the SPA fallback must never answer. Mounting last is not enough:
 * an *unmounted* API path (a builder-only route on the VPS) would otherwise
 * fall through and render the desktop app with HTTP 200, so a client would
 * see the app shell where it expected JSON — the worst kind of 404.
 */
const RESERVED_PREFIXES = ['/api/', '/api', '/tiles/', '/tiles'];

function isReserved(pathname: string): boolean {
    return RESERVED_PREFIXES.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p));
}

/** True for `/m` and `/m/...` — the mobile companion's pushState namespace. */
export function isMobileRoute(pathname: string): boolean {
    return pathname === '/m' || pathname.startsWith('/m/');
}

/**
 * Whether a request is a document navigation that an SPA fallback should
 * answer. A missing `.js` or `.png` must 404, not silently return HTML —
 * returning the index for a failed module request turns a deploy mistake into
 * a baffling syntax error in the console.
 */
function wantsHtmlDocument(accept: string, pathname: string): boolean {
    if (path.extname(pathname)) return false;
    return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

/**
 * Resolves a URL path to a file inside `distDir`, or null if it escapes the
 * root or does not exist. Percent-encoding is decoded first (a real path can
 * contain spaces), and the resolved path is re-checked against the root, so
 * `/../../etc/passwd` and its encoded variants cannot escape.
 */
export function resolveStaticFile(distDir: string, pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null; // malformed %-escape
    }
    if (decoded.includes('\0')) return null;

    const root = path.resolve(distDir);
    const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
    return candidate;
}

function cacheControlFor(pathname: string): string {
    return pathname.startsWith(HASHED_ASSET_DIR) ? IMMUTABLE : NO_CACHE;
}

function fileResponse(filePath: string, cacheControl: string): Response {
    const type = CONTENT_TYPE_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    return new Response(Bun.file(filePath), {
        headers: { 'Content-Type': type, 'Cache-Control': cacheControl },
    });
}

/**
 * Static + SPA routes for a built `web/dist`. Returns a Hono app to mount at
 * the root AFTER the API and tile routes.
 *
 * A missing or un-built `distDir` is not fatal: the API keeps serving and
 * document requests get a plain 503 explaining what to build. An operator who
 * forgot `bun run build` should see that, not a stack trace at boot.
 */
export function createStaticRoutes(distDir: string): Hono {
    const app = new Hono();
    const root = path.resolve(distDir);

    app.on(['GET', 'HEAD'], '/*', (c) => {
        const pathname = new URL(c.req.url).pathname;

        const file = resolveStaticFile(root, pathname);
        if (file) return fileResponse(file, cacheControlFor(pathname));

        const accept = c.req.header('accept') ?? '';
        if (isReserved(pathname) || !wantsHtmlDocument(accept, pathname)) return c.notFound();

        // SPA fallback: /m/* belongs to the mobile entry, everything else to
        // the desktop entry. Each keeps its own address bar path, so the
        // client Router reads the right route on boot.
        const entry = path.join(root, isMobileRoute(pathname) ? MOBILE_ENTRY : DESKTOP_ENTRY);
        if (!existsSync(entry)) {
            return c.text(`Web app not built: ${entry} is missing. Run \`bun run build\` in web/.`, 503);
        }
        return fileResponse(entry, NO_CACHE);
    });

    return app;
}
