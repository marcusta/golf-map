// The Vegetation mode's "Plant vegetation": one server job (GSPro export kind
// `vegetation`, GsproExportService.plantVegetation) that re-runs every
// vegetation generator (tall rough, creek banks, ...) over the course as it is
// drawn now, exports the zones, and imports them into the course's open Unity
// project. `plant` starts it (or re-attaches to the one already running) and
// follows it to the end; `job` drives the command bar button's running state.
//
// "Update in Unity" (`update`, kind `vegetation-update`,
// GsproExportService.updateZones) is the quick path for the selected zones:
// no generators, only the area those zones cover re-rasterized into the
// exported masks and respawned in Unity.
import { Computed, Signal } from '@basics/core/client/core';
import { api } from '../api';
import type { GsproExportApi, GsproExportJob } from '../../../shared/api/gspro-export.gen';

const DEFAULT_POLL_MS = 1500;

export class PlantVegetationService {
    /** The job being followed (running, or the one that just finished); null before the first. */
    readonly job = new Signal<GsproExportJob | null>(null);
    readonly running = new Computed(() => this.job.get()?.status === 'running');
    /** Which of the two jobs is running (for the buttons' labels); null when none. */
    readonly runningKind = new Computed(() => this.running.get() ? this.job.get()!.kind : null);

    constructor(
        private readonly client: GsproExportApi = api.gsproExport,
        private readonly pollMs = DEFAULT_POLL_MS,
    ) {}

    /** Plant the course's inner terrain and wait for the outcome (the finished job; throws when it could not start). */
    plant(courseId: string): Promise<GsproExportJob> {
        return this.follow(courseId, { kind: 'vegetation', terrain: 'inner' });
    }

    /** Update the zones `zoneIds` in Unity (every terrain with a zones export) and wait for the outcome. */
    update(courseId: string, zoneIds: string[]): Promise<GsproExportJob> {
        return this.follow(courseId, { kind: 'vegetation-update', zoneIds });
    }

    private async follow(courseId: string, request: { kind: 'vegetation' | 'vegetation-update'; terrain?: 'inner'; zoneIds?: string[] }): Promise<GsproExportJob> {
        let job: GsproExportJob;
        try {
            job = await this.client.start({ courseId, ...request });
        } catch (e) {
            // Another export runs for the course: follow it if it is the same kind of job, else say what blocks.
            const running = await this.client.current({ courseId }).catch(() => null);
            if (running?.status !== 'running' || running.kind !== request.kind) throw e;
            job = running;
        }
        this.job.set(job);
        while (job.status === 'running') {
            await new Promise(r => setTimeout(r, this.pollMs));
            job = await this.client.job({ jobId: job.id });
            this.job.set(job);
        }
        return job;
    }
}
