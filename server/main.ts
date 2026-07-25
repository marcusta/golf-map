import * as path from 'node:path';
import type { Database } from './db/schema';
import { config } from '@basics/core/server/config';
import { createApp } from '@basics/core/server/app';
import { log } from '@basics/core/server/logger';
import { mount } from '@basics/core/server/mount';
import { createServices } from './services/index';
import { createMetaApi } from './api/meta.api';
import { createSitesApi } from './api/sites.api';
import { createCoursesApi } from './api/courses.api';
import { createHolesApi } from './api/holes.api';
import { createTeesApi } from './api/tees.api';
import { createGreensApi } from './api/greens.api';
import { createPinsApi } from './api/pins.api';
import { createAimPointsApi } from './api/aim-points.api';
import { createCourseFeaturesApi } from './api/course-features.api';
import { createClubsApi } from './api/clubs.api';
import { createGamePlansApi } from './api/game-plans.api';
import { createRoundsApi } from './api/rounds.api';
import { createAssetsApi } from './api/assets.api';
import { createAnalysisApi } from './api/analysis.api';
import { createGreenCalibrationApi } from './api/green-calibration.api';
import { createPuttEstimateApi } from './api/putt-estimate.api';
import { createMapBuildApi } from './api/map-build.api';
import { createOrthoPatchesApi } from './api/ortho-patches.api';
import { createHydroApi } from './api/hydro.api';
import { createOsmApi } from './api/osm.api';
import { createTerrainEditsApi } from './api/terrain-edits.api';
import { createTapscoreBridgeApi } from './api/tapscore-bridge.api';
import { createTileRoutes, cachingTileKeyLookup } from './services/tiles';

const { app, db, bootstrapAuth } = await createApp<Database>(path.join(import.meta.dir, 'db/migrations'));

const services = createServices(db);
const {
    metaService,
    userService,
    sitesService,
    coursesService,
    holesService,
    teesService,
    greensService,
    pinsService,
    aimPointsService,
    courseFeaturesService,
    clubsService,
    gamePlansService,
    roundsService,
    assetsService,
    analysisService,
    greenCalibrationService,
    puttEstimateService,
    mapBuildService,
    orthoPatchesService,
    hydroService,
    osmService,
    terrainEditsService,
    tapscoreBridgeService,
} = services;

// Clear any builds left `running` by a prior process (their in-memory runner
// died with the restart) so the UI doesn't poll a job that can't progress.
await mapBuildService.reconcileOrphans();

await bootstrapAuth({
    verify: (u, p) => userService.verify(u, p),
    findUser: (id) => userService.findById(id),
});

mount(app, '/api', createMetaApi(metaService));
mount(app, '/api', createSitesApi(sitesService));
mount(app, '/api', createCoursesApi(coursesService));
mount(app, '/api', createHolesApi(holesService));
mount(app, '/api', createTeesApi(teesService));
mount(app, '/api', createGreensApi(greensService));
mount(app, '/api', createPinsApi(pinsService));
mount(app, '/api', createAimPointsApi(aimPointsService));
mount(app, '/api', createCourseFeaturesApi(courseFeaturesService));
mount(app, '/api', createClubsApi(clubsService));
mount(app, '/api', createGamePlansApi(gamePlansService));
mount(app, '/api', createRoundsApi(roundsService));
mount(app, '/api', createAssetsApi(assetsService));
mount(app, '/api', createAnalysisApi(analysisService, courseFeaturesService));
mount(app, '/api', createGreenCalibrationApi(greenCalibrationService));
mount(app, '/api', createPuttEstimateApi(puttEstimateService));
mount(app, '/api', createMapBuildApi(mapBuildService));
mount(app, '/api', createOrthoPatchesApi(orthoPatchesService));
mount(app, '/api', createHydroApi(hydroService));
mount(app, '/api', createOsmApi(osmService));
mount(app, '/api', createTerrainEditsApi(terrainEditsService));
mount(app, '/api', createTapscoreBridgeApi(tapscoreBridgeService));

// Tile routes are deliberately unauthenticated (map clients fetch tiles
// directly without session cookies) — mounted at the root, not under /api.
// Tiles are stored under the SITE id (the site owns the map); the lookup
// resolves course-id URLs (iOS) to it, while site-id URLs (web) pass through.
app.route('/', createTileRoutes(assetsService, cachingTileKeyLookup(async (id) => {
    const course = await coursesService.get(id).catch(() => null);
    return course?.siteId ?? null;
})));

Bun.serve({ port: config.port, fetch: app.fetch });

log.info({ msg: 'server started', port: config.port });
