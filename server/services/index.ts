import * as path from 'node:path';
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
import { TeeSetsService } from './tee-sets.service';
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
import { GsproExportService } from './gspro-export.service';
import { CleanedPhotoService } from './cleaned-photo.service';
import { CleanupAreasService } from './cleanup-areas.service';
import { PhotoCleanupService } from './photo-cleanup.service';
import { HydroService } from './hydro.service';
import { OsmService } from './osm.service';
import { TerrainEditsService } from './terrain-edits.service';
import { VegetationRulesService } from './vegetation-rules.service';
import { ZoneTypesService } from './zone-types.service';
import { TerrainGeneratorsService } from './terrain-generators.service';
import { PondEdgeService } from './pond-edge.service';
import { WaterStepsService } from './water-steps.service';
import { PhotoStemsService } from './photo-stems.service';
import { HoleAssignmentService } from './hole-assignment.service';
import { TeePlacementService } from './tee-placement.service';
import { ScorecardService } from './scorecard.service';
import { PublishService } from './publish.service';
import { TapscoreBridgeService } from './tapscore-bridge.service';
import { HttpTapscoreClient } from './tapscore-client';
import { PhotosService } from './photos.service';
import { ShapingService } from './shaping.service';
import { GsproSyncService } from './gspro-sync.service';
import { CourseCheckService } from './course-check.service';
import { MakeReadyService } from './make-ready.service';
import { CourseProgressService } from './course-progress.service';
import { PaintService } from './paint.service';

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
    /** Clock for the photos service (file arrival, ack, retention). Tests inject a fixed one. */
    now?: () => Date;
}

