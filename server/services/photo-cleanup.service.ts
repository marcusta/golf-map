import type { Kysely } from 'kysely';
import * as path from 'node:path';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CleanedPhotoService } from './cleaned-photo.service';
import { defaultRunner, type PipelineRunner } from './map-build.service';
import { venvPython } from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { CLEANED_PHOTO_SIZE, type CleanedImportResult } from '../../shared/cleaned-photo';

// --- Public types ---

export type PhotoCleanupHoleStatus = 'pending' | 'running' | 'done' | 'failed';

/** One hole of a cleanup run: what was found and changed, as `golfpipe cleanup-hole` reported it. */
export interface PhotoCleanupHole {
    hole: number;
    status: PhotoCleanupHoleStatus;
    /** Pixels the hole's surfaces and the cleanup areas allow to be cleaned. */
    scopePx: number;
    /** Pixels found to be shadow, crown, object or path. */
    targetPx: number;
    /** Pixels the fills changed: what accepting the hole writes into the photo. */
    changedPx: number;
    seconds: number | null;
    /** E.g. no cleanup area over the hole, PhotoCraft not found. */
    warnings: string[];
    error: string | null;
}

/** What `apply` put into the cleaned photo. */
export interface PhotoCleanupApplied {
    at: string;
    holes: number[];
    changedPixels: number;
    undoDepth: number;
}

export type PhotoCleanupJobStatus = 'running' | 'succeeded' | 'failed';

/**
 * One cleanup run over some holes: a proposal until it is applied. It is kept
 * on disk under `sources/<siteId>/photo-cleanup/<id>/`, so it outlives the
 * process (the CLI proposes in one run and accepts in the next).
 */
export interface PhotoCleanupJob {
    id: string;
    courseId: string;
    status: PhotoCleanupJobStatus;
    startedAt: string;
    finishedAt: string | null;
    holes: PhotoCleanupHole[];
    /** One line: what it is doing now, or did. */
    step: string;
    error: string | null;
    applied: PhotoCleanupApplied | null;
}

export interface PhotoCleanupApplyResult {
    job: PhotoCleanupJob;
    import: CleanedImportResult;
}

/** The files a cleaned hole leaves for review. */
export const PHOTO_CLEANUP_IMAGES = ['review', 'photo', 'filled', 'detect', 'overlay'] as const;
export type PhotoCleanupImage = typeof PHOTO_CLEANUP_IMAGES[number];

/** A request that cannot be run as asked: a 400. */
export class InvalidPhotoCleanupError extends Error {}

export interface PhotoCleanupDeps {
    db: Kysely<Database>;
    cleanedPhoto: CleanedPhotoService;
    /** Server data dir: `sources/<siteId>/` and `models/big-lama.pt` live under it. */
    dataDir: string;
    pipelineDir?: string;
    python?: string;
    /** Injected in tests to avoid spawning Python. */
    runner?: PipelineRunner;
}

/** Finished runs kept per site (their review images take ~50 MB each). */
export const KEEP_JOBS = 3;

/** The job as stored: the public job plus what apply checks it against. */
interface StoredJob extends PhotoCleanupJob {
    siteId: string;
    /** The cleaned photo's mtime when the run copied it. */
    photoMtimeMs: number;
}

/**
 * Hole-by-hole photo cleanup (docs/photo-cleanup.md): trees, shadows,
 * players and paths painted out of the cleaned photo on the course's mapped
 * surfaces inside the site's cleanup areas. `start` runs `golfpipe
 * cleanup-hole` once per hole, in order, on a copy of the cleaned photo, so
 * a hole sees the holes before it where windows overlap; nothing touches the
 * photo itself. `apply` lays the changed pixels of the accepted holes over
 * the photo as one import: one undo step.
 */
export class PhotoCleanupService {
    private readonly db: Kysely<Database>;
    private readonly cleanedPhoto: CleanedPhotoService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: PipelineRunner;
    /** Running jobs by id; finished ones are read from disk. */
    private readonly running = new Map<string, StoredJob>();
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(deps: PhotoCleanupDeps) {
        this.db = deps.db;
        this.cleanedPhoto = deps.cleanedPhoto;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
    }

