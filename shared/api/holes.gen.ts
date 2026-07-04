// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Hole {
    id: string;
    courseId: string;
    number: number;
    par: number;
    strokeIndex: null | number;
    notes: null | string;
    savedRegionJson: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface HolesApi {
    listByCourse(input: { courseId: string }): Promise<Hole[]>;
    get(input: { id: string }): Promise<Hole>;
    create(input: { notes?: string; savedRegionJson?: string; number: number; courseId: string; par: number }): Promise<Hole>;
    update(input: { notes?: string; par?: number; savedRegionJson?: string; strokeIndex?: null | number; id: string; version: number }): Promise<Hole>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createHolesClient(baseUrl: string): HolesApi {
    return {
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/holes${qs ? '?' + qs : ''}` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/holes/get${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/holes/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/holes/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/holes/remove`, body: input });
        },
    };
}
