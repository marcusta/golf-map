import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import * as path from 'node:path';
import { mkdtemp, mkdir, copyFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Database, MapBuildJobsTable } from '../db/schema';
import type { AssetsService } from './assets.service';
import { TerrainEditsService, type TerrainEdit } from './terrain-edits.service';
import { sweref99tmToWgs84 } from './geo';
import { NotFoundError } from '@basics/core/server/auth';

// --- Public types ---

export type BuildStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type BuildStep =
    | 'fetch-lidar' | 'grid-dem' | 'apply-dem-edits' | 'fetch-ortho' | 'tile-ortho'
    | 'tile-terrain' | 'tile-hillshade' | 'manifest' | 'install' | 'register';

/** Job kind: the full pipeline, or the fast terrain-edit replay (T56). */
export type BuildJobKind = 'build' | 're-terrain';

/**
 * Ordered pipeline steps the runner walks through. Also drives the web
 * progress UI. Elevation comes from Laserdata Skog lidar (fetch-lidar →
 * grid-dem), NOT the Markhöjdmodell DTM grid (fetch-dem) — the account is
 * entitled to the laser + ortho products, not the DTM. apply-dem-edits
 * replays the site's enabled terrain_edits onto the DEM (T54/T56) and is
 * skipped when there are none.
 */
export const BUILD_STEPS: readonly BuildStep[] = [
    'fetch-lidar', 'grid-dem', 'apply-dem-edits', 'fetch-ortho', 'tile-ortho', 'tile-terrain', 'tile-hillshade', 'manifest', 'install', 'register',
];

/**
 * Ordered steps of the fast re-terrain job (`kind: 're-terrain'`): replay
 * terrain edits onto the persisted DEM and re-tile terrain + hillshade —
 * no lidar/ortho refetch. `install` runs before `manifest` because the
 * manifest is regenerated from the INSTALLED tile tree (see runReTerrain).
 */
export const RE_TERRAIN_STEPS: readonly BuildStep[] = [
    'apply-dem-edits', 'tile-terrain', 'tile-hillshade', 'install', 'manifest', 'register',
];

export interface Bbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** An orthophoto vintage (one flight) covering the course area. */
export interface OrthoVintage {
    collection: string; // e.g. 'orto-l2-2025'
    dates: string[]; // capture dates (YYYY-MM-DD)
}

/** The persisted lidar (.laz) tiles for a course's site — multi-use source assets. */
export interface LidarInfo {
    files: string[]; // .laz file names (no path), sorted
    totalBytes: number;
}

