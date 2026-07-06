import { defineConfig } from 'vite';

// The API server the dev server proxies /api + /tiles to. Defaults to the
// standard dev port (3000); the E2E harness overrides it (API_PROXY_TARGET)
// so vite proxies to its own isolated, freshly-seeded API instance instead of
// whatever dev server happens to be running.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
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
