// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CourseCheckStatus {
    boundary: null | string;
    unity: null | CourseCheckSummary;
    blender: null | CourseCheckSummary;
    meshesChangedAt: null | string;
    meshesChangedSince: boolean;
    job: null | CourseCheckJob;
}

export interface CourseCheckJob {
    id: string;
    courseId: string;
    status: 'running' | 'succeeded' | 'failed';
    phase: null | string;
    step: string;
    phases: JobPhase[];
    startedAt: string;
    finishedAt: null | string;
    seconds: number;
    result: null | CourseCheckResult;
    error: null | string;
}

export interface CourseCheckSummary {
    layer: 'blender' | 'unity';
    report: string;
    at: string;
    ok: boolean;
    errors: number;
    warnings: number;
    area: null | string;
    hole: null | string;
    meshes: null | number;
    seconds: null | number;
    counts: CourseCheckCount[];
}

export interface JobPhase {
    id: string;
    label: string;
    status: 'running' | 'failed' | 'pending' | 'done' | 'skipped';
    detail: null | string;
    seconds: null | number;
}

export interface CourseCheckResult {
    boundary: CourseCheckBoundary;
    unity: null | CourseCheckLayerResult;
    unitySkipped: null | string;
    blender: null | CourseCheckLayerResult;
    blenderSkipped: null | string;
    warnings: string[];
}

export interface CourseCheckCount {
    type: string;
    findings: number;
    severity: string;
    points: null | number;
}

export interface CourseCheckBoundary {
    path: null | string;
    rings: number;
    points: number;
}

export interface CourseCheckLayerResult {
    findings: CourseCheckFinding[];
    layer: 'blender' | 'unity';
    report: string;
    at: string;
    ok: boolean;
    errors: number;
    warnings: number;
    area: null | string;
    hole: null | string;
    meshes: null | number;
    seconds: null | number;
    counts: CourseCheckCount[];
}

export interface CourseCheckFinding {
    type: string;
    severity: string;
    hole: null | string;
    note: null | string;
    objects: string[];
    unity: null | number[];
    epsg3006: null | number[];
}

export interface CourseCheckApi {
    status(input: { courseId: string }): Promise<CourseCheckStatus>;
    run(input: { hole?: string | number; cellM?: number; marginM?: number; blender?: boolean; courseId: string }): Promise<CourseCheckJob>;
    job(input: { jobId: string }): Promise<CourseCheckJob>;
}

export function createCourseCheckClient(baseUrl: string): CourseCheckApi {
    return {
        async status(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/course-check/status${qs ? '?' + qs : ''}` });
        },
        async run(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-check/run`, body: input });
        },
        async job(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/course-check/job${qs ? '?' + qs : ''}` });
        },
    };
}
