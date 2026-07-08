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

export { ApiError } from '@basics/core/client/api-error';

export const api = {
    meta: createMetaClient('/api'),
    sites: createSitesClient('/api'),
    courses: createCoursesClient('/api'),
    holes: createHolesClient('/api'),
    tees: createTeesClient('/api'),
    greens: createGreensClient('/api'),
    pins: createPinsClient('/api'),
    aimPoints: createAimPointsClient('/api'),
    courseFeatures: createCourseFeaturesClient('/api'),
    clubs: createClubsClient('/api'),
    gamePlans: createGamePlansClient('/api'),
    rounds: createRoundsClient('/api'),
    assets: createAssetsClient('/api'),
    mapBuild: createMapBuildClient('/api'),
};
