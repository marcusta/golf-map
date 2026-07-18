// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface OrthoPatchResult {
    count: number;
    generatedAt: string;
}

export interface OrthoPatchesInfo {
    count: number;
    lastCreatedAt: null | string;
    lastTool: null | string;
    bakeable: boolean;
    reason?: string;
}

export interface OrthoPatchesApi {
    applyOrthoPatch(input: { courseId: string; pngBase64: string; bounds3857: { west: number; south: number; east: number; north: number }; boundsSweref: { west: number; south: number; east: number; north: number }; tool: string }): Promise<OrthoPatchResult>;
    revertLastOrthoPatch(input: { courseId: string }): Promise<OrthoPatchResult>;
    orthoPatchesInfo(input: { courseId: string }): Promise<OrthoPatchesInfo>;
}

export function createOrthoPatchesClient(baseUrl: string): OrthoPatchesApi {
    return {
        async applyOrthoPatch(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/ortho-patches/apply`, body: input });
        },
        async revertLastOrthoPatch(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/ortho-patches/revert-last`, body: input });
        },
        async orthoPatchesInfo(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/ortho-patches/info${qs ? '?' + qs : ''}` });
        },
    };
}
