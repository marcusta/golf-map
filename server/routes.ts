import type { Hono } from 'hono';
import { mount } from '@basics/core/server/mount';
import type { ServerMode } from './mode';
import type { createServices } from './services/index';
import { createMetaApi } from './api/meta.api';
import { createSitesApi } from './api/sites.api';
import { createCoursesApi } from './api/courses.api';
import { createHolesApi } from './api/holes.api';
import { createTeesApi } from './api/tees.api';
import { createTeeSetsApi } from './api/tee-sets.api';
import { createGreensApi } from './api/greens.api';
import { createPinsApi } from './api/pins.api';
import { createAimPointsApi } from './api/aim-points.api';
import { createCourseFeaturesApi } from './api/course-features.api';
import { createZoneTypesApi } from './api/zone-types.api';
import { createClubsApi } from './api/clubs.api';
import { createGamePlansApi } from './api/game-plans.api';
import { createRoundsApi } from './api/rounds.api';
import { createAssetsApi } from './api/assets.api';
import { createAnalysisApi } from './api/analysis.api';
import { createGreenCalibrationApi } from './api/green-calibration.api';
import { createPuttEstimateApi } from './api/putt-estimate.api';
import { createMapBuildApi } from './api/map-build.api';
import { createCleanedPhotoApi } from './api/cleaned-photo.api';
import { createCleanupAreasApi } from './api/cleanup-areas.api';
import { createCleanedPhotoFileRoutes } from './api/cleaned-photo.routes';
import { createPhotoCleanupApi } from './api/photo-cleanup.api';
import { createPhotoCleanupFileRoutes } from './api/photo-cleanup.routes';
import { createHydroApi } from './api/hydro.api';
import { createOsmApi } from './api/osm.api';
import { createTerrainEditsApi } from './api/terrain-edits.api';
import { createTerrainGeneratorsApi } from './api/terrain-generators.api';
import { createVegetationRulesApi } from './api/vegetation-rules.api';
import { createPondEdgeApi } from './api/pond-edge.api';
import { createWaterStepsApi } from './api/water-steps.api';
import { createPhotoStemsApi } from './api/photo-stems.api';
import { createGsproExportApi } from './api/gspro-export.api';
import { createShapingApi } from './api/shaping.api';
import { createGsproSyncApi } from './api/gspro-sync.api';
import { createCourseCheckApi } from './api/course-check.api';
import { createMakeReadyApi } from './api/make-ready.api';
import { createPaintApi } from './api/paint.api';
import { createPublishApi } from './api/publish.api';
import { createTapscoreBridgeApi } from './api/tapscore-bridge.api';
import { createIngestRoutes } from './api/ingest.routes';
import { createGeneratedFeaturesRoutes } from './api/generated-features.routes';
import { createPhotosApi } from './api/photos.api';
import { createPhotoFileRoutes, createPhotoPullRoutes } from './api/photos.routes';

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
        teeSetsService,
        greensService,
        pinsService,
        aimPointsService,
        courseFeaturesService,
        zoneTypesService,
        clubsService,
        gamePlansService,
        roundsService,
        assetsService,
        analysisService,
        greenCalibrationService,
        puttEstimateService,
        mapBuildService,
        gsproExportService,
        shapingService,
        gsproSyncService,
        cleanedPhotoService,
        hydroService,
        osmService,
        terrainEditsService,
        terrainGeneratorsService,
        publishService,
        tapscoreBridgeService,
        ingestService,
        photosService,
    } = services;

    // --- Runtime APIs (both modes) ---
    mount(app, '/api', createMetaApi(metaService));
    mount(app, '/api', createSitesApi(sitesService));
    mount(app, '/api', createCoursesApi(coursesService));
    mount(app, '/api', createHolesApi(holesService));
    mount(app, '/api', createTeesApi(teesService));
    mount(app, '/api', createTeeSetsApi(teeSetsService));
    mount(app, '/api', createGreensApi(greensService));
    mount(app, '/api', createPinsApi(pinsService));
    mount(app, '/api', createAimPointsApi(aimPointsService));
    mount(app, '/api', createCourseFeaturesApi(courseFeaturesService));
    // Pipeline bulk-replace of generated features (hand-mounted Hono route:
    // it needs the `?source=` query on a PUT and 400s for bad bodies, which
    // `mount()` does not offer). Same cookie-session auth as feature create.
    app.route('/api', createGeneratedFeaturesRoutes(courseFeaturesService));
    // The course's vegetation zone-type legend: mounted in both modes, like
    // the features it belongs to — a `vegetation_zone` feature is meaningless
    // without the table its `zoneType` attribute names.
    mount(app, '/api', createZoneTypesApi(zoneTypesService));
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
    // Reference photos: the phone uploads in both modes (hand-mounted file
    // routes stream a raw body with a hash header, which `mount()` cannot).
    mount(app, '/api', createPhotosApi(photosService));
    app.route('/api', createPhotoFileRoutes(photosService));

    if (opts.mode === 'builder') {
        // --- Builder-only APIs (absent on the VPS — unmounted routes 404) ---
        mount(app, '/api', createMapBuildApi(mapBuildService));
        mount(app, '/api', createCleanedPhotoApi(cleanedPhotoService));
        mount(app, '/api', createCleanupAreasApi(services.cleanupAreasService));
        // Cleaned photo download + image upload (hand-mounted: a file
        // stream and a raw request body, which `mount()` cannot carry).
        app.route('/api', createCleanedPhotoFileRoutes(cleanedPhotoService));
        // Hole-by-hole photo cleanup + its review images (a raw PNG route).
        mount(app, '/api', createPhotoCleanupApi(services.photoCleanupService));
        app.route('/api', createPhotoCleanupFileRoutes(services.photoCleanupService));
        mount(app, '/api', createHydroApi(hydroService));
        mount(app, '/api', createOsmApi(osmService));
        mount(app, '/api', createTerrainEditsApi(terrainEditsService));
        mount(app, '/api', createTerrainGeneratorsApi(terrainGeneratorsService));
        mount(app, '/api', createPondEdgeApi(services.pondEdgeService));
        mount(app, '/api', createWaterStepsApi(services.waterStepsService));
        mount(app, '/api', createPhotoStemsApi(services.photoStemsService));
        mount(app, '/api', createGsproExportApi(gsproExportService));
        mount(app, '/api', createVegetationRulesApi(services.vegetationRulesService));
        mount(app, '/api', createShapingApi(shapingService));
        mount(app, '/api', createGsproSyncApi(gsproSyncService));
        mount(app, '/api', createCourseCheckApi(services.courseCheckService));
        mount(app, '/api', createMakeReadyApi(services.makeReadyService));
        mount(app, '/api', createPaintApi(services.paintService));
        mount(app, '/api', createPublishApi(publishService));
    } else {
        // --- Serve-only API: publish ingest (bearer-token, not cookie session) ---
        app.route('/api', createIngestRoutes(ingestService, opts.dataDir));
        // Builder photo pull (same bearer token as ingest).
        app.route('/api', createPhotoPullRoutes(photosService));
    }
}
