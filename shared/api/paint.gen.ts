// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PaintList {
    courseId: string;
    file: string;
    exists: boolean;
    rules: PaintRule[];
    strokes: PaintStroke[];
    lakebed: null | Record<string, unknown>;
    layerLive: boolean;
}

export interface PaintChangeResult {
    courseId: string;
    action: 'stroke' | 'rule' | 'disable' | 'remove';
    id: string;
    dryRun: boolean;
    saved: boolean;
    file: string;
    layer: { written: boolean; path: null | string; ops: null | number; note: string };
    preview: PaintPreviewReport;
    sync: null | { jobId: string; status: 'running' | 'succeeded' | 'failed' };
    warnings: string[];
}

export interface PaintRule {
    id: string;
    kind: 'object' | 'road' | 'edge';
    enabled?: boolean;
}

export interface PaintStroke {
    id: string;
    geometry: 'line' | 'polygon' | 'circle';
    points3006?: [number, number][];
    centre3006?: [number, number];
    radiusM?: number;
    widthM?: number;
    featherM?: number;
    channel: 'red' | 'green' | 'blue' | 'black';
    strength?: number;
    mode?: 'replace' | 'overlay';
    surfaces?: string[];
    match?: string;
    enabled?: boolean;
}

export interface PaintPreviewReport {
    status: 'failed' | 'skipped' | 'shown';
    note: null | string;
    within: null | number[];
    meshes: number;
    previewed: string[];
    cleared: string[];
    skipped: { object: string; why: string }[];
}

export interface PaintApi {
    list(input: { courseId: string }): Promise<PaintList>;
    stroke(input: { dryRun?: boolean; sync?: boolean; courseId: string; stroke: { id?: string; widthM?: number; mode?: 'replace' | 'overlay'; points3006?: [number, number][]; centre3006?: [number, number]; radiusM?: number; featherM?: number; strength?: number; surfaces?: string[]; match?: string; enabled?: boolean; geometry: 'line' | 'polygon' | 'circle'; channel: 'red' | 'green' | 'blue' | 'black' } }): Promise<PaintChangeResult>;
    rule(input: { dryRun?: boolean; sync?: boolean; within?: [number, number, number, number]; courseId: string; rule: { [x: string]: unknown; } }): Promise<PaintChangeResult>;
    disable(input: { dryRun?: boolean; sync?: boolean; id: string; courseId: string }): Promise<PaintChangeResult>;
    remove(input: { id: string; courseId: string }): Promise<PaintChangeResult>;
}

export function createPaintClient(baseUrl: string): PaintApi {
    return {
        async list(input) {
            const pathParams = new Set(['courseId']);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k) && v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/${input.courseId}/paint${qs ? '?' + qs : ''}` });
        },
        async stroke(input) {
            const pathParams = new Set(['courseId']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/paint/strokes`, body });
        },
        async rule(input) {
            const pathParams = new Set(['courseId']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/paint/rules`, body });
        },
        async disable(input) {
            const pathParams = new Set(['courseId', 'id']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/paint/items/${input.id}/disable`, body });
        },
        async remove(input) {
            return apiFetch({ method: 'DELETE', url: `${baseUrl}/courses/${input.courseId}/paint/items/${input.id}` });
        },
    };
}