export interface MapBuildJob {
    id: string;
    courseId: string;
    siteId: string | null;
    kind: BuildJobKind;
    status: BuildStatus;
    step: BuildStep | null;
    bbox: Bbox;
    log: string;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

// --- Pipeline runner seam (the test injection point) ---

export interface PipelineRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Runs one `python -m golfpipe …` invocation. The default implementation
 * shells out via Bun.spawn; tests inject a stub so no Python is required.
 */
export type PipelineRunner = (
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
) => Promise<PipelineRunResult>;

function defaultRunner(python: string): PipelineRunner {
    return async (args, opts) => {
        const proc = Bun.spawn([python, ...args], {
            cwd: opts.cwd,
            env: opts.env,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { code, stdout, stderr };
    };
}

export interface MapBuildDeps {
    db: Kysely<Database>;
    assets: AssetsService;
    /** Where `install` copies tiles — must equal the server's data dir. */
    dataDir: string;
    /** golfpipe checkout dir; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to `<pipelineDir>/.venv/bin/python`. */
    python?: string;
    /** Injected in tests to avoid spawning Python. */
    runner?: PipelineRunner;
    /** Source of the site's terrain edits; defaults to a db-backed instance. */
    terrainEdits?: TerrainEditsService;
}

// The three asset kinds a build (re)writes for a course.
const BUILT_ASSET_KINDS = ['ortho_cog', 'dem_cog', 'tile_manifest'] as const;

/** Argv for one `python -m golfpipe <cmd> …` invocation. */
const gp = (...args: string[]): string[] => ['-m', 'golfpipe', ...args];

// --- Row mapping ---

type MapBuildJobRow = Selectable<MapBuildJobsTable>;

function toJob(row: MapBuildJobRow): MapBuildJob {
    return {
        id: row.id,
        courseId: row.course_id,
        siteId: row.site_id,
        kind: row.kind as BuildJobKind,
        status: row.status as BuildStatus,
        step: (row.step as BuildStep | null) ?? null,
        bbox: JSON.parse(row.bbox_json) as Bbox,
        log: row.log,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Orchestrates a server-driven golfpipe run: fetch DEM + orthophoto for a
 * WGS84 bbox from Lantmäteriet, tile them, install into the server data dir,
 * then register the tile assets so `hasTiles` flips true for the course.
 *
 * The build runs detached in-process; `start()` returns immediately and the
 * web client polls `get()`/`latestForCourse()`. State is persisted in
 * `map_build_jobs` so a mid-build restart can be reconciled (see
 * `reconcileOrphans`).
 */
export class MapBuildService {
    private readonly db: Kysely<Database>;
    private readonly assets: AssetsService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly python: string;
    private readonly runner: PipelineRunner;
    private readonly terrainEdits: TerrainEditsService;

    /** jobId → in-flight run promise (so tests can await a build to completion). */
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(deps: MapBuildDeps) {
        this.db = deps.db;
        this.assets = deps.assets;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? path.resolve(process.cwd(), '../pipeline');
        this.python = deps.python ?? path.join(this.pipelineDir, '.venv', 'bin', 'python');
        this.runner = deps.runner ?? defaultRunner(this.python);
        this.terrainEdits = deps.terrainEdits ?? new TerrainEditsService(deps.db);
    }

    // --- Queries ---

    private jobs() {
        return this.db.selectFrom('map_build_jobs').selectAll();
    }

    async get(jobId: string): Promise<MapBuildJob> {
        const row = await this.jobs().where('id', '=', jobId).executeTakeFirst();
        if (!row) throw new NotFoundError(`Map build job ${jobId} not found`);
        return toJob(row);
    }

    async latestForCourse(courseId: string): Promise<MapBuildJob | null> {
        const row = await this.jobs()
            .where('course_id', '=', courseId)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
        return row ? toJob(row) : null;
    }

    /**
     * Marks any job still `running` (or `pending`) as failed — used on boot to
     * clear orphans left by a restart that killed the in-memory runner.
     */
    async reconcileOrphans(): Promise<void> {
        await this.db
            .updateTable('map_build_jobs')
            .where((eb) => eb('status', '=', 'running').or('status', '=', 'pending'))
            .set({
                status: 'failed',
                error: 'Build interrupted by server restart',
                updated_at: sql`(datetime('now'))`,
            })
            .execute();
    }

    // --- Start ---

    /**
     * Begins a build for `courseId` over `bbox`. Inserts a pending job, kicks
     * off the pipeline chain detached, and returns the job immediately.
     * Rejects if the course is missing or a build is already running for it.
     */
    async start(courseId: string, bbox: Bbox): Promise<MapBuildJob> {
        const siteId = await this.resolveSiteId(courseId);

        const running = await this.jobs()
            .where('course_id', '=', courseId)
            .where((eb) => eb('status', '=', 'running').or('status', '=', 'pending'))
            .executeTakeFirst();
        if (running) throw new Error(`A build is already running for course ${courseId}`);

        const id = crypto.randomUUID();
        await this.db.insertInto('map_build_jobs').values({
            id,
            course_id: courseId,
            site_id: siteId,
            status: 'pending',
            step: null,
            bbox_json: JSON.stringify(bbox),
            log: '',
            error: null,
        }).execute();

        const promise = this.run(id, siteId, courseId, bbox).finally(() => this.inflight.delete(id));
        this.inflight.set(id, promise);
        // Detached: surface nothing to the caller; failures are recorded on the row.
        promise.catch(() => {});

        return this.get(id);
    }

    /** Resolves when the given job's in-flight run settles (immediately if none). */
    async waitForJob(jobId: string): Promise<void> {
        await this.inflight.get(jobId);
    }

    /**
     * The site (map owner) for a course. If the course has no site yet, creates
     * a 1:1 site and links it — a fresh course builds its own map; sharing is
     * done by pointing another course's site_id at an existing site.
     */
    private async resolveSiteId(courseId: string): Promise<string> {
        const course = await this.db
            .selectFrom('courses').select(['id', 'name', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        if (course.site_id) return course.site_id;

        const siteId = crypto.randomUUID();
        await this.db.insertInto('sites').values({ id: siteId, name: course.name, version: 1 }).execute();
        await this.db.updateTable('courses').where('id', '=', courseId)
            .set({ site_id: siteId, updated_at: sql`(datetime('now'))` }).execute();
        return siteId;
    }

    // --- Run chain (site-scoped: all map data lives under the site id) ---

    private async run(jobId: string, siteId: string, courseId: string, bbox: Bbox): Promise<void> {
        const env = { ...process.env };
        const work = await mkdtemp(path.join(tmpdir(), `golfbuild-${jobId}-`));
        const lidarDir = path.join(work, 'lidar');
        const demTif = path.join(work, 'dem.tif');
        const tiles = path.join(work, 'tiles');
        const sources = this.sourcesDir(siteId);
        const bboxArg = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;

        try {
            await this.setStatus(jobId, 'running');

            // Elevation: Laserdata Skog lidar → gridded DEM (EPSG:3006).
            if (!await this.exec(jobId, 'fetch-lidar', gp('fetch-lidar', '--bbox', bboxArg, '--out-dir', lidarDir), env)) return;

            // Persist the .laz IMMEDIATELY (before any later step can fail): they
            // are multi-use assets (detect-trees, detect-water, future tooling),
            // not build scratch. They live under the site's sources dir and are
            // deleted manually per course via the editor's "Delete lidar files"
            // action — the workdir cleanup below no longer removes them.
            const persistedLidar = this.lidarDir(siteId);
            await relocateLidar(lidarDir, persistedLidar);

            await this.setStep(jobId, 'grid-dem');
            const lidarFiles = await this.listLidar(persistedLidar);
            if (lidarFiles.length === 0) {
                await this.fail(jobId, 'grid-dem', 'fetch-lidar downloaded no .laz files for this area — the bbox may be outside Laserdata Skog coverage.', env);
                return;
            }
            // grid-dem crops in SWEREF99 TM metres, so reproject the WGS84 bbox first.
            const reproj = await this.runner(gp('reproject-bbox', '--bbox', bboxArg, '--to', '3006'), { cwd: this.pipelineDir, env });
            await this.appendLog(jobId, 'grid-dem', reproj.stdout, reproj.stderr, env);
            if (reproj.code !== 0) {
                await this.fail(jobId, 'grid-dem', explainPipelineError('grid-dem', reproj.stderr || 'reproject-bbox failed'), env);
                return;
            }
            const bbox3006 = reproj.stdout.trim();
            if (!await this.exec(jobId, 'grid-dem', gp('grid-dem', '--lidar', ...lidarFiles, '--bbox-3006', bbox3006, '--out', demTif), env)) return;

            // Persist the DEM for reuse (gspro hillshade, rebuilds).
            await mkdir(sources, { recursive: true });
            await copyFile(demTif, path.join(sources, 'dem.tif'));

            // Replay the site's enabled terrain edits (T54/T56). Every DEM
            // consumer downstream (terrain tiles, hillshade, manifest
            // elevation, the future Unity .raw export) reads the EDITED DEM;
            // sources/dem.tif stays raw forever (D-TE2). Zero enabled edits →
            // skipped, identical behavior to a plain build.
            const demEdited = await this.applyTerrainEdits(jobId, siteId, work, demTif, env);
            if (demEdited === false) return; // job failed at apply-dem-edits
            const terrainDem = demEdited ?? demTif;

            // Ortho: fetch the two newest vintages (often flown in different
            // seasons) so they can be compared/switched in-app. Persist both as
            // GeoTIFFs; the active (newest) one is tiled into the flat ortho
            // tree below, the others into per-collection subdirs after install
            // so the client can switch between them instantly (no re-tile).
            await this.setStep(jobId, 'fetch-ortho');
            const vintages = await this.listOrthoVintages(jobId, bboxArg, env);
            if (vintages === null) return; // failed
            if (vintages.length === 0) {
                await this.fail(jobId, 'fetch-ortho', 'No orthophoto vintages cover this area.', env);
                return;
            }
            const chosen = vintages.slice(0, 2);
            for (const v of chosen) {
                const dst = path.join(sources, orthoSourceName(v.collection));
                if (!await this.exec(jobId, 'fetch-ortho', gp('fetch-ortho', '--bbox', bboxArg, '--collection', v.collection, '--workdir', path.join(work, 'ortho-src'), '--out', dst), env)) return;
            }
            const active = chosen[0].collection;

            if (!await this.exec(jobId, 'tile-ortho', gp('tile-ortho', '--input', path.join(sources, orthoSourceName(active)), '--out', path.join(tiles, 'ortho'), '--minzoom', '14', '--maxzoom', '20'), env)) return;
            if (!await this.exec(jobId, 'tile-terrain', gp('tile-terrain', '--input', terrainDem, '--out', path.join(tiles, 'terrain'), '--minzoom', '12', '--maxzoom', '16'), env)) return;
            // Opaque QGIS-style grayscale hillshade (az 315 / alt 45 / z 1) as its
            // own raster layer — the map's "Hillshade" toggle shows this image.
            if (!await this.exec(jobId, 'tile-hillshade', gp('tile-hillshade', '--input', terrainDem, '--out', path.join(tiles, 'hillshade')), env)) return;
            // --course is the on-disk/tile-URL key = the site id (install writes data/tiles/{siteId}).
            if (!await this.exec(jobId, 'manifest', gp('manifest', '--course', siteId, '--tiles-dir', tiles, '--dem', terrainDem), env)) return;
            if (!await this.exec(jobId, 'install', gp('install', '--course', siteId, '--ortho', path.join(tiles, 'ortho'), '--terrain', path.join(tiles, 'terrain'), '--hillshade', path.join(tiles, 'hillshade'), '--manifest', path.join(tiles, 'manifest.json'), '--data-dir', this.dataDir), env)) return;

            // Tile the non-active vintages into ortho/<collection>/ (served via
            // ?c=<collection>). Runs AFTER install — install rmtree's/rewrites
            // the flat ortho dir and would otherwise wipe these subdirs.
            const installedOrtho = path.join(this.dataDir, 'tiles', siteId, 'ortho');
            for (const v of chosen) {
                if (v.collection === active) continue; // active lives in the flat tree
                const dst = path.join(installedOrtho, v.collection);
                if (!await this.exec(jobId, 'tile-ortho', gp('tile-ortho', '--input', path.join(sources, orthoSourceName(v.collection)), '--out', dst, '--minzoom', '14', '--maxzoom', '20'), env)) return;
            }

            // register step is TS, not a subprocess: the server owns the DB.
            await this.setStep(jobId, 'register');
            await this.registerAssets(siteId, courseId, chosen, active);

            await this.setStatus(jobId, 'succeeded');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.fail(jobId, null, message, env).catch(() => {});
        } finally {
            await rm(work, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * Runs one labelled pipeline step: sets `step`, spawns golfpipe, appends its
     * output to the log, and on nonzero exit records a (translated) failure.
     * Returns true on success, false if the job was failed.
     */
    private async exec(jobId: string, step: BuildStep, args: string[], env: Record<string, string | undefined>): Promise<boolean> {
        await this.setStep(jobId, step);
        const result = await this.runner(args, { cwd: this.pipelineDir, env });
        await this.appendLog(jobId, step, result.stdout, result.stderr, env);
        if (result.code !== 0) {
            const raw = result.stderr || result.stdout || `exit code ${result.code}`;
            await this.fail(jobId, step, explainPipelineError(step, raw), env);
            return false;
        }
        return true;
    }

    /**
     * Replays the site's ENABLED terrain edits onto `demTif` (T54's
     * `apply-dem-edits`): exports them as the D-TE5 GeoJSON handoff (WGS84,
     * created_at order) to the workdir, writes the edited DEM next to it, and
     * persists a copy as `sources/dem-edited.tif` (D-TE2 — a regenerable
     * cache; the raw DEM is never modified).
     *
     * Returns the edited DEM path, `null` when there are no enabled edits
     * (step skipped — callers use the raw DEM; any stale cached edited DEM is
     * removed so no consumer reads outdated edits), or `false` when the
     * pipeline step failed (the job row is already marked failed).
     */
    private async applyTerrainEdits(
        jobId: string,
        siteId: string,
        work: string,
        demTif: string,
        env: Record<string, string | undefined>,
    ): Promise<string | null | false> {
        const edits = (await this.terrainEdits.listBySite(siteId)).filter(e => e.enabled);
        const persisted = path.join(this.sourcesDir(siteId), 'dem-edited.tif');
        if (edits.length === 0) {
            await rm(persisted, { force: true }).catch(() => {});
            return null;
        }
        const editsPath = path.join(work, 'terrain-edits.geojson');
        await writeFile(editsPath, JSON.stringify(terrainEditsGeojson(edits)));
        const demEdited = path.join(work, 'dem-edited.tif');
        if (!await this.exec(jobId, 'apply-dem-edits', gp('apply-dem-edits', '--input', demTif, '--edits', editsPath, '--out', demEdited), env)) {
            return false;
        }
        await mkdir(this.sourcesDir(siteId), { recursive: true });
        await copyFile(demEdited, persisted);
        return demEdited;
    }

    // --- Fast re-terrain (T56): replay edits + re-tile, no refetch ---

    /**
     * Starts the fast re-terrain job for a course: replay the site's enabled
     * terrain edits onto the persisted `sources/dem.tif` and re-tile ONLY
     * terrain + hillshade (RE_TERRAIN_STEPS) — no lidar/ortho refetch. This
     * is the editing loop behind the terrain tool's "Apply to terrain".
     * Requires a prior full build (persisted DEM + installed tiles). Same
     * job-row/polling contract as `start()`.
     */
    async reTerrain(courseId: string): Promise<MapBuildJob> {
        const siteId = await this.siteIdForCourse(courseId);
        const demSrc = siteId ? path.join(this.sourcesDir(siteId), 'dem.tif') : null;
        if (!siteId || !demSrc || !await Bun.file(demSrc).exists()) {
            throw new Error(
                'No persisted DEM (sources/dem.tif) for this course’s site — '
                + 'run a full map build first, then apply terrain edits.',
            );
        }

        const running = await this.jobs()
            .where('course_id', '=', courseId)
            .where((eb) => eb('status', '=', 'running').or('status', '=', 'pending'))
            .executeTakeFirst();
        if (running) throw new Error(`A build is already running for course ${courseId}`);

        const id = crypto.randomUUID();
        const bbox = await this.siteBbox(siteId);
        await this.db.insertInto('map_build_jobs').values({
            id, course_id: courseId, site_id: siteId, kind: 're-terrain',
            status: 'pending', step: null, bbox_json: JSON.stringify(bbox), log: '', error: null,
        }).execute();

        const promise = this.runReTerrain(id, siteId, courseId, demSrc).finally(() => this.inflight.delete(id));
        this.inflight.set(id, promise);
        promise.catch(() => {});
        return this.get(id);
    }

    private async runReTerrain(jobId: string, siteId: string, courseId: string, demSrc: string): Promise<void> {
        const env = { ...process.env };
        const work = await mkdtemp(path.join(tmpdir(), `golfreterrain-${jobId}-`));
        const tiles = path.join(work, 'tiles');
        const installedRoot = path.join(this.dataDir, 'tiles', siteId);

        try {
            await this.setStatus(jobId, 'running');

            // Zero enabled edits is VALID here (null): the user disabled or
            // deleted them all and re-applies to revert to the raw DEM.
            const demEdited = await this.applyTerrainEdits(jobId, siteId, work, demSrc, env);
            if (demEdited === false) return;
            const terrainDem = demEdited ?? demSrc;

            // Same zoom ranges as a full build (constants — see run()).
            if (!await this.exec(jobId, 'tile-terrain', gp('tile-terrain', '--input', terrainDem, '--out', path.join(tiles, 'terrain'), '--minzoom', '12', '--maxzoom', '16'), env)) return;
            if (!await this.exec(jobId, 'tile-hillshade', gp('tile-hillshade', '--input', terrainDem, '--out', path.join(tiles, 'hillshade')), env)) return;

            // Partial install: only terrain + hillshade are passed, so install
            // replaces exactly those two layer dirs and leaves the installed
            // ortho tree (incl. per-vintage subdirs) and manifest untouched.
            if (!await this.exec(jobId, 'install', gp('install', '--course', siteId, '--terrain', path.join(tiles, 'terrain'), '--hillshade', path.join(tiles, 'hillshade'), '--data-dir', this.dataDir), env)) return;

            // Regenerate the manifest AFTER install, scanning the INSTALLED
            // tile root (ortho + the fresh terrain/hillshade all present).
            // This must happen on every re-terrain: `generatedAt` drives the
            // web's `?v=` tile cache-buster (tiles are served with year-long
            // immutable cache headers) and the elevation min/max is
            // DEM-derived, so edits can change it. The vintage fields the
            // pipeline doesn't know about are re-patched from the old
            // manifest, which is read BEFORE the pipeline overwrites it.
            const oldManifest = await this.readInstalledManifest(siteId);
            if (!await this.exec(jobId, 'manifest', gp('manifest', '--course', siteId, '--tiles-dir', installedRoot, '--dem', terrainDem), env)) return;

            await this.setStep(jobId, 'register');
            await this.refreshManifestAsset(siteId, courseId, oldManifest);

            await this.setStatus(jobId, 'succeeded');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.fail(jobId, null, message, env).catch(() => {});
        } finally {
            await rm(work, { recursive: true, force: true }).catch(() => {});
        }
    }

    /** The installed manifest.json for a site, parsed, or null when absent/invalid. */
    private async readInstalledManifest(siteId: string): Promise<Record<string, unknown> | null> {
        try {
            return JSON.parse(await Bun.file(path.join(this.dataDir, 'tiles', siteId, 'manifest.json')).text());
        } catch {
            return null;
        }
    }

    /**
     * After a re-terrain regenerated the installed manifest.json: carry the
     * ortho-vintage fields over from the pre-regeneration manifest (the
     * pipeline knows nothing about vintages), then replace ONLY the
     * `tile_manifest` asset registration so the web picks up the new
     * `generatedAt` (→ new `?v=`). ortho_cog/dem_cog registrations still
     * point at unchanged paths and are left alone.
     */
    private async refreshManifestAsset(siteId: string, courseId: string, old: Record<string, unknown> | null): Promise<void> {
        const manifestPath = path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
        const manifest = JSON.parse(await Bun.file(manifestPath).text());
        if (old && Array.isArray(old.orthoVintages)) manifest.orthoVintages = old.orthoVintages;
        if (old && typeof old.activeOrtho === 'string') manifest.activeOrtho = old.activeOrtho;
        const json = JSON.stringify(manifest);
        await writeFile(manifestPath, json);

        const existing = await this.assets.listBySite(siteId);
        for (const asset of existing) {
            if (asset.kind === 'tile_manifest') await this.assets.remove(asset.id, asset.version);
        }
        await this.assets.register({ siteId, courseId, kind: 'tile_manifest', filename: `tiles/${siteId}/manifest.json`, metaJson: json });
    }

    /** Absolute paths of the `.laz`/`.copc.laz` files fetch-lidar downloaded. */
    private async listLidar(lidarDir: string): Promise<string[]> {
        let names: string[];
        try {
            names = await readdir(lidarDir);
        } catch {
            return [];
        }
        return names.filter(n => n.toLowerCase().endsWith('.laz')).map(n => path.join(lidarDir, n));
    }

    private sourcesDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId);
    }

    /** Persistent lidar (.laz) directory for a site (kept after builds). */
    private lidarDir(siteId: string): string {
        return path.join(this.sourcesDir(siteId), 'lidar');
    }

    /**
     * The site owning a course's map, WITHOUT creating one — a read for lidar
     * info/delete must not mint a site as a side effect. Null when the course
     * has never been built (no site yet). Throws if the course is missing.
     */
    private async siteIdForCourse(courseId: string): Promise<string | null> {
        const course = await this.db
            .selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        return course.site_id ?? null;
    }

    /**
     * Lists the persisted lidar .laz files for a course (resolves course→site).
     * Empty when the course has no site or no lidar dir.
     */
    async lidarInfo(courseId: string): Promise<LidarInfo> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) return { files: [], totalBytes: 0 };
        return this.readLidarDir(this.lidarDir(siteId));
    }

    /**
     * Deletes the persisted lidar dir for a course (an explicit, user-driven
     * action from the editor menu — builds no longer auto-delete). Returns the
     * bytes freed; a no-op (0 bytes) when there's nothing to delete.
     */
    async deleteLidar(courseId: string): Promise<{ freedBytes: number }> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) return { freedBytes: 0 };
        const dir = this.lidarDir(siteId);
        const { totalBytes } = await this.readLidarDir(dir);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return { freedBytes: totalBytes };
    }

    /** Reads a lidar dir into {names, total bytes}; empty if it doesn't exist. */
    private async readLidarDir(dir: string): Promise<LidarInfo> {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return { files: [], totalBytes: 0 };
        }
        const laz = names.filter(n => n.toLowerCase().endsWith('.laz')).sort();
        let totalBytes = 0;
        for (const name of laz) {
            try {
                totalBytes += (await stat(path.join(dir, name))).size;
            } catch {
                // File vanished between readdir and stat — skip it.
            }
        }
        return { files: laz, totalBytes };
    }

    /** Runs list-ortho-vintages and parses its JSON, or fails the job (→ null). */
    private async listOrthoVintages(jobId: string, bboxArg: string, env: Record<string, string | undefined>): Promise<OrthoVintage[] | null> {
        const result = await this.runner(['-m', 'golfpipe', 'list-ortho-vintages', '--bbox', bboxArg], { cwd: this.pipelineDir, env });
        await this.appendLog(jobId, 'fetch-ortho', result.stdout, result.stderr, env);
        if (result.code !== 0) {
            await this.fail(jobId, 'fetch-ortho', explainPipelineError('fetch-ortho', result.stderr || 'list-ortho-vintages failed'), env);
            return null;
        }
        try {
            const raw = JSON.parse(result.stdout) as Array<{ collection: string; dates?: string[] }>;
            return raw.map(v => ({ collection: v.collection, dates: v.dates ?? [] }));
        } catch {
            await this.fail(jobId, 'fetch-ortho', 'Could not parse ortho vintage list.', env);
            return null;
        }
    }

    /**
     * Reads the freshly installed manifest, augments it with the ortho vintage
     * list + active vintage, writes it back, and (re)registers the 3 tile assets.
     * The tile_manifest metaJson is what the web tileset.service reads to flip
     * `hasTiles` and (now) to populate the vintage switcher.
     */
    private async registerAssets(siteId: string, courseId: string, vintages: OrthoVintage[], active: string): Promise<void> {
        const manifestJson = await this.writeManifestVintages(siteId, vintages, active);

        // Idempotent rebuild: drop any prior tile assets for this site first.
        const existing = await this.assets.listBySite(siteId);
        for (const asset of existing) {
            if ((BUILT_ASSET_KINDS as readonly string[]).includes(asset.kind)) {
                await this.assets.remove(asset.id, asset.version);
            }
        }

        // Assets resolve by site_id; course_id (the requester) satisfies the legacy
        // FK and is otherwise unused for map lookups.
        await this.assets.register({ siteId, courseId, kind: 'ortho_cog', filename: `tiles/${siteId}/ortho` });
        // dem_cog must point at the persisted DEM GeoTIFF *file* (not the terrain
        // tile dir) — the analysis service opens it directly for green/elevation
        // sampling. The terrain tiles are referenced via the manifest instead.
        await this.assets.register({ siteId, courseId, kind: 'dem_cog', filename: `sources/${siteId}/dem.tif` });
        await this.assets.register({ siteId, courseId, kind: 'tile_manifest', filename: `tiles/${siteId}/manifest.json`, metaJson: manifestJson });
    }

    /** Patch the on-disk manifest with orthoVintages + activeOrtho; returns the JSON. */
    private async writeManifestVintages(siteId: string, vintages: OrthoVintage[], active: string): Promise<string> {
        const manifestPath = path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
        const manifest = JSON.parse(await Bun.file(manifestPath).text());
        manifest.orthoVintages = vintages;
        manifest.activeOrtho = active;
        const json = JSON.stringify(manifest);
        await writeFile(manifestPath, json);
        return json;
    }

    // --- On-demand ortho vintage tiling ---

    /**
     * Ensure a vintage's ortho tiles exist under `ortho/<collection>/`, tiled
     * from the persisted source GeoTIFF (no re-download). The client calls this
     * the first time it switches to a not-yet-tiled vintage; the actual switch
     * is a client-side layer toggle. Idempotent — returns an immediately
     * succeeded job when the tiles already exist. Runs detached as a job the
     * client polls, like a build. Does NOT touch the manifest (the flat active
     * vintage and the served tile version are unchanged).
     */
    async ensureOrthoTiled(courseId: string, collection: string): Promise<MapBuildJob> {
        if (!/^[A-Za-z0-9._-]+$/.test(collection)) {
            throw new Error(`Invalid ortho collection: ${collection}`);
        }
        const siteId = await this.resolveSiteId(courseId);
        const outDir = path.join(this.dataDir, 'tiles', siteId, 'ortho', collection);
        const src = path.join(this.sourcesDir(siteId), orthoSourceName(collection));

        const alreadyTiled = await this.dirHasEntries(outDir);
        if (!alreadyTiled && !await Bun.file(src).exists()) {
            throw new NotFoundError(`No persisted ortho '${collection}' for this site`);
        }
        const running = await this.jobs()
            .where('course_id', '=', courseId)
            .where((eb) => eb('status', '=', 'running').or('status', '=', 'pending'))
            .executeTakeFirst();
        if (running) throw new Error(`A build is already running for course ${courseId}`);

        const id = crypto.randomUUID();
        const bbox = await this.siteBbox(siteId);
        await this.db.insertInto('map_build_jobs').values({
            id, course_id: courseId, site_id: siteId, status: 'pending', step: null,
            bbox_json: JSON.stringify(bbox), log: '', error: null,
        }).execute();

        if (alreadyTiled) {
            await this.setStatus(id, 'succeeded'); // nothing to tile — resolve at once
            return this.get(id);
        }
        const promise = this.runEnsureOrtho(id, src, outDir).finally(() => this.inflight.delete(id));
        this.inflight.set(id, promise);
        promise.catch(() => {});
        return this.get(id);
    }

    private async runEnsureOrtho(jobId: string, src: string, outDir: string): Promise<void> {
        const env = { ...process.env };
        try {
            await this.setStatus(jobId, 'running');
            if (!await this.exec(jobId, 'tile-ortho', ['-m', 'golfpipe', 'tile-ortho', '--input', src, '--out', outDir, '--minzoom', '14', '--maxzoom', '20'], env)) return;
            await this.setStatus(jobId, 'succeeded');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.fail(jobId, null, message, env).catch(() => {});
        }
    }

    /** True when `dir` exists and is non-empty (used as a "vintage is tiled" check). */
    private async dirHasEntries(dir: string): Promise<boolean> {
        try {
            return (await readdir(dir)).length > 0;
        } catch {
            return false;
        }
    }

    /** Site map bounds from its manifest (fallback to zeros), for a job row's bbox. */
    private async siteBbox(siteId: string): Promise<Bbox> {
        try {
            const manifest = JSON.parse(await Bun.file(path.join(this.dataDir, 'tiles', siteId, 'manifest.json')).text());
            const b = manifest.bounds;
            return { west: b.west, south: b.south, east: b.east, north: b.north };
        } catch {
            return { west: 0, south: 0, east: 0, north: 0 };
        }
    }

    // --- Row updates ---

    private async setStatus(jobId: string, status: BuildStatus): Promise<void> {
        await this.db.updateTable('map_build_jobs').where('id', '=', jobId)
            .set({ status, updated_at: sql`(datetime('now'))` }).execute();
    }

    private async setStep(jobId: string, step: BuildStep): Promise<void> {
        await this.db.updateTable('map_build_jobs').where('id', '=', jobId)
            .set({ step, updated_at: sql`(datetime('now'))` }).execute();
    }

    private async appendLog(jobId: string, step: BuildStep, stdout: string, stderr: string, env: Record<string, string | undefined>): Promise<void> {
        const chunk = scrubSecrets(`\n=== ${step} ===\n${stdout}${stderr}`, env);
        await this.db.updateTable('map_build_jobs').where('id', '=', jobId)
            .set({ log: sql`${sql.ref('log')} || ${chunk}`, updated_at: sql`(datetime('now'))` }).execute();
    }

    private async fail(jobId: string, step: BuildStep | null, error: string, env: Record<string, string | undefined>): Promise<void> {
        await this.db.updateTable('map_build_jobs').where('id', '=', jobId)
            .set({
                status: 'failed',
                ...(step ? { step } : {}),
                error: scrubSecrets(error, env),
                updated_at: sql`(datetime('now'))`,
            }).execute();
    }
}

/**
 * Moves the .laz files fetch-lidar wrote into `fromDir` (the ephemeral workdir)
 * into the persistent `toDir`, overwriting same-named tiles (Lantmäteriet tiles
 * are immutable, so an identical name is the same data). No-op when nothing was
 * fetched. `move`, not copy — the workdir is torn down afterwards.
 */
async function relocateLidar(fromDir: string, toDir: string): Promise<void> {
    let names: string[];
    try {
        names = await readdir(fromDir);
    } catch {
        return; // fetch-lidar wrote nothing
    }
    const laz = names.filter(n => n.toLowerCase().endsWith('.laz'));
    if (laz.length === 0) return;
    await mkdir(toDir, { recursive: true });
    for (const name of laz) {
        await moveFile(path.join(fromDir, name), path.join(toDir, name));
    }
}

/** Rename, falling back to copy+unlink across filesystems (tmpdir → data dir EXDEV). */
async function moveFile(src: string, dst: string): Promise<void> {
    try {
        await rename(src, dst);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await copyFile(src, dst);
        await rm(src, { force: true });
    }
}

/** Filename for a persisted ortho vintage source GeoTIFF (sanitized collection). */
function orthoSourceName(collection: string): string {
    return `ortho-${collection.replace(/[^A-Za-z0-9_-]+/g, '_')}.tif`;
}

/**
 * The D-TE5 server→pipeline handoff: terrain edits as a GeoJSON
 * FeatureCollection in WGS84 with per-feature properties
 * `{ op, featherM, radiusM?, flat?, createdAt }`. Rings are stored EPSG:3006
 * (`{x,y}` metres) and reprojected here; the pipeline reprojects back to the
 * DEM CRS via `rasterio.warp.transform_geom`. Callers pass edits pre-sorted
 * (listBySite is created_at order, D-TE4); `createdAt` is included so the
 * pipeline's defensive re-sort agrees. GeoJSON linear rings must be closed —
 * the tool stores open rings, so the first point is repeated at the end.
 */
export function terrainEditsGeojson(edits: TerrainEdit[]): {
    type: 'FeatureCollection';
    features: object[];
} {
    return {
        type: 'FeatureCollection',
        features: edits.map(edit => ({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: edit.rings.map(ring => {
                    const coords = ring.map(p => {
                        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
                        return [lon, lat];
                    });
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    if (first && (first[0] !== last[0] || first[1] !== last[1])) coords.push([...first]);
                    return coords;
                }),
            },
            properties: {
                op: edit.op,
                featherM: edit.params.featherM,
                ...(edit.params.radiusM !== undefined ? { radiusM: edit.params.radiusM } : {}),
                ...(edit.params.flat ? { flat: true } : {}),
                createdAt: edit.createdAt,
            },
        })),
    };
}

/**
 * Turns an opaque Lantmäteriet auth failure (raw nginx 401/403 + Python
 * traceback) into an actionable message. A 403 means the credentials
 * authenticate but the account isn't entitled to that product's downloads.
 */
function explainPipelineError(step: BuildStep, raw: string): string {
    const authDenied = /\b40[13]\b/.test(raw) && /(lantmateriet|forbidden|authoriz)/i.test(raw);
    if (!authDenied) return raw;
    const product = step === 'fetch-lidar'
        ? 'laser data (Laserdata Skog / point clouds)'
        : step === 'fetch-ortho'
            ? 'orthophoto imagery'
            : 'this';
    return [
        `Lantmäteriet denied the ${product} download (HTTP 401/403).`,
        'The credentials authenticate, but the account is likely not subscribed to this',
        "product in Lantmäteriet's self-service portal (Geotorget). Enable it there for the",
        'same account and rebuild.',
        '',
        raw,
    ].join('\n');
}

/** Redacts Lantmäteriet credentials from any captured output before it's stored. */
function scrubSecrets(text: string, env: Record<string, string | undefined>): string {
    let out = text;
    const pass = env.LANTMATERIET_PASS;
    const user = env.LANTMATERIET_USER;
    if (pass) out = out.split(pass).join('***');
    if (user) out = out.split(user).join('***');
    // http://user:pass@host → http://***@host
    out = out.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***@');
    return out;
}
