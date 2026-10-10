// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CleanupAreasApi {
    cleanupAreas(input: { courseId: string }): Promise<{ siteId: string; version: number; areas: ({ id: string; name: string; kind: 'include' | 'force' | 'exclude'; ring: [number, number][] })[] }>;
    saveCleanupAreas(input: { version: number; courseId: string; areas: ({ id: string; kind: 'include' | 'force' | 'exclude'; name: string; ring: [number, number][] })[] }): Promise<{ siteId: string; version: number; areas: ({ id: string; name: string; kind: 'include' | 'force' | 'exclude'; ring: [number, number][] })[] }>;
    exportCleanupArea(input: { courseId: string }): Promise<{ type: 'FeatureCollection'; features: ({ type: 'Feature'; properties: { type: 'cleanup' | 'cleanup-force'; siteId: string; version: number }; geometry: { type: 'MultiPolygon'; coordinates: [number, number][][][] } })[] }>;
}

export function createCleanupAreasClient(baseUrl: string): CleanupAreasApi {
    return {
        async cleanupAreas(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/cleanup-areas${qs ? '?' + qs : ''}` });
        },
        async saveCleanupAreas(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/cleanup-areas`, body: input });
        },
        async exportCleanupArea(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/cleanup-areas/export${qs ? '?' + qs : ''}` });
        },
    };
}
