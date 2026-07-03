// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Club {
    id: string;
    userId: null | string;
    name: string;
    carryM: number;
    dispersionM: number;
    sortOrder: number;
    version: number;
}

export interface ClubsApi {
    list(input: { userId?: string }): Promise<Club[]>;
    create(input: { userId?: string; name: string; carryM: number; dispersionM: number }): Promise<Club>;
    update(input: { name?: string; carryM?: number; dispersionM?: number; id: string; version: number }): Promise<Club>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    reorder(input: { orderedIds: string[] }): Promise<{ ok: boolean }>;
}

export function createClubsClient(baseUrl: string): ClubsApi {
    return {
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/clubs${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/clubs/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/clubs/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/clubs/remove`, body: input });
        },
        async reorder(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/clubs/reorder`, body: input });
        },
    };
}
