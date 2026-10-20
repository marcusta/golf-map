// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GsproSyncStatus {
    unity: GsproSyncUnity;
    worker: ShapingWorkerStatus;
    targets: GsproTargetStatus[];
    job: null | GsproSyncJob;
    queue: ({ id: string; target: 'trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file' | 'stale' })[];
}

export interface GsproSyncJob {
    id: string;
    courseId: string;
    request: 'trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file' | 'stale';
    targets: ('trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file')[];
    status: 'running' | 'succeeded' | 'failed' | 'queued';
    phase: null | string;
    step: string;
    phases: JobPhase[];
    queuedAt: string;
    startedAt: null | string;
    finishedAt: null | string;
    seconds: number;
    results: GsproSyncTargetResult[];
    error: null | string;
}

export interface GsproSyncUnity {
    editors: UnityEditorInfo[];
    matched: null | string;
    exportDir: string;
}

export interface ShapingWorkerStatus {
    url: string;
    reachable: boolean;
    state: null | string;
    phase: null | string;
    blend: null | string;
    conformed: null | string;
    layersDir: null | string;
    appliedOps: unknown;
    lastRun: unknown;
    job: null | ShapingWorkerJob;
    error: null | string;
    spawnedPid: null | number;
    log: null | string;
}

export interface GsproTargetStatus {
    id: 'trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file';
    label: string;
    lastRun: null | string;
    seconds: null | number;
    changedSince: ChangeCount;
    stale: boolean;
    manual: null | string;
    blocked: null | string;
    note: null | string;
    builds: ExportBuild[];
}

export interface JobPhase {
    id: string;
    label: string;
    status: 'running' | 'failed' | 'pending' | 'done' | 'skipped';
    detail: null | string;
    seconds: null | number;
}

export interface GsproSyncTargetResult {
    target: 'trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file';
    label: string;
    seconds: number;
    report: string[];
    error: null | string;
}

export interface UnityEditorInfo {
    projectName: string;
    projectPath: string;
    activeCourse: null | string;
    exportFolder: null | string;
    courseFolder: null | string;
    matches: boolean;
    error: null | string;
}

export interface ShapingWorkerJob {
    id: string;
    kind: null | string;
    state: string;
    phase: null | string;
    startedAt: null | string;
    seconds: null | number;
    result: unknown;
    error: null | string;
}

export interface ChangeCount {
    count: number;
    kinds: string[];
}

export interface ExportBuild {
    snapshot: string;
    outcome: null | 'failed' | 'pending' | 'ok';
    opcdCreated: null | string;
    status: null | string;
    lastGood: boolean;
}

export interface GsproSyncApi {
    status(input: { courseId: string }): Promise<GsproSyncStatus>;
    update(input: { force?: boolean; courseId: string; target: 'trees' | 'buildings' | 'vegetation' | 'creeks' | 'waterfalls' | 'terrain' | 'photo' | 'shapes' | 'meshes' | 'props' | 'roads' | 'course-file' | 'stale' }): Promise<GsproSyncJob>;
    job(input: { jobId: string }): Promise<GsproSyncJob>;
    editors(input: { courseId: string }): Promise<GsproSyncUnity>;
}

export function createGsproSyncClient(baseUrl: string): GsproSyncApi {
    return {
        async status(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-sync/status${qs ? '?' + qs : ''}` });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-sync/update`, body: input });
        },
        async job(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-sync/job${qs ? '?' + qs : ''}` });
        },
        async editors(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/unity/editors${qs ? '?' + qs : ''}` });
        },
    };
}
