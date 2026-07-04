import * as path from 'node:path';
import type { Database } from './db/schema';
import { config } from '@basics/core/server/config';
import { createApp } from '@basics/core/server/app';
import { log } from '@basics/core/server/logger';
import { mount } from '@basics/core/server/mount';
import { createServices } from './services/index';
import { createMetaApi } from './api/meta.api';
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
import { createTileRoutes } from './services/tiles';

const { app, db, bootstrapAuth } = await createApp<Database>(path.join(import.meta.dir, 'db/migrations'));

const services = createServices(db);
const {
    metaService,
    userService,
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
} = services;

await bootstrapAuth({
    verify: (u, p) => userService.verify(u, p),
    findUser: (id) => userService.findById(id),
});

mount(app, '/api', createMetaApi(metaService));
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

// Tile routes are deliberately unauthenticated (map clients fetch tiles
// directly without session cookies) — mounted at the root, not under /api.
app.route('/', createTileRoutes(assetsService));

export default { port: config.port, fetch: app.fetch };

log.info({ msg: 'server started', port: config.port });
