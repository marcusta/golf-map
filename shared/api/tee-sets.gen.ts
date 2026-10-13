// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface TeeSet {
    id: string;
    courseId: string;
    name: string;
    color: null | string;
    sortOrder: number;
    ratingMen: null | number;
    slopeMen: null | number;
    ratingWomen: null | number;
    slopeWomen: null | number;
    gsproRating: 'men' | 'women';
    gsproTee: null | 'Black' | 'White' | 'Green' | 'Blue' | 'Yellow' | 'Red' | 'Junior' | 'Par3';
    gsproOnly: boolean;
    teeCount: number;
    version: number;
}

export interface TeeSetsApi {
    listByCourse(input: { courseId: string }): Promise<TeeSet[]>;
    create(input: { color?: null | string; courseId: string; name: string }): Promise<TeeSet>;
    update(input: { name?: string; color?: null | string; ratingMen?: null | number; slopeMen?: null | number; ratingWomen?: null | number; slopeWomen?: null | number; gsproRating?: 'men' | 'women'; gsproTee?: null | 'Black' | 'White' | 'Green' | 'Blue' | 'Yellow' | 'Red' | 'Junior' | 'Par3'; gsproOnly?: boolean; id: string; version: number }): Promise<TeeSet>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createTeeSetsClient(baseUrl: string): TeeSetsApi {
    return {
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/tee-sets/by-course${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tee-sets/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tee-sets/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tee-sets/remove`, body: input });
        },
    };
}
