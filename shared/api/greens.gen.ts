// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Green {
    id: string;
    holeId: string;
    boundaryJson: null | string;
    centerLat: number;
    centerLon: number;
    frontLat: null | number;
    frontLon: null | number;
    backLat: null | number;
    backLon: null | number;
    elevation: null | number;
    version: number;
}

export interface GreensApi {
    getByHole(input: { holeId: string }): Promise<null | Green>;
    create(input: { elevation?: number; frontLat?: number; frontLon?: number; backLat?: number; backLon?: number; boundaryJson?: string; holeId: string; centerLat: number; centerLon: number }): Promise<Green>;
    update(input: { elevation?: number; centerLat?: number; centerLon?: number; frontLat?: number; frontLon?: number; backLat?: number; backLon?: number; boundaryJson?: string; id: string; version: number }): Promise<Green>;
}

export function createGreensClient(baseUrl: string): GreensApi {
    return {
        async getByHole(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/greens${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/greens/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/greens/update`, body: input });
        },
    };
}
