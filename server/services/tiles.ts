import { Hono } from 'hono';
import { existsSync, statSync } from 'node:fs';
import type { AssetsService, TileLayer } from './assets.service';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

// Long, immutable cache — tiles are content-addressed by course/layer/z/x/y
// and never change in place; a new tile-generation run produces a new asset.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VALID_LAYERS = new Set<TileLayer>(['ortho', 'terrain']);

function parseTileCoordinate(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
}

/**
 * Builds a standalone Hono app exposing GET /tiles/:courseId/:layer/:z/:x/:y
 * (extension resolved server-side by layer — jpg for ortho, png for terrain).
 *
 * Deliberately unauthenticated: map clients (web MapLibre, iOS MapLibre
 * Native) fetch tiles directly from <img>/tile-layer requests that don't
 * carry session cookies/headers, and tile bytes for a course aren't
 * sensitive once that course exists — same posture as static asset hosting.
 * The integration agent should mount this ahead of/alongside authenticated
 * descriptor routes, not behind requireAuth().
 *
 * Usage from main.ts (composition root):
 *   import { createTileRoutes } from './services/tiles';
 *   app.route('/', createTileRoutes(assetsService));
 */
export function createTileRoutes(assetsService: AssetsService): Hono {
    const app = new Hono();

    app.get('/tiles/:courseId/:layer/:z/:x/:y', async (c) => {
        const { courseId, layer, z, x } = c.req.param();
        const yParam = c.req.param('y');

        if (!VALID_LAYERS.has(layer as TileLayer)) {
            return c.json({ error: 'Invalid layer' }, 400);
        }

        const yMatch = /^(\d+)\.(jpg|jpeg|png|webp)$/.exec(yParam);
        if (!yMatch) {
            return c.json({ error: 'Invalid tile coordinate' }, 400);
        }
        const y = Number(yMatch[1]);

        const zNum = parseTileCoordinate(z);
        const xNum = parseTileCoordinate(x);
        if (zNum === null || xNum === null) {
            return c.json({ error: 'Invalid tile coordinate' }, 400);
        }

        let filePath: string;
        try {
            filePath = assetsService.resolveTilePath(courseId, layer as TileLayer, zNum, xNum, y);
        } catch {
            return c.json({ error: 'Invalid tile request' }, 400);
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            return c.json({ error: 'Not found' }, 404);
        }

        const file = Bun.file(filePath);
        const ext = filePath.slice(filePath.lastIndexOf('.'));
        const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

        return new Response(file, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': CACHE_CONTROL,
            },
        });
    });

    return app;
}
