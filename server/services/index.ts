import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { type ServerMode, serverMode } from '../mode';
import { MetaService } from './meta.service';
import { IngestService } from './ingest.service';
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
import { OrthoPatchesService } from './ortho-patches.service';
import { HydroService } from './hydro.service';
import { OsmService } from './osm.service';
import { TerrainEditsService } from './terrain-edits.service';
import { PublishService } from './publish.service';
import { TapscoreBridgeService } from './tapscore-bridge.service';
import { HttpTapscoreClient } from './tapscore-client';

export interface ServicesConfig {
    /** Root directory for course assets/tiles on disk. Defaults to DATA_DIR env var, then './data'. */
    dataDir?: string;
    /**
     * Origin of the Tapscore server the scoring bridge (T60) publishes to,
     * e.g. `http://localhost:3001`. Defaults to the TAPSCORE_BASE_URL env var,
     * then empty (bridge stays inert — unlinked rounds never call out).
     */
    tapscoreBaseUrl?: string;
    /** Server run mode. Defaults to the SERVER_MODE env (via `serverMode()`). */
    mode?: ServerMode;
}

export function createServices(db: Kysely<Database>, config: ServicesConfig = {}) {
    const dataDir = config.dataDir ?? process.env.DATA_DIR ?? './data';
    const tapscoreBaseUrl = config.tapscoreBaseUrl ?? process.env.TAPSCORE_BASE_URL ?? '';
    const mode = config.mode ?? serverMode();

    const metaService = new MetaService(mode);
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
    // The bridge is constructed before RoundsService so it can subscribe to the
    // shot-change hook; it depends only on db + the Tapscore client (no cycle).
    const tapscoreBridgeService = new TapscoreBridgeService(db, new HttpTapscoreClient(tapscoreBaseUrl));
    const roundsService = new RoundsService(db, (roundId, holeNumbers) =>
        tapscoreBridgeService.syncHoles(roundId, holeNumbers),
    );
    const assetsService = new AssetsService(db, dataDir);
    const analysisService = new AnalysisService(db, dataDir);
    const greenCalibrationService = new GreenCalibrationService(db, analysisService);
    const puttEstimateService = new PuttEstimateService(db);
    const mapBuildService = new MapBuildService({ db, assets: assetsService, dataDir });
    const orthoPatchesService = new OrthoPatchesService({ db, assets: assetsService, dataDir });
    const hydroService = new HydroService({ courses: coursesService, assets: assetsService });
    const osmService = new OsmService({ courses: coursesService, assets: assetsService });
    const terrainEditsService = new TerrainEditsService(db);
    const publishService = new PublishService({ db, dataDir });
    // Serve-mode ingest endpoint (§8); the service is cheap to construct in
    // either mode — only its API is mounted (serve only) by main.ts.
    const ingestService = new IngestService({ db, dataDir });

    return {
        db,
        mode,
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
        publishService,
        tapscoreBridgeService,
        ingestService,
    };
}
