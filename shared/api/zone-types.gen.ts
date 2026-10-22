// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CourseZoneType {
    id: string;
    courseId: string;
    key: string;
    name: string;
    color: string;
    textureIndex: number;
    channel: number;
    sortOrder: number;
    items: ZoneTypeItem[];
    variants: ZoneTypeVariant[];
    createdAt: string;
    updatedAt: string;
}

export interface ZoneTypeItem {
    item: string;
    minDensity: number;
    maxDensity: number;
}

export interface ZoneTypeVariant {
    key: string;
    name: string;
    items: ZoneTypeItem[];
}

export interface ZoneTypesApi {
    list(input: { courseId: string }): Promise<CourseZoneType[]>;
    addDefaults(input: { courseId: string }): Promise<CourseZoneType[]>;
    create(input: { items?: { item: string; minDensity: number; maxDensity: number }[]; channel?: number; textureIndex?: number; variants?: { name: string; items: { item: string; minDensity: number; maxDensity: number }[]; key: string }[]; courseId: string; name: string; key: string; color: string }): Promise<CourseZoneType>;
    update(input: { name?: string; items?: { item: string; minDensity: number; maxDensity: number }[]; key?: string; channel?: number; color?: string; textureIndex?: number; variants?: { name: string; items: { item: string; minDensity: number; maxDensity: number }[]; key: string }[]; id: string }): Promise<CourseZoneType>;
    remove(input: { id: string }): Promise<{ ok: boolean }>;
    reorder(input: { orderedIds: string[]; courseId: string }): Promise<CourseZoneType[]>;
}

export function createZoneTypesClient(baseUrl: string): ZoneTypesApi {
    return {
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/zone-types${qs ? '?' + qs : ''}` });
        },
        async addDefaults(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/zone-types/add-defaults`, body: input });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/zone-types/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/zone-types/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/zone-types/remove`, body: input });
        },
        async reorder(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/zone-types/reorder`, body: input });
        },
    };
}
