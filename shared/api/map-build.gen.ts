// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface MapBuildJob {
    id: string;
    courseId: string;
    siteId: null | string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    step: null | 'fetch-lidar' | 'grid-dem' | 'fetch-ortho' | 'tile-ortho' | 'tile-terrain' | 'manifest' | 'install' | 'register';
    bbox: Bbox;
    log: string;
    error: null | string;
    createdAt: string;
    updatedAt: string;
}

export interface Bbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface MapBuildApi {
    start(input: { courseId: string; bbox: { west: number; south: number; east: number; north: number } }): Promise<MapBuildJob>;
    status(input: { jobId: string }): Promise<MapBuildJob>;
    latest(input: { courseId: string }): Promise<null | MapBuildJob>;
    setOrtho(input: { courseId: string; collection: string }): Promise<MapBuildJob>;
}

export function createMapBuildClient(baseUrl: string): MapBuildApi {
    return {
        async start(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/mapbuild/start`, body: input });
        },
        async status(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/mapbuild/status${qs ? '?' + qs : ''}` });
        },
        async latest(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/mapbuild/latest${qs ? '?' + qs : ''}` });
        },
        async setOrtho(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/mapbuild/set-ortho`, body: input });
        },
    };
}
