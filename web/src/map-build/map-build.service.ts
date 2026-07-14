import { Signal } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { MapBuildApi, MapBuildJob, Bbox } from '../../../shared/api/map-build.gen';

export type { MapBuildJob, Bbox };

/** Ordered pipeline steps — mirrors the server's BUILD_STEPS, drives the progress UI. */
export const BUILD_STEPS = [
    'fetch-lidar', 'grid-dem', 'fetch-ortho', 'tile-ortho', 'tile-terrain', 'tile-hillshade', 'manifest', 'install', 'register',
] as const;

export type BuildStep = (typeof BUILD_STEPS)[number];

/** Human labels for each pipeline step. */
export const STEP_LABELS: Record<BuildStep, string> = {
    'fetch-lidar': 'Fetch lidar (Laserdata Skog)',
    'grid-dem': 'Grid DEM from lidar',
    'fetch-ortho': 'Fetch orthophoto',
    'tile-ortho': 'Tile orthophoto',
    'tile-terrain': 'Tile terrain',
    'tile-hillshade': 'Tile hillshade',
    'manifest': 'Write manifest',
    'install': 'Install tiles',
    'register': 'Register assets',
};

const POLL_MS = 1500;

/**
 * Drives a server-side map build for one course: starts it, then polls status
 * until it reaches a terminal state. The `job` signal feeds the progress UI.
 */
export class MapBuildClientService {
    readonly job = new Signal<MapBuildJob | null>(null);
    readonly starting = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** Collection currently being tiled on-demand (drives the vintage button "preparing" state), or null. */
    readonly ensuringOrtho = new Signal<string | null>(null);

    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(private mapBuildApi: MapBuildApi = api.mapBuild) {}

    /** Load the latest build for a course (to preseed status/bbox), without starting one. */
    async loadLatest(courseId: string): Promise<MapBuildJob | null> {
        const latest = await request(this.starting, this.error, () => this.mapBuildApi.latest({ courseId }));
        if (latest) this.job.set(latest);
        return latest ?? null;
    }

    /** Start a build and begin polling. Resolves once the job is created (not finished). */
    async start(courseId: string, bbox: Bbox): Promise<void> {
        this.stop();
        const job = await request(this.starting, this.error, () => this.mapBuildApi.start({ courseId, bbox }));
        if (!job) return; // error signal set
        this.job.set(job);
        if (!isTerminal(job)) this.beginPolling(job.id);
    }

    /**
     * Ensure a vintage's ortho tiles exist on the server (tiled on-demand the
     * first time, then cached). Resolves `true` once tiling has succeeded (or
     * was already done), `false` on failure. Runs independently of the build
     * `job` signal so it doesn't disturb the build-progress UI. The actual
     * vintage switch is a client-side layer toggle the caller does on success.
     */
    async ensureOrtho(courseId: string, collection: string): Promise<boolean> {
        this.ensuringOrtho.set(collection);
        try {
            let job: MapBuildJob;
            try {
                job = await this.mapBuildApi.ensureOrtho({ courseId, collection });
            } catch {
                return false;
            }
            while (!isTerminal(job)) {
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                try {
                    job = await this.mapBuildApi.status({ jobId: job.id });
                } catch {
                    // Transient poll failure — keep polling.
                }
            }
            return job.status === 'succeeded';
        } finally {
            this.ensuringOrtho.set(null);
        }
    }

    private beginPolling(jobId: string): void {
        this.timer = setInterval(() => void this.poll(jobId), POLL_MS);
    }

    private async poll(jobId: string): Promise<void> {
        try {
            const job = await this.mapBuildApi.status({ jobId });
            this.job.set(job);
            if (isTerminal(job)) this.stop();
        } catch {
            // Transient poll failure — keep polling; a persistent failure will surface via the job row.
        }
    }

    /** Stop polling (call on component teardown). */
    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

export function isTerminal(job: MapBuildJob): boolean {
    return job.status === 'succeeded' || job.status === 'failed';
}
