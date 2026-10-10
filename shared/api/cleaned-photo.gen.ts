// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CleanedPhotoResult {
    undoDepth: number;
    patchesGeneratedAt: string;
}

export interface CleanedPhotoInfo {
    exists: boolean;
    undoDepth: number;
    size: number;
    bounds3006: null | PhotoBounds;
    reason?: string;
    patchesGeneratedAt: null | string;
}

export interface PhotoBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface CleanedPhotoApi {
    undoPhotoChange(input: { courseId: string }): Promise<CleanedPhotoResult>;
    cleanedPhotoInfo(input: { courseId: string }): Promise<CleanedPhotoInfo>;
}

export function createCleanedPhotoClient(baseUrl: string): CleanedPhotoApi {
    return {
        async undoPhotoChange(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/cleaned-photo/undo`, body: input });
        },
        async cleanedPhotoInfo(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/cleaned-photo/info${qs ? '?' + qs : ''}` });
        },
    };
}