export function createServices(db: Kysely<Database>, config: ServicesConfig = {}) {
    // Absolute: the services hand paths under it to pipeline processes that
    // run in pipeline/, where a relative `./data/...` names nothing.
    const dataDir = path.resolve(config.dataDir ?? process.env.DATA_DIR ?? './data');
    const tapscoreBaseUrl = config.tapscoreBaseUrl ?? process.env.TAPSCORE_BASE_URL ?? '';
    const mode = config.mode ?? serverMode();

    const metaService = new MetaService(mode);
    const userService = new UserService(db);
    const sitesService = new SitesService(db);
    const coursesService = new CoursesService(db);
    const holesService = new HolesService(db);
    const teesService = new TeesService(db);
    const teeSetsService = new TeeSetsService(db);
    const greensService = new GreensService(db);
    const pinsService = new PinsService(db);
    const aimPointsService = new AimPointsService(db);
    const courseFeaturesService = new CourseFeaturesService(db);
    // Shapes in Others onto their holes from the furniture (Draw mode's "Assign to holes", `bun run holes:assign`).
    const holeAssignmentService = new HoleAssignmentService({ db, courseFeatures: courseFeaturesService });
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
    // The tees from the scorecard's lengths, and the scorecard itself (Furniture's "Scorecard" / "Place tees", `bun run scorecard`, `bun run tees:place`).
    const teePlacementService = new TeePlacementService({ db, analysis: analysisService });
    const scorecardService = new ScorecardService({ db, teeSets: teeSetsService, teePlacement: teePlacementService });
    const greenCalibrationService = new GreenCalibrationService(db, analysisService);
    const puttEstimateService = new PuttEstimateService(db);
    const mapBuildService = new MapBuildService({ db, assets: assetsService, dataDir });
    const cleanedPhotoService = new CleanedPhotoService({ db, assets: assetsService, courses: coursesService, dataDir });
    const hydroService = new HydroService({ courses: coursesService, assets: assetsService });
    const osmService = new OsmService({ courses: coursesService, assets: assetsService });
    const terrainEditsService = new TerrainEditsService(db);
    const zoneTypesService = new ZoneTypesService(db);
    // The planting rules for reading (Vegetation mode's Planting rules panel); builder-only API.
    const vegetationRulesService = new VegetationRulesService({ courses: coursesService, features: courseFeaturesService, zoneTypes: zoneTypesService });
    const gsproExportService = new GsproExportService({ db, courses: coursesService, assets: assetsService, dataDir, terrainEdits: terrainEditsService });
    // Blender shaping (recipe library, apply job → shaping worker → Unity refresh); builder-only API.
    const shapingService = new ShapingService({ courses: coursesService, exportSettings: gsproExportService, dataDir });
    // The GSPro status board: per-target staleness, and the Update job that runs a target's whole chain.
    const gsproSyncService = new GsproSyncService({
        db, courses: coursesService, exports: gsproExportService, shaping: shapingService,
        mapBuild: mapBuildService, terrainEdits: terrainEditsService, dataDir,
    });
    // Is the built course whole: the Unity scene and the shaped Blender course inside the boundary (the board's Check row, `bun run course:check`).
    const courseCheckService = new CourseCheckService({ db, courses: coursesService, exports: gsproExportService, shaping: shapingService });
    // Make ready: colliders near play in the Unity scene and the Arborist file, plus the course check (the board's Ready row, `bun run course:ready`).
    const makeReadyService = new MakeReadyService({ courses: coursesService, exports: gsproExportService, courseCheck: courseCheckService, dataDir });
    // How far each course has come on its way to GSPro, read from the board, Check, Ready and files (`bun run course:progress`).
    const courseProgressService = new CourseProgressService({
        db, courses: coursesService, exports: gsproExportService, sync: gsproSyncService,
        check: courseCheckService, ready: makeReadyService, dataDir,
    });
    // Vertex paint of the course meshes: paint.json rules and strokes, previewed in Unity, painted by Blender (`bun run paint`).
    const paintService = new PaintService({ courses: coursesService, exportSettings: gsproExportService, shaping: shapingService });
    const terrainGeneratorsService = new TerrainGeneratorsService({
        courses: coursesService, assets: assetsService, terrainEdits: terrainEditsService,
        courseFeatures: courseFeaturesService, dataDir,
    });
    // Pond edges from the lidar and the orthophoto (the terrain editor's "Fit edge to water", `bun run water:edge`).
    const pondEdgeService = new PondEdgeService({ db, courses: coursesService, courseFeatures: courseFeaturesService, dataDir });
    // Steps in a run of water on the lidar: ponds at their levels and the falls between them (the terrain editor's "Find falls", `bun run water:steps`).
    const waterStepsService = new WaterStepsService({ db, courses: coursesService, courseFeatures: courseFeaturesService, dataDir });
    // Young trees the lidar missed, from their shadows in the summer photo (the Vegetation mode's "Find trees in photo", `bun run trees:photo`).
    const photoStemsService = new PhotoStemsService({ courses: coursesService, courseFeatures: courseFeaturesService, assets: assetsService, dataDir });
    const publishService = new PublishService({ db, dataDir });
    // Serve-mode ingest endpoint (§8); the service is cheap to construct in
    // either mode — only its API is mounted (serve only) by main.ts.
    const ingestService = new IngestService({ db, dataDir });
    // Reference photos: phone routes in both modes, pull routes serve only.
    const photosService = new PhotosService({ db, dataDir, now: config.now });

    return {
        db,
        mode,
        metaService,
        userService,
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
        cleanedPhotoService,
        cleanupAreasService: new CleanupAreasService(db),
        // Hole-by-hole photo cleanup on a copy, accepted holes applied as one undo step (`bun run photo -- clean`).
        photoCleanupService: new PhotoCleanupService({ db, cleanedPhoto: cleanedPhotoService, dataDir }),
        hydroService,
        osmService,
        terrainEditsService,
        terrainGeneratorsService,
        pondEdgeService,
        waterStepsService,
        photoStemsService,
        holeAssignmentService,
        teePlacementService,
        scorecardService,
        gsproExportService,
        vegetationRulesService,
        shapingService,
        gsproSyncService,
        courseCheckService,
        makeReadyService,
        courseProgressService,
        paintService,
        publishService,
        tapscoreBridgeService,
        ingestService,
        photosService,
    };
}
