import * as path from 'node:path';
import type { Database } from './db/schema';
import { config } from '@basics/core/server/config';
import { createApp } from '@basics/core/server/app';
import { log } from '@basics/core/server/logger';
import { createServices } from './services/index';
import { mountApiRoutes } from './routes';
import { createTileRoutes, cachingTileKeyLookup } from './services/tiles';
import { serverMode } from './mode';

const { app, db, bootstrapAuth } = await createApp<Database>(path.join(import.meta.dir, 'db/migrations'));

const mode = serverMode();
const services = createServices(db, { mode });
const { userService, coursesService, assetsService, mapBuildService } = services;

const dataDir = process.env.DATA_DIR ?? './data';

// Builder-only boot work: clear any builds left `running` by a prior process
// (their in-memory runner died with the restart) so the UI doesn't poll a job
// that can't progress. Skipped in serve mode — a lean box has no map_build_jobs
// activity and never runs the pipeline.
if (mode === 'builder') {
    await mapBuildService.reconcileOrphans();
}

await bootstrapAuth({
    verify: (u, p) => userService.verify(u, p),
    findUser: (id) => userService.findById(id),
});

// API routes split by run mode (§4). Extracted to `routes.ts` so the split is
// integration-tested without booting a server.
mountApiRoutes(app, services, { mode, dataDir });

// Tile routes are deliberately unauthenticated (map clients fetch tiles
// directly without session cookies) — mounted at the root, not under /api.
// Tiles are stored under the SITE id (the site owns the map); the lookup
// resolves course-id URLs (iOS) to it, while site-id URLs (web) pass through.
app.route('/', createTileRoutes(assetsService, cachingTileKeyLookup(async (id) => {
    const course = await coursesService.get(id).catch(() => null);
    return course?.siteId ?? null;
})));

Bun.serve({ port: config.port, fetch: app.fetch });

log.info({ msg: 'server started', port: config.port, mode });
