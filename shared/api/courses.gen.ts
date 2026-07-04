// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Page {
    items: CourseSummary[];
    total: number;
}

export interface Course {
    id: string;
    name: string;
    status: string;
    revision: number;
    crs: string;
    georeferenceJson: null | string;
    homeLat: null | number;
    homeLon: null | number;
    notes: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface CourseSummary {
    id: string;
    name: string;
    status: string;
    revision: number;
    homeLat: null | number;
    homeLon: null | number;
    holeCount: number;
    updatedAt: string;
}

export interface CoursesApi {
    list(input: { offset: number; limit: number }): Promise<Page>;
    get(input: { id: string }): Promise<Course>;
    create(input: { crs?: string; georeferenceJson?: string; homeLat?: number; homeLon?: number; notes?: string; name: string }): Promise<Course>;
    update(input: { crs?: string; name?: string; georeferenceJson?: string; homeLat?: number; homeLon?: number; notes?: string; id: string; version: number }): Promise<Course>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    publish(input: { id: string; version: number }): Promise<Course>;
}

export function createCoursesClient(baseUrl: string): CoursesApi {
    return {
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses${qs ? '?' + qs : ''}` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/get${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/remove`, body: input });
        },
        async publish(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/publish`, body: input });
        },
    };
}
