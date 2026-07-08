// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Site {
    id: string;
    name: string;
    notes: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface SiteCourse {
    id: string;
    name: string;
}

export interface SitesApi {
    list(): Promise<Site[]>;
    get(input: { id: string }): Promise<Site>;
    courses(input: { siteId: string }): Promise<SiteCourse[]>;
    create(input: { notes?: string; name: string }): Promise<Site>;
    update(input: { name?: string; notes?: string; id: string; version: number }): Promise<Site>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createSitesClient(baseUrl: string): SitesApi {
    return {
        async list() {
            return apiFetch({ method: 'GET', url: `${baseUrl}/sites` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/sites/get${qs ? '?' + qs : ''}` });
        },
        async courses(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/sites/courses${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/sites/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/sites/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/sites/remove`, body: input });
        },
    };
}
