// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Pin {
    id: string;
    greenId: string;
    name: string;
    lat: number;
    lon: number;
    difficulty: null | string;
    active: boolean;
    version: number;
}

export interface PinsApi {
    listByGreen(input: { greenId: string }): Promise<Pin[]>;
    listByCourse(input: { courseId: string }): Promise<Pin[]>;
    create(input: { difficulty?: string; name: string; lat: number; lon: number; greenId: string }): Promise<Pin>;
    update(input: { name?: string; lat?: number; lon?: number; difficulty?: string; id: string; version: number }): Promise<Pin>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    setActive(input: { id: string; version: number }): Promise<Pin>;
}

export function createPinsClient(baseUrl: string): PinsApi {
    return {
        async listByGreen(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/pins${qs ? '?' + qs : ''}` });
        },
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/pins/by-course${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pins/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pins/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pins/remove`, body: input });
        },
        async setActive(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pins/set-active`, body: input });
        },
    };
}
