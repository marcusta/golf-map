// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface MakeReadyStatus {
    last: null | MakeReadySummary;
    job: null | MakeReadyJob;
}

export interface MakeReadyJob {
    id: string;
    courseId: string;
    status: 'running' | 'succeeded' | 'failed';
    phase: null | string;
    step: string;
    phases: JobPhase[];
    startedAt: string;
    finishedAt: null | string;
    seconds: number;
    result: null | MakeReadyResult;
    error: null | string;
}

export interface MakeReadySummary {
    at: string;
    ready: boolean;
    blockers: string[];
    errors: number;
    warnings: number;
    fixed: number;
    fix: boolean;
    marginM: number;
    categories: MakeReadyCategory[];
    unity: MakeReadyUnityPart;
    arborist: MakeReadyArboristPart;
    check: MakeReadyCheckPart;
}

export interface JobPhase {
    id: string;
    label: string;
    status: 'running' | 'failed' | 'pending' | 'done' | 'skipped';
    detail: null | string;
    seconds: null | number;
}

export interface MakeReadyResult {
    findings: MakeReadyFinding[];
    fixes: MakeReadyFix[];
    file: string;
    at: string;
    ready: boolean;
    blockers: string[];
    errors: number;
    warnings: number;
    fixed: number;
    fix: boolean;
    marginM: number;
    categories: MakeReadyCategory[];
    unity: MakeReadyUnityPart;
    arborist: MakeReadyArboristPart;
    check: MakeReadyCheckPart;
}

export interface MakeReadyCategory {
    layer: 'unity' | 'arborist';
    category: string;
    objects: number;
    near: number;
    ok: number;
    fixed: number;
    findings: number;
}

export interface MakeReadyUnityPart {
    skipped: null | string;
    report: null | string;
    errors: number;
    warnings: number;
    fixed: number;
}

export interface MakeReadyArboristPart {
    skipped: null | string;
    file: null | string;
    instances: number;
    errors: number;
    warnings: number;
}

export interface MakeReadyCheckPart {
    skipped: null | string;
    source: null | 'run' | 'report';
    at: null | string;
    report: null | string;
    errors: number;
    warnings: number;
}

export interface MakeReadyFinding {
    layer: 'unity' | 'arborist';
    category: string;
    severity: 'error' | 'warn' | 'info';
    objects: string[];
    note: null | string;
    unity: null | number[];
    epsg3006: null | number[];
}

export interface MakeReadyFix {
    object: string;
    what: string;
}

export interface MakeReadyApi {
    status(input: { courseId: string }): Promise<MakeReadyStatus>;
    run(input: { marginM?: number; fix?: boolean; courseId: string }): Promise<MakeReadyJob>;
    job(input: { courseId: string; jobId: string }): Promise<MakeReadyJob>;
}

export function createMakeReadyClient(baseUrl: string): MakeReadyApi {
    return {
        async status(input) {
            const pathParams = new Set(['courseId']);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k) && v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/${input.courseId}/make-ready/status${qs ? '?' + qs : ''}` });
        },
        async run(input) {
            const pathParams = new Set(['courseId']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/make-ready/run`, body });
        },
        async job(input) {
            const pathParams = new Set(['courseId']);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k) && v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/${input.courseId}/make-ready/job${qs ? '?' + qs : ''}` });
        },
    };
}
