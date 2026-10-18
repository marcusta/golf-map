import { API_BASE } from '@basics/core/client/base';
import { createMetaClient } from '../../shared/api/meta.gen';
import { createSitesClient } from '../../shared/api/sites.gen';
import { createCoursesClient } from '../../shared/api/courses.gen';
import { createHolesClient } from '../../shared/api/holes.gen';
import { createTeesClient } from '../../shared/api/tees.gen';
import { createTeeSetsClient } from '../../shared/api/tee-sets.gen';
import { createGreensClient } from '../../shared/api/greens.gen';
import { createPinsClient } from '../../shared/api/pins.gen';
import { createAimPointsClient } from '../../shared/api/aim-points.gen';
import { createCourseFeaturesClient } from '../../shared/api/course-features.gen';
import { createClubsClient } from '../../shared/api/clubs.gen';
import { createGamePlansClient } from '../../shared/api/game-plans.gen';
import { createRoundsClient } from '../../shared/api/rounds.gen';
import { createAssetsClient } from '../../shared/api/assets.gen';
import { createMapBuildClient } from '../../shared/api/map-build.gen';
import { createCleanedPhotoClient } from '../../shared/api/cleaned-photo.gen';
import { createCleanupAreasClient } from '../../shared/api/cleanup-areas.gen';
import { createHydroClient } from '../../shared/api/hydro.gen';
import { createOsmClient } from '../../shared/api/osm.gen';
import { createTerrainEditsClient } from '../../shared/api/terrain-edits.gen';
import { createTerrainGeneratorsClient } from '../../shared/api/terrain-generators.gen';
import { createPondEdgeClient } from '../../shared/api/pond-edge.gen';
import { createWaterStepsClient } from '../../shared/api/water-steps.gen';
import { createPhotoStemsClient } from '../../shared/api/photo-stems.gen';
import { createPublishClient } from '../../shared/api/publish.gen';
import { createGsproExportClient } from '../../shared/api/gspro-export.gen';
import { createGsproSyncClient } from '../../shared/api/gspro-sync.gen';
import { createZoneTypesClient } from '../../shared/api/zone-types.gen';
import { createVegetationRulesClient } from '../../shared/api/vegetation-rules.gen';
import { createPhotosClient } from '../../shared/api/photos.gen';
import { createShapingClient } from '../../shared/api/shaping.gen';

export { ApiError } from '@basics/core/client/api-error';

/**
 * Base for every app API call. `API_BASE` is `BASE_PATH + '/api'`, where
 * BASE_PATH comes from vite's `import.meta.env.BASE_URL` — '' when served at
 * the root (dev, a bare VPS) and '/golf-map' behind the sig-infra Caddy path
 * route. A hardcoded '/api' would resolve against the origin root and hit a
 * different service on that shared, path-routed host. Re-exported here so app
 * code has one import for it. See docs/reference/sig-infra-deploy.md.
 */
export { API_BASE };

export const api = {
    meta: createMetaClient(API_BASE),
    sites: createSitesClient(API_BASE),
    courses: createCoursesClient(API_BASE),
    holes: createHolesClient(API_BASE),
    tees: createTeesClient(API_BASE),
    teeSets: createTeeSetsClient(API_BASE),
    greens: createGreensClient(API_BASE),
    pins: createPinsClient(API_BASE),
    aimPoints: createAimPointsClient(API_BASE),
    courseFeatures: createCourseFeaturesClient(API_BASE),
    clubs: createClubsClient(API_BASE),
    gamePlans: createGamePlansClient(API_BASE),
    rounds: createRoundsClient(API_BASE),
    assets: createAssetsClient(API_BASE),
    mapBuild: createMapBuildClient(API_BASE),
    cleanedPhoto: createCleanedPhotoClient(API_BASE),
    cleanupAreas: createCleanupAreasClient(API_BASE),
    hydro: createHydroClient(API_BASE),
    osm: createOsmClient(API_BASE),
    terrainEdits: createTerrainEditsClient(API_BASE),
    terrainGenerators: createTerrainGeneratorsClient(API_BASE),
    pondEdge: createPondEdgeClient(API_BASE),
    waterSteps: createWaterStepsClient(API_BASE),
    photoStems: createPhotoStemsClient(API_BASE),
    publish: createPublishClient(API_BASE),
    gsproExport: createGsproExportClient(API_BASE),
    gsproSync: createGsproSyncClient(API_BASE),
    zoneTypes: createZoneTypesClient(API_BASE),
    vegetationRules: createVegetationRulesClient(API_BASE),
    photos: createPhotosClient(API_BASE),
    shaping: createShapingClient(API_BASE),
};
