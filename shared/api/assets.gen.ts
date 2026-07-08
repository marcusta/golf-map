// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CourseAsset {
    id: string;
    courseId: string;
    siteId: null | string;
    kind: 'ortho_cog' | 'dem_cog' | 'svg_source' | 'tile_manifest';
    filename: string;
    metaJson: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface AssetsApi {
    listByCourse(input: { courseId: string }): Promise<CourseAsset[]>;
    listBySite(input: { siteId: string }): Promise<CourseAsset[]>;
    get(input: { id: string }): Promise<CourseAsset>;
    register(input: { courseId?: string; metaJson?: string; kind: 'ortho_cog' | 'dem_cog' | 'svg_source' | 'tile_manifest'; siteId: string; filename: string }): Promise<CourseAsset>;
    update(input: { metaJson?: string; id: string; version: number }): Promise<CourseAsset>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createAssetsClient(baseUrl: string): AssetsApi {
    return {
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/assets/by-course${qs ? '?' + qs : ''}` });
        },
        async listBySite(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/assets/by-site${qs ? '?' + qs : ''}` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/assets/get${qs ? '?' + qs : ''}` });
        },
        async register(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/assets/register`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/assets/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/assets/remove`, body: input });
        },
    };
}
