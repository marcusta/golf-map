import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

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

export default defineConfig({
    plugins: [mobileSpaFallback()],
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
});
