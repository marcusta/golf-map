// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface ShapingRecipe {
    id: string;
    name: string;
    file: string;
    author: string;
    surfaces: ('bunker' | 'lake' | 'creek' | 'path')[];
    default?: boolean;
    notes?: string;
    params: RecipeParam[];
}

export interface ShapingJob {
    id: string;
    courseId: string;
    runId: null | string;
    queued: boolean;
    note: null | string;
    slice: null | RequestSlice;
    status: 'running' | 'succeeded' | 'failed';
    phase: null | 'blender' | 'unity' | 'vegetation' | 'layers' | 'worker';
    step: string;
    phases: ShapingPhase[];
    dryRun: boolean;
    startedAt: string;
    finishedAt: null | string;
    seconds: number;
    result: null | ShapingApplyResult;
    error: null | string;
}

export interface ShapingStatus {
    worker: ShapingWorkerStatus;
    job: null | ShapingJob;
}

export interface RecipeParam {
    id: string;
    label: string;
    unit?: string;
    min: number;
    max: number;
    step?: number;
    default: number;
}

export interface RequestSlice {
    whole: boolean;
    changedObjects: string[];
    places: unknown[];
    warnings: string[];
    overlaps: string[];
}

export interface ShapingPhase {
    id: 'blender' | 'unity' | 'vegetation' | 'layers' | 'worker';
    label: string;
    status: 'running' | 'failed' | 'pending' | 'done' | 'skipped';
    detail: null | string;
    seconds: null | number;
}

export interface ShapingApplyResult {
    changedObjects: string[];
    exported: string[];
    removed: string[];
    warnings: string[];
    places: unknown[];
    seams: null | ShapingSeams;
    gates: null | ShapingGates;
    unityReport: unknown;
    pathSurfaces: string[];
    pathMaterials: unknown;
    unitySteps: ShapingUnityStep[];
    unityError: null | string;
    vegetation: string[];
    layers: string[];
    blend: string;
    layersDir: string;
    fbxFolder: null | string;
    dryRun: boolean;
    seconds: number;
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

export interface ShapingSeams {
    toleranceXY: number;
    gapDz: number;
    pairsChecked: number;
    gaps: ShapingSeamGap[];
    newGaps: number;
    unmatchedBoundaryChanged: Record<string, { before: number; after: number; }>;
    tJunctions?: ShapingTJunctionCheck;
}

export interface ShapingGates {
    ok: boolean;
    allowGaps: boolean;
    limits: { gapM: number; tJunctionM: number };
    failures: ShapingGateFinding[];
    preExisting: ShapingGateFinding[];
    warnings: string[];
}

export interface ShapingUnityStep {
    id: string;
    status: string;
    seconds: null | number;
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

export interface ShapingSeamGap {
    objects: string[];
    vertices: number;
    gaps: number;
    maxAbsDz: number;
    at?: number[];
    new: boolean;
    gapsBefore: number;
}

export interface ShapingTJunctionCheck {
    toleranceXY: number;
    objects: Record<string, { vertices: number; onEdge: number; gaps: number; maxAbsDz: number; at?: number[] | undefined; }>;
    gaps: number;
    maxAbsDz: number;
}

export interface ShapingGateFinding {
    type: 'seamGap' | 'tJunction' | 'flipped' | 'nan';
    objects: string[];
    maxAbsDz?: number;
    points?: number;
    faces?: null | number;
    note?: string;
    blend?: number[];
    epsg3006?: number[];
}

export interface ShapingApi {
    recipes(input: { surface?: 'bunker' | 'lake' | 'creek' | 'path' }): Promise<ShapingRecipe[]>;
    apply(input: { note?: string; featureIds?: string[]; dryRun?: boolean; skipUnity?: boolean; paths?: boolean; courseId: string }): Promise<ShapingJob>;
    status(input: { courseId: string }): Promise<ShapingStatus>;
    job(input: { jobId: string }): Promise<ShapingJob>;
}

export function createShapingClient(baseUrl: string): ShapingApi {
    return {
        async recipes(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/shaping/recipes${qs ? '?' + qs : ''}` });
        },
        async apply(input) {
            const pathParams = new Set(['courseId']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/shaping/apply`, body });
        },
        async status(input) {
            const pathParams = new Set(['courseId']);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k) && v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/${input.courseId}/shaping/status${qs ? '?' + qs : ''}` });
        },
        async job(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/shaping/job${qs ? '?' + qs : ''}` });
        },
    };
}
