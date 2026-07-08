import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import * as path from 'node:path';
import { mkdtemp, mkdir, copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Database, MapBuildJobsTable } from '../db/schema';
import type { AssetsService } from './assets.service';
import { NotFoundError } from '@basics/core/server/auth';

// --- Public types ---

export type BuildStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type BuildStep =
    | 'fetch-lidar' | 'grid-dem' | 'fetch-ortho' | 'tile-ortho'
    | 'tile-terrain' | 'manifest' | 'install' | 'register';

/**
 * Ordered pipeline steps the runner walks through. Also drives the web
 * progress UI. Elevation comes from Laserdata Skog lidar (fetch-lidar →
 * grid-dem), NOT the Markhöjdmodell DTM grid (fetch-dem) — the account is
 * entitled to the laser + ortho products, not the DTM.
 */
export const BUILD_STEPS: readonly BuildStep[] = [
    'fetch-lidar', 'grid-dem', 'fetch-ortho', 'tile-ortho', 'tile-terrain', 'manifest', 'install', 'register',
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

export interface MapBuildJob {
    id: string;
    courseId: string;
    siteId: string | null;
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
}

// The three asset kinds a build (re)writes for a course.
const BUILT_ASSET_KINDS = ['ortho_cog', 'dem_cog', 'tile_manifest'] as const;

// --- Row mapping ---

type MapBuildJobRow = Selectable<MapBuildJobsTable>;

function toJob(row: MapBuildJobRow): MapBuildJob {
    return {
        id: row.id,
        courseId: row.course_id,
        siteId: row.site_id,
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
        const gp = (...args: string[]) => ['-m', 'golfpipe', ...args];

        try {
            await this.setStatus(jobId, 'running');

            // Elevation: Laserdata Skog lidar → gridded DEM (EPSG:3006).
            if (!await this.exec(jobId, 'fetch-lidar', gp('fetch-lidar', '--bbox', bboxArg, '--out-dir', lidarDir), env)) return;

            await this.setStep(jobId, 'grid-dem');
            const lidarFiles = await this.listLidar(lidarDir);
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

            // Ortho: fetch the two newest vintages (often flown in different
            // seasons) so they can be compared/switched in-app. Persist both as
            // GeoTIFFs; only the active (newest) one is tiled now.
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
            if (!await this.exec(jobId, 'tile-terrain', gp('tile-terrain', '--input', demTif, '--out', path.join(tiles, 'terrain'), '--minzoom', '12', '--maxzoom', '16'), env)) return;
            // --course is the on-disk/tile-URL key = the site id (install writes data/tiles/{siteId}).
            if (!await this.exec(jobId, 'manifest', gp('manifest', '--course', siteId, '--tiles-dir', tiles, '--dem', demTif), env)) return;
            if (!await this.exec(jobId, 'install', gp('install', '--course', siteId, '--ortho', path.join(tiles, 'ortho'), '--terrain', path.join(tiles, 'terrain'), '--manifest', path.join(tiles, 'manifest.json'), '--data-dir', this.dataDir), env)) return;

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

    // --- Switch active ortho vintage ---

    /**
     * Re-tile a course's ortho from a previously-persisted vintage GeoTIFF (no
     * re-download). Runs detached as a job the client polls, like a build.
     */
    async setActiveOrtho(courseId: string, collection: string): Promise<MapBuildJob> {
        const siteId = await this.resolveSiteId(courseId);
        const src = path.join(this.sourcesDir(siteId), orthoSourceName(collection));
        if (!await Bun.file(src).exists()) {
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

        const promise = this.runSetOrtho(id, siteId, collection, src).finally(() => this.inflight.delete(id));
        this.inflight.set(id, promise);
        promise.catch(() => {});
        return this.get(id);
    }

    private async runSetOrtho(jobId: string, siteId: string, collection: string, src: string): Promise<void> {
        const env = { ...process.env };
        const orthoTiles = path.join(this.dataDir, 'tiles', siteId, 'ortho');
        try {
            await this.setStatus(jobId, 'running');
            // Replace the served ortho tiles in place from the persisted source.
            await rm(orthoTiles, { recursive: true, force: true });
            if (!await this.exec(jobId, 'tile-ortho', ['-m', 'golfpipe', 'tile-ortho', '--input', src, '--out', orthoTiles, '--minzoom', '14', '--maxzoom', '20'], env)) return;

            await this.setStep(jobId, 'register');
            await this.setActiveInManifest(siteId, collection);
            await this.setStatus(jobId, 'succeeded');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.fail(jobId, null, message, env).catch(() => {});
        }
    }

    /** Set activeOrtho + bump generatedAt (cache-bust) in the manifest + asset. */
    private async setActiveInManifest(siteId: string, collection: string): Promise<void> {
        const manifestPath = path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
        const manifest = JSON.parse(await Bun.file(manifestPath).text());
        manifest.activeOrtho = collection;
        manifest.generatedAt = new Date().toISOString(); // changes tileVersion → client refetches tiles
        const json = JSON.stringify(manifest);
        await writeFile(manifestPath, json);

        const tm = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (tm) await this.assets.update(tm.id, tm.version, { metaJson: json });
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

/** Filename for a persisted ortho vintage source GeoTIFF (sanitized collection). */
function orthoSourceName(collection: string): string {
    return `ortho-${collection.replace(/[^A-Za-z0-9_-]+/g, '_')}.tif`;
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
