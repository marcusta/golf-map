import * as path from 'node:path';
import { statSync } from 'node:fs';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { preflight, buildBundle, packBundle, uploadBundle } from '../scripts/publish';

export type PublishStep = 'preflight' | 'bundle' | 'pack' | 'upload';
export type PublishStatus = 'idle' | 'running' | 'succeeded' | 'failed';

export interface PublishState {
    status: PublishStatus;
    step: PublishStep | null;
    siteId: string | null;
    courseId: string | null;
    warnings: string[];
    /** Packed bundle size in bytes, known once packing finishes. */
    bundleBytes: number | null;
    error: string | null;
    /** True when PUBLISH_URL + PUBLISH_TOKEN are set on this box. */
    configured: boolean;
    /** Target host (origin only, no token) for the confirm UI; null when unconfigured. */
    targetUrl: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}

interface PublishRunnerDeps {
    preflight: typeof preflight;
    buildBundle: typeof buildBundle;
    packBundle: typeof packBundle;
    uploadBundle: typeof uploadBundle;
}

/**
 * Publish-to-VPS as a builder API (UI face of `scripts/publish.ts`): one
 * in-memory job at a time, driven by the same exported preflight/bundle/pack/
 * upload steps as the CLI. State is in-memory only — a builder restart forgets
 * a finished run, which is fine: the VPS ingest is atomic, so there is nothing
 * to reconcile, and the UI polls live state only while a run is in flight.
 */
export class PublishService {
    private state: PublishState = {
        status: 'idle',
        step: null,
        siteId: null,
        courseId: null,
        warnings: [],
        bundleBytes: null,
        error: null,
        configured: false,
        targetUrl: null,
        startedAt: null,
        finishedAt: null,
    };

    constructor(
        private deps: { db: Kysely<Database>; dataDir: string },
        private runner: PublishRunnerDeps = { preflight, buildBundle, packBundle, uploadBundle },
    ) {}

    status(): PublishState {
        const url = process.env.PUBLISH_URL ?? null;
        return {
            ...this.state,
            configured: !!url && !!process.env.PUBLISH_TOKEN,
            targetUrl: url,
        };
    }

    /**
     * Kick a publish for the course's site. Resolves as soon as the job is
     * accepted (poll `status()` for progress). Throws on: unknown course,
     * missing PUBLISH_URL/PUBLISH_TOKEN, or a publish already running.
     */
    async start(courseId: string): Promise<PublishState> {
        if (this.state.status === 'running') {
            throw new Error('A publish is already running — wait for it to finish.');
        }
        const url = process.env.PUBLISH_URL;
        const token = process.env.PUBLISH_TOKEN;
        if (!url || !token) {
            throw new Error('PUBLISH_URL and PUBLISH_TOKEN are not set on this builder — configure them and restart the server.');
        }
        const course = await this.deps.db
            .selectFrom('courses')
            .select(['id', 'site_id'])
            .where('id', '=', courseId)
            .executeTakeFirst();
        if (!course) throw new Error(`Course ${courseId} not found`);
        const siteId = course.site_id ?? course.id;

        this.state = {
            status: 'running',
            step: 'preflight',
            siteId,
            courseId,
            warnings: [],
            bundleBytes: null,
            error: null,
            configured: true,
            targetUrl: url,
            startedAt: new Date().toISOString(),
            finishedAt: null,
        };
        void this.run(siteId, url, token);
        return this.status();
    }

    private async run(siteId: string, url: string, token: string): Promise<void> {
        const outDir = path.join(this.deps.dataDir, 'publish');
        try {
            const pfWarnings = await this.runner.preflight(this.deps, siteId);
            this.state.warnings.push(...pfWarnings);

            this.state.step = 'bundle';
            const { stagingDir, warnings } = await this.runner.buildBundle(this.deps, { siteId, outDir });
            this.state.warnings.push(...warnings);

            this.state.step = 'pack';
            const bundlePath = path.join(outDir, `${siteId}.tar.zst`);
            await this.runner.packBundle(stagingDir, bundlePath);
            this.state.bundleBytes = statSync(bundlePath).size;

            this.state.step = 'upload';
            await this.runner.uploadBundle(bundlePath, url, token);

            this.state.status = 'succeeded';
        } catch (err) {
            this.state.status = 'failed';
            this.state.error = err instanceof Error ? err.message : String(err);
        } finally {
            this.state.step = this.state.status === 'succeeded' ? null : this.state.step;
            this.state.finishedAt = new Date().toISOString();
        }
    }
}
