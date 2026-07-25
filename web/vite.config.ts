import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { applyManifestBase } from './scripts/manifest-base';

// The API server the dev server proxies /api + /tiles to. Defaults to the
// standard dev port (3000); the E2E harness overrides it (API_PROXY_TARGET)
// so vite proxies to its own isolated, freshly-seeded API instance instead of
// whatever dev server happens to be running.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3000';

/**
 * Dev-only SPA fallback for the mobile companion. The mobile app owns real
 * pushState routes under `/m/*` (see src/mobile/main.ts) so the eventual VPS
 * static server can map that prefix to mobile.html. In `vite dev` a document
 * request for `/m` or `/m/...` (a reload or a shared deep link) would otherwise
 * miss — vite only knows the entry at `/mobile.html`. This rewrites the HTML
 * navigation's server-side url to `/mobile.html` so the entry loads; the
 * browser's address bar keeps the `/m/...` path, so the client Router still
 * reads the correct route on boot. Asset/module requests (which carry an
 * extension or `?import`) are left untouched.
 */
function mobileSpaFallback(): Plugin {
    return {
        name: 'mobile-spa-fallback',
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                const url = req.url ?? '';
                const path = url.split('?')[0] ?? '';
                const isMobileRoute = path === '/m' || path.startsWith('/m/');
                const wantsHtml = (req.headers.accept ?? '').includes('text/html');
                if (isMobileRoute && wantsHtml) req.url = '/mobile.html';
                next();
            });
        },
    };
}

/**
 * Applies the deploy `base` to the PWA manifest's root-absolute URLs.
 *
 * Vite rewrites `href`/`src` attributes in the html entries for `base`, but the
 * manifest is a public/ file copied byte for byte — its `scope`/`start_url`/
 * icon paths would still point at the origin root. `closeBundle` runs after the
 * public dir has been copied into outDir, so the emitted copy is patched in
 * place (the committed source file is never touched). See scripts/manifest-base.ts
 * for why relative URLs are not the answer here.
 */
function baseAwareManifest(): Plugin {
    let outDir = 'dist';
    let base = '/';
    return {
        name: 'base-aware-manifest',
        apply: 'build',
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
            base = config.base;
        },
        closeBundle() {
            const file = resolve(outDir, 'm/manifest.webmanifest');
            if (!existsSync(file)) return;
            writeFileSync(file, applyManifestBase(readFileSync(file, 'utf8'), base));
        },
    };
}

export default defineConfig(({ command }) => ({
    // Served behind Caddy at https://app.swedenindoorgolf.se/golf-map/ in
    // production (Caddy `handle_path` strips the /golf-map prefix before
    // proxying, so the bun server still sees rooted paths — only the BROWSER
    // carries the prefix). `base` is what puts the prefix back on everything
    // the browser resolves: hashed asset URLs in both html entries, and
    // `import.meta.env.BASE_URL`, which @basics/core reads in client/base.ts to
    // derive BASE_PATH → the router's push/pop base and API_BASE.
    //
    // Keyed on vite's `command`, NOT `NODE_ENV === 'production'`: vite only
    // defaults NODE_ENV to production when it is UNSET, so an inherited
    // NODE_ENV (bun test exports `test`; some CI shells export `development`)
    // would silently build a root-based bundle that 404s on the VPS. `command`
    // is 'build' for every build and 'serve' for `vite dev`, so the e2e
    // harness and dev server stay at '/' by construction.
    //
    // A box that serves the app at the ORIGIN ROOT instead — the standalone
    // setup in docs/reference/vps-serve-runbook.md, with no path-routing proxy
    // in front — overrides it: `WEB_BASE=/ bun run build`.
    // See docs/reference/sig-infra-deploy.md.
    base: process.env.WEB_BASE ?? (command === 'build' ? '/golf-map/' : '/'),
    plugins: [mobileSpaFallback(), baseAwareManifest()],
    build: {
        rollupOptions: {
            // Two entries: the desktop builder (index.html) and the mobile
            // companion (mobile.html). Separate entries keep the editor bundle
            // out of the mobile graph (tree-shaking + the import-boundary test).
            input: {
                main: resolve(__dirname, 'index.html'),
                mobile: resolve(__dirname, 'mobile.html'),
            },
        },
    },
    server: {
        port: Number(process.env.PORT) || 5173,
        proxy: {
            '/api': {
                target: apiTarget,
                changeOrigin: true,
            },
            // Tiles proxied through the dev server so they are same-origin —
            // @basics/core secureHeaders sets Cross-Origin-Resource-Policy,
            // which would block cross-origin WebGL texture loads (see web/demo).
            '/tiles': {
                target: apiTarget,
                changeOrigin: true,
            },
        },
    },
}));
