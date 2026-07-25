import { API_BASE } from '@basics/core/client/base';
import { createMetaClient } from '../../shared/api/meta.gen';
import { createSitesClient } from '../../shared/api/sites.gen';
import { createCoursesClient } from '../../shared/api/courses.gen';
import { createHolesClient } from '../../shared/api/holes.gen';
import { createTeesClient } from '../../shared/api/tees.gen';
import { createGreensClient } from '../../shared/api/greens.gen';
import { createPinsClient } from '../../shared/api/pins.gen';
import { createAimPointsClient } from '../../shared/api/aim-points.gen';
import { createCourseFeaturesClient } from '../../shared/api/course-features.gen';
import { createClubsClient } from '../../shared/api/clubs.gen';
import { createGamePlansClient } from '../../shared/api/game-plans.gen';
import { createRoundsClient } from '../../shared/api/rounds.gen';
import { createAssetsClient } from '../../shared/api/assets.gen';
import { createMapBuildClient } from '../../shared/api/map-build.gen';
import { createOrthoPatchesClient } from '../../shared/api/ortho-patches.gen';
import { createHydroClient } from '../../shared/api/hydro.gen';
import { createOsmClient } from '../../shared/api/osm.gen';
import { createTerrainEditsClient } from '../../shared/api/terrain-edits.gen';

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
    greens: createGreensClient(API_BASE),
    pins: createPinsClient(API_BASE),
    aimPoints: createAimPointsClient(API_BASE),
    courseFeatures: createCourseFeaturesClient(API_BASE),
    clubs: createClubsClient(API_BASE),
    gamePlans: createGamePlansClient(API_BASE),
    rounds: createRoundsClient(API_BASE),
    assets: createAssetsClient(API_BASE),
    mapBuild: createMapBuildClient(API_BASE),
    orthoPatches: createOrthoPatchesClient(API_BASE),
    hydro: createHydroClient(API_BASE),
    osm: createOsmClient(API_BASE),
    terrainEdits: createTerrainEditsClient(API_BASE),
};
