// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface OrthoPatchResult {
    count: number;
    patchesGeneratedAt: string;
}

export interface OrthoPatchesInfo {
    count: number;
    lastCreatedAt: null | string;
    lastTool: null | string;
    bakeable: boolean;
    stampBakeable: boolean;
    reason?: string;
    patchesGeneratedAt: null | string;
}

export interface OrthoPatchesApi {
    applyOrthoEdits(input: { courseId: string; edits: ({ kind: 'mask'; maskPngBase64: string; bounds3857: { west: number; south: number; east: number; north: number }; boundsSweref: { west: number; south: number; east: number; north: number }; tool: string } | { kind: 'stamp'; bounds3857: { west: number; south: number; east: number; north: number }; boundsSweref: { west: number; south: number; east: number; north: number }; brush: { sizeM: number; opacity: number; flow: number; hardness: number }; offsetM: { dx: number; dy: number }; path: { x: number; y: number }[]; aligned: boolean; toneMatch: boolean })[] }): Promise<OrthoPatchResult>;
    revertLastOrthoPatch(input: { courseId: string }): Promise<OrthoPatchResult>;
    orthoPatchesInfo(input: { courseId: string }): Promise<OrthoPatchesInfo>;
}

export function createOrthoPatchesClient(baseUrl: string): OrthoPatchesApi {
    return {
        async applyOrthoEdits(input) {
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
