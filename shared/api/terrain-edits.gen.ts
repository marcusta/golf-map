// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface TerrainEdit {
    id: string;
    siteId: string;
    op: 'plane' | 'smooth';
    params: TerrainEditParams;
    rings: { x: number; y: number }[][];
    enabled: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface TerrainEditParams {
    featherM: number;
    radiusM?: number;
    flat?: boolean;
}

export interface TerrainEditsApi {
    list(input: { siteId: string }): Promise<TerrainEdit[]>;
    create(input: { enabled?: boolean; params: { flat?: boolean; radiusM?: number; featherM: number }; rings: { x: number; y: number }[][]; siteId: string; op: 'plane' | 'smooth' }): Promise<TerrainEdit>;
    update(input: { params?: { flat?: boolean; radiusM?: number; featherM: number }; rings?: { x: number; y: number }[][]; op?: 'plane' | 'smooth'; enabled?: boolean; id: string; version: number }): Promise<TerrainEdit>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createTerrainEditsClient(baseUrl: string): TerrainEditsApi {
    return {
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/terrain-edits${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/remove`, body: input });
        },
    };
}
