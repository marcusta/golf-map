// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Tee {
    id: string;
    holeId: string;
    name: string;
    color: null | string;
    lat: number;
    lon: number;
    elevation: null | number;
    sortOrder: number;
    version: number;
}

export interface TeesApi {
    listByHole(input: { holeId: string }): Promise<Tee[]>;
    listByCourse(input: { courseId: string }): Promise<Tee[]>;
    create(input: { color?: string; elevation?: number; name: string; holeId: string; lat: number; lon: number }): Promise<Tee>;
    update(input: { name?: string; color?: string; lat?: number; lon?: number; elevation?: number; id: string; version: number }): Promise<Tee>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    reorder(input: { orderedIds: string[]; holeId: string }): Promise<{ ok: boolean }>;
}

export function createTeesClient(baseUrl: string): TeesApi {
    return {
        async listByHole(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/tees${qs ? '?' + qs : ''}` });
        },
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/tees/by-course${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tees/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tees/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tees/remove`, body: input });
        },
        async reorder(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tees/reorder`, body: input });
        },
    };
}
