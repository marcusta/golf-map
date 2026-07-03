// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface AimPoint {
    id: string;
    holeId: string;
    sortOrder: number;
    lat: number;
    lon: number;
    elevation: null | number;
    label: null | string;
    version: number;
}

export interface AimPointsApi {
    listByHole(input: { holeId: string }): Promise<AimPoint[]>;
    create(input: { elevation?: number; label?: string; holeId: string; lat: number; lon: number }): Promise<AimPoint>;
    update(input: { lat?: number; lon?: number; elevation?: number; label?: string; id: string; version: number }): Promise<AimPoint>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    reorder(input: { orderedIds: string[]; holeId: string }): Promise<{ ok: boolean }>;
}

export function createAimPointsClient(baseUrl: string): AimPointsApi {
    return {
        async listByHole(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/aim-points${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/aim-points/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/aim-points/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/aim-points/remove`, body: input });
        },
        async reorder(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/aim-points/reorder`, body: input });
        },
    };
}