    /**
     * Starts a cleanup of `holes` (default: every hole of the course) and
     * returns at once. 400 for a hole the course lacks or a site without
     * cleanup areas, 404 for an unknown course or one without a built map,
     * 409 while a run is going for the course.
     */
    async start(courseId: string, holes?: number[]): Promise<PhotoCleanupJob> {
        const course = await this.db.selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        for (const job of this.running.values()) {
            if (job.courseId === courseId) throw new ConflictError(`A photo cleanup is already running for this course (job ${job.id})`);
        }
        const courseHoles = await this.db.selectFrom('holes').select(['number', 'saved_region_json'])
            .where('course_id', '=', courseId).orderBy('number').execute();
        const known = new Set(courseHoles.map(h => h.number));
        const wanted = holes?.length ? [...new Set(holes)].sort((a, b) => a - b) : [...known];
        const missing = wanted.filter(n => !known.has(n));
        if (missing.length) throw new InvalidPhotoCleanupError(`The course has no hole ${missing.join(', ')}`);
        if (!wanted.length) throw new InvalidPhotoCleanupError('The course has no holes to clean');
        if (!course.site_id) throw new NotFoundError(`Course ${courseId} has no map (no site): build the map first`);
        const areas = await this.db.selectFrom('cleanup_areas').select('areas_json').where('site_id', '=', course.site_id).executeTakeFirst();
        const areaList = areas ? JSON.parse(areas.areas_json) as Array<{ kind: string }> : [];
        if (!areaList.some(a => a.kind === 'include' || a.kind === 'force')) {
            throw new InvalidPhotoCleanupError('Draw cleanup areas first (Clean photo › Areas): nothing is cleaned outside them');
        }

        const photo = await this.cleanedPhoto.photoFile(courseId);
        const job: StoredJob = {
            id: crypto.randomUUID(), courseId, siteId: photo.siteId, status: 'running',
            startedAt: new Date().toISOString(), finishedAt: null, step: 'copying the photo', error: null, applied: null,
            holes: wanted.map(hole => ({ hole, status: 'pending', scopePx: 0, targetPx: 0, changedPx: 0, seconds: null, warnings: [], error: null })),
            photoMtimeMs: photo.mtimeMs,
        };
        const dir = this.jobDir(photo.siteId, job.id);
        await mkdir(path.join(dir, 'inputs'), { recursive: true });
        await writeFile(path.join(dir, 'inputs', 'features.geojson'), JSON.stringify(await this.features(courseId)));
        await writeFile(path.join(dir, 'inputs', 'areas.json'), areas!.areas_json);
        const regions = Object.fromEntries(courseHoles.map(h => [h.number, h.saved_region_json]));
        this.running.set(job.id, job);
        await this.save(job);

        const done = this.run(job, photo.path, regions).finally(() => {
            this.running.delete(job.id);
            if (this.inflight.get(courseId) === done) this.inflight.delete(courseId);
        });
        this.inflight.set(courseId, done);
        return this.public(job);
    }

    /** A run by id: the running one from memory, a finished one from disk. 404 when there is none. */
    async job(courseId: string, jobId: string): Promise<PhotoCleanupJob> {
        return this.public(await this.stored(courseId, jobId));
    }

    /** The course's running cleanup, else its newest finished one, else null. */
    async current(courseId: string): Promise<PhotoCleanupJob | null> {
        for (const job of this.running.values()) if (job.courseId === courseId) return this.public(job);
        const siteId = await this.siteId(courseId);
        if (!siteId) return null;
        const jobs = await this.storedJobs(siteId);
        const own = jobs.filter(j => j.courseId === courseId);
        return own.length ? this.public(own[0]) : null;
    }

    /** Resolves when the course has no cleanup running (the CLI, tests). */
    async whenIdle(courseId: string): Promise<void> {
        await this.inflight.get(courseId);
    }

