import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { MetaService } from './meta.service';
import { UserService } from './user.service';
import { SitesService } from './sites.service';
import { CoursesService } from './courses.service';
import { HolesService } from './holes.service';
import { TeesService } from './tees.service';
import { GreensService } from './greens.service';
import { PinsService } from './pins.service';
import { AimPointsService } from './aim-points.service';
import { CourseFeaturesService } from './course-features.service';
import { ClubsService } from './clubs.service';
import { GamePlansService } from './game-plans.service';
import { RoundsService } from './rounds.service';
import { AssetsService } from './assets.service';
import { AnalysisService } from './analysis.service';
import { GreenCalibrationService } from './green-calibration.service';
import { PuttEstimateService } from './putt-estimate.service';
import { MapBuildService } from './map-build.service';
import { HydroService } from './hydro.service';
import { OsmService } from './osm.service';
import { TerrainEditsService } from './terrain-edits.service';

export interface ServicesConfig {
    /** Root directory for course assets/tiles on disk. Defaults to DATA_DIR env var, then './data'. */
    dataDir?: string;
}

export function createServices(db: Kysely<Database>, config: ServicesConfig = {}) {
    const dataDir = config.dataDir ?? process.env.DATA_DIR ?? './data';

    const metaService = new MetaService();
    const userService = new UserService(db);
    const sitesService = new SitesService(db);
    const coursesService = new CoursesService(db);
    const holesService = new HolesService(db);
    const teesService = new TeesService(db);
    const greensService = new GreensService(db);
    const pinsService = new PinsService(db);
    const aimPointsService = new AimPointsService(db);
    const courseFeaturesService = new CourseFeaturesService(db);
    const clubsService = new ClubsService(db);
    const gamePlansService = new GamePlansService(db);
    const roundsService = new RoundsService(db);
    const assetsService = new AssetsService(db, dataDir);
    const analysisService = new AnalysisService(db, dataDir);
    const greenCalibrationService = new GreenCalibrationService(db, analysisService);
    const puttEstimateService = new PuttEstimateService(db);
    const mapBuildService = new MapBuildService({ db, assets: assetsService, dataDir });
    const hydroService = new HydroService({ courses: coursesService, assets: assetsService });
    const osmService = new OsmService({ courses: coursesService, assets: assetsService });
    const terrainEditsService = new TerrainEditsService(db);

    return {
        db,
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
        hydroService,
        osmService,
        terrainEditsService,
    };
}
