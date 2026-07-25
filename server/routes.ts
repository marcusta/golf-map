import type { Hono } from 'hono';
import { mount } from '@basics/core/server/mount';
import type { ServerMode } from './mode';
import type { createServices } from './services/index';
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
import { createIngestRoutes } from './api/ingest.routes';

type Services = ReturnType<typeof createServices>;

/**
 * Mounts the `/api` routes per run mode (T59, §4). Runtime APIs mount in both
 * modes; builder-only APIs mount only in `builder` (they 404 on the VPS); the
 * ingest endpoint mounts only in `serve`. Extracted from `main.ts` so the mode
 * split is exercised by an integration test without booting a server.
 *
 * Tile routes and auth bootstrap stay in `main.ts` (they need the composition
 * root's cookie/session wiring); they are mode-independent.
 */
export function mountApiRoutes(app: Hono, services: Services, opts: { mode: ServerMode; dataDir: string }): void {
    const {
        metaService,
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
        ingestService,
    } = services;

    // --- Runtime APIs (both modes) ---
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
    // Runtime in both modes: rounds are linked/scored against the VPS (T60),
    // and the builder box needs it for local testing.
    mount(app, '/api', createTapscoreBridgeApi(tapscoreBridgeService));

    if (opts.mode === 'builder') {
        // --- Builder-only APIs (absent on the VPS — unmounted routes 404) ---
        mount(app, '/api', createMapBuildApi(mapBuildService));
        mount(app, '/api', createOrthoPatchesApi(orthoPatchesService));
        mount(app, '/api', createHydroApi(hydroService));
        mount(app, '/api', createOsmApi(osmService));
        mount(app, '/api', createTerrainEditsApi(terrainEditsService));
    } else {
        // --- Serve-only API: publish ingest (bearer-token, not cookie session) ---
        app.route('/api', createIngestRoutes(ingestService, opts.dataDir));
    }
}