    /**
     * Lays the changed pixels of `holes` from a finished run over the cleaned
     * photo as ONE import (one undo step) and rewrites the map tiles under
     * them. Refused (409) when the photo changed since the run copied it
     * (its pixels would be painted from an older photo), when the run was
     * applied already, or while it runs; 400 for a hole the run did not clean.
     */
    async apply(courseId: string, jobId: string, holes: number[]): Promise<PhotoCleanupApplyResult> {
        const job = await this.stored(courseId, jobId);
        if (job.status === 'running') throw new ConflictError('This cleanup is still running');
        if (job.applied) throw new ConflictError(`This cleanup was applied at ${job.applied.at}: undo it in the Clean panel first to apply it again`);
        const byHole = new Map(job.holes.map(h => [h.hole, h]));
        const order = [...new Set(holes)].sort((a, b) => a - b);
        if (!order.length) throw new InvalidPhotoCleanupError('Pick at least one hole to apply');
        const bad = order.filter(n => byHole.get(n)?.status !== 'done');
        if (bad.length) throw new InvalidPhotoCleanupError(`Hole ${bad.join(', ')} was not cleaned in this run`);
        const photo = await this.cleanedPhoto.photoFile(courseId);
        if (photo.mtimeMs !== job.photoMtimeMs) {
            throw new ConflictError('The cleaned photo changed after this cleanup ran: run the cleanup again');
        }
        const withChanges = order.filter(n => (byHole.get(n)?.changedPx ?? 0) > 0);
        const dir = this.jobDir(job.siteId, job.id);
        let result: CleanedImportResult;
        if (withChanges.length) {
            const overlay = path.join(dir, 'overlay.png');
            await this.golfpipe(['cleanup-compose', '--job', dir, '--holes', withChanges.join(','),
                '--size', String(CLEANED_PHOTO_SIZE), '--out', overlay]);
            // importImage takes the file it is handed and deletes it.
            const incoming = await this.cleanedPhoto.incomingImportPath(courseId);
            await copyFile(overlay, incoming);
            await rm(overlay, { force: true });
            result = await this.cleanedPhoto.importImage(courseId, incoming);
        } else {
            const info = await this.cleanedPhoto.info(courseId);
            result = { changed: false, changedPixels: 0, bounds3006: null, size: info.size, undoDepth: info.undoDepth, patchesGeneratedAt: info.patchesGeneratedAt };
        }
        job.applied = { at: new Date().toISOString(), holes: order, changedPixels: result.changedPixels, undoDepth: result.undoDepth };
        await this.save(job);
        return { job: this.public(job), import: result };
    }

    /** A cleaned hole's review image on disk (`review` = before and after side by side). 404 when it is not there. */
    async image(courseId: string, jobId: string, hole: number, kind: PhotoCleanupImage): Promise<string> {
        if (!PHOTO_CLEANUP_IMAGES.includes(kind)) throw new NotFoundError(`No image ${kind}`);
        const job = await this.stored(courseId, jobId);
        const file = path.join(this.jobDir(job.siteId, job.id), `h${hole}`, `${kind}.png`);
        if (!(await Bun.file(file).exists())) throw new NotFoundError(`Hole ${hole} has no ${kind} image in this cleanup`);
        return file;
    }

    // --- The run ---

    private async run(job: StoredJob, photoPath: string, regions: Record<number, string | null>): Promise<void> {
        const dir = this.jobDir(job.siteId, job.id);
        const work = path.join(dir, 'work.tif');
        try {
            await copyFile(photoPath, work);
            const weights = path.join(this.dataDir, 'models', 'big-lama.pt');
            const weightArgs = process.env.GOLFPIPE_LAMA_WEIGHTS || !(await Bun.file(weights).exists()) ? [] : ['--weights', weights];
            for (const h of job.holes) {
                h.status = 'running';
                job.step = `hole ${h.hole} (${job.holes.indexOf(h) + 1} of ${job.holes.length})`;
                const t0 = Date.now();
                try {
                    const region = regions[h.hole];
                    const out = await this.golfpipe(['cleanup-hole', '--work', work,
                        '--features', path.join(dir, 'inputs', 'features.geojson'),
                        '--areas', path.join(dir, 'inputs', 'areas.json'),
                        '--hole', String(h.hole), ...(region ? ['--region', region] : []),
                        '--out', path.join(dir, `h${h.hole}`), ...weightArgs]);
                    const doc = lastJson<{ scopePx: number; targetPx: number; changedPx: number; seconds: number; warnings: string[] }>(out);
                    Object.assign(h, { status: 'done', scopePx: doc.scopePx, targetPx: doc.targetPx, changedPx: doc.changedPx,
                        seconds: doc.seconds, warnings: doc.warnings ?? [] });
                } catch (err) {
                    // One hole failing leaves the others to be judged on their own.
                    Object.assign(h, { status: 'failed', error: (err as Error).message, seconds: Math.round((Date.now() - t0) / 100) / 10 });
                }
                await this.save(job);
            }
            job.status = 'succeeded';
            const done = job.holes.filter(h => h.status === 'done');
            job.step = `${done.length} of ${job.holes.length} holes cleaned; ${done.filter(h => h.changedPx > 0).length} changed`;
        } catch (err) {
            job.status = 'failed';
            job.error = (err as Error).message;
            job.step = `failed: ${job.error}`;
        } finally {
            job.finishedAt = new Date().toISOString();
            await rm(work, { force: true }).catch(() => {});
            await this.save(job).catch(() => {});
            this.running.delete(job.id);
            await this.prune(job.siteId).catch(() => {});
        }
    }

