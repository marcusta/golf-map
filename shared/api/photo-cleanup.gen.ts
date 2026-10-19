// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PhotoCleanupJob {
    id: string;
    courseId: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: null | string;
    holes: PhotoCleanupHole[];
    step: string;
    error: null | string;
    applied: null | PhotoCleanupApplied;
}

export interface PhotoCleanupApplyResult {
    job: PhotoCleanupJob;
    import: { changed: boolean; changedPixels: number; bounds3006: null | { west: number; south: number; east: number; north: number }; size: number; undoDepth: number; patchesGeneratedAt: null | string };
}

export interface PhotoCleanupHole {
    hole: number;
    status: 'running' | 'failed' | 'pending' | 'done';
    scopePx: number;
    targetPx: number;
    changedPx: number;
    seconds: null | number;
    warnings: string[];
    error: null | string;
}

export interface PhotoCleanupApplied {
    at: string;
    holes: number[];
    changedPixels: number;
    undoDepth: number;
}

export interface PhotoCleanupApi {
    startPhotoCleanup(input: { holes?: number[]; courseId: string }): Promise<PhotoCleanupJob>;
    photoCleanupJob(input: { courseId: string; jobId: string }): Promise<PhotoCleanupJob>;
    currentPhotoCleanup(input: { courseId: string }): Promise<{ job: null | PhotoCleanupJob }>;
    applyPhotoCleanup(input: { courseId: string; jobId: string; holes: number[] }): Promise<PhotoCleanupApplyResult>;
}

export function createPhotoCleanupClient(baseUrl: string): PhotoCleanupApi {
    return {
        async startPhotoCleanup(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photo-cleanup`, body: input });
        },
        async photoCleanupJob(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/photo-cleanup/job${qs ? '?' + qs : ''}` });
        },
        async currentPhotoCleanup(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/photo-cleanup/current${qs ? '?' + qs : ''}` });
        },
        async applyPhotoCleanup(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photo-cleanup/apply`, body: input });
        },
    };
}
