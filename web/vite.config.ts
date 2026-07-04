import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: Number(process.env.PORT) || 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            // Tiles proxied through the dev server so they are same-origin —
            // @basics/core secureHeaders sets Cross-Origin-Resource-Policy,
            // which would block cross-origin WebGL texture loads (see web/demo).
            '/tiles': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
});