    /** The course's features as `cleanup-hole` reads them: WGS84, with their type and hole number. */
    private async features(courseId: string) {
        const rows = await this.db.selectFrom('course_features')
            .leftJoin('holes', 'holes.id', 'course_features.hole_id')
            .select(['course_features.type', 'course_features.geojson', 'holes.number as hole'])
            .where('course_features.course_id', '=', courseId)
            .where('course_features.geojson', 'is not', null)
            .execute();
        return {
            type: 'FeatureCollection',
            features: rows.map(r => ({
                type: 'Feature',
                properties: { type: r.type, ...(r.hole != null ? { hole: r.hole } : {}) },
                geometry: JSON.parse(r.geojson!),
            })),
        };
    }

    private async golfpipe(args: string[]): Promise<string> {
        const r = await this.runner(['-m', 'golfpipe', ...args], { cwd: this.pipelineDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        if (r.code !== 0) {
            const raw = (r.stderr || r.stdout || `exit code ${r.code}`).trim();
            throw new Error(`${args[0]} failed: ${raw.split(/\r?\n/).filter(l => !/Warning|warnings\.warn/.test(l)).slice(-3).join(' ').slice(-600)}`);
        }
        return r.stdout;
    }

    // --- Storage ---

    private jobsDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'photo-cleanup');
    }

    private jobDir(siteId: string, jobId: string): string {
        if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new NotFoundError(`No photo cleanup ${jobId}`);
        return path.join(this.jobsDir(siteId), jobId);
    }

    private async save(job: StoredJob): Promise<void> {
        const file = path.join(this.jobDir(job.siteId, job.id), 'job.json');
        await writeFile(`${file}.tmp`, JSON.stringify(job, null, 1));
        await rename(`${file}.tmp`, file);
    }

    private async siteId(courseId: string): Promise<string | null> {
        const course = await this.db.selectFrom('courses').select('site_id').where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        return course.site_id ?? null;
    }

    private async stored(courseId: string, jobId: string): Promise<StoredJob> {
        const live = this.running.get(jobId);
        if (live && live.courseId === courseId) return live;
        const siteId = await this.siteId(courseId);
        if (siteId) {
            try {
                const job = JSON.parse(await readFile(path.join(this.jobDir(siteId, jobId), 'job.json'), 'utf8')) as StoredJob;
                if (job.courseId === courseId) return this.settled(job);
            } catch (err) {
                if (err instanceof NotFoundError) throw err;
            }
        }
        throw new NotFoundError(`No photo cleanup ${jobId} for this course`);
    }

    /** A run stored as running that no process runs any more: the server stopped under it. */
    private settled(job: StoredJob): StoredJob {
        if (job.status !== 'running' || this.running.has(job.id)) return job;
        return { ...job, status: 'failed', error: 'The server stopped during this cleanup', step: 'failed: the server stopped during this cleanup',
            holes: job.holes.map(h => (h.status === 'running' || h.status === 'pending' ? { ...h, status: 'failed', error: 'not run' } : h)) };
    }

    /** The site's stored runs, newest first. */
    private async storedJobs(siteId: string): Promise<StoredJob[]> {
        let names: string[];
        try {
            names = await readdir(this.jobsDir(siteId));
        } catch {
            return [];
        }
        const jobs: StoredJob[] = [];
        for (const name of names) {
            try {
                jobs.push(this.settled(JSON.parse(await readFile(path.join(this.jobsDir(siteId), name, 'job.json'), 'utf8')) as StoredJob));
            } catch {
                // a folder without a readable job.json is no run
            }
        }
        return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }

    /** Keeps the newest KEEP_JOBS finished runs of the site. */
    private async prune(siteId: string): Promise<void> {
        const finished = (await this.storedJobs(siteId)).filter(j => !this.running.has(j.id));
        for (const old of finished.slice(KEEP_JOBS)) {
            await rm(this.jobDir(siteId, old.id), { recursive: true, force: true });
        }
    }

    private public(job: StoredJob): PhotoCleanupJob {
        const { siteId: _s, photoMtimeMs: _m, ...pub } = job;
        return structuredClone(pub);
    }
}

/** The JSON a golfpipe command prints last on stdout. */
function lastJson<T>(stdout: string): T {
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    try {
        return JSON.parse(line) as T;
    } catch {
        throw new Error(`printed no JSON result: ${line.slice(0, 200)}`);
    }
}
