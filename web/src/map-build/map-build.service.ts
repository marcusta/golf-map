import { Signal } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { MapBuildApi, MapBuildJob, Bbox, LidarInfo } from '../../../shared/api/map-build.gen';

export type { MapBuildJob, Bbox, LidarInfo };

/** Human-readable size for lidar totals (e.g. "1.4 GB", "820 MB", "512 KB"). */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** Ordered pipeline steps — mirrors the server's BUILD_STEPS, drives the progress UI. */
export const BUILD_STEPS = [
    'fetch-lidar', 'grid-dem', 'apply-dem-edits', 'fetch-ortho', 'tile-ortho', 'tile-terrain', 'tile-hillshade', 'manifest', 'install', 'register',
] as const;

/** Ordered steps of the fast re-terrain job — mirrors the server's RE_TERRAIN_STEPS. */
export const RE_TERRAIN_STEPS = [
    'apply-dem-edits', 'tile-terrain', 'tile-hillshade', 'install', 'manifest', 'register',
] as const;

/** Ordered steps of the tree regeneration job — mirrors the server's TREES_STEPS. */
export const TREES_STEPS = ['canopy', 'trees-stems', 'register'] as const;

export type BuildStep = (typeof BUILD_STEPS)[number] | (typeof RE_TERRAIN_STEPS)[number] | (typeof TREES_STEPS)[number];

/** The ordered step list a job of `kind` walks through (drives the progress UI). */
export function stepsForKind(kind: MapBuildJob['kind']): readonly BuildStep[] {
    if (kind === 're-terrain') return RE_TERRAIN_STEPS;
    if (kind === 'trees') return TREES_STEPS;
    return BUILD_STEPS;
}

/** Human labels for each pipeline step. */
export const STEP_LABELS: Record<BuildStep, string> = {
    'fetch-lidar': 'Fetch lidar (Laserdata Skog)',
    'grid-dem': 'Grid DEM from lidar',
    'apply-dem-edits': 'Apply terrain edits',
    'fetch-ortho': 'Fetch orthophoto',
    'tile-ortho': 'Tile orthophoto',
    'tile-terrain': 'Tile terrain',
    'tile-hillshade': 'Tile hillshade',
    'manifest': 'Write manifest',
    'install': 'Install tiles',
    'register': 'Register assets',
    'canopy': 'Canopy tiles from lidar',
    'trees-stems': 'Detect tree stems',
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
    /** Label of the running tree-regeneration step, or null when idle. */
    readonly treesStep = new Signal<string | null>(null);

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

    /**
     * Regenerate the lidar tree layers (canopy tiles + tree-stems asset) for
     * a course and wait for the job to finish. Runs independently of the
     * build `job` signal like `ensureOrtho`; `treesStep` carries the running
     * step label for the caller's progress line. Resolves the terminal job.
     */
    async regenerateTrees(courseId: string): Promise<MapBuildJob> {
        let job = await this.mapBuildApi.reTrees({ courseId });
        this.treesStep.set(job.step ? STEP_LABELS[job.step] : 'Starting');
        try {
            while (!isTerminal(job)) {
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                try {
                    job = await this.mapBuildApi.status({ jobId: job.id });
                    if (job.step) this.treesStep.set(STEP_LABELS[job.step]);
                } catch {
                    // Transient poll failure — keep polling.
                }
            }
            return job;
        } finally {
            this.treesStep.set(null);
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

    /** List the persisted lidar (.laz) source files for a course. */
    async lidarInfo(courseId: string): Promise<LidarInfo> {
        return this.mapBuildApi.lidarInfo({ courseId });
    }

    /** Delete a course's persisted lidar files (explicit user action); returns bytes freed. */
    async deleteLidar(courseId: string): Promise<{ freedBytes: number }> {
        return this.mapBuildApi.deleteLidar({ courseId });
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
