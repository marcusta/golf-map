// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface RoadsFetchJob {
    id: string;
    courseId: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: null | string;
    result: null | RoadsFetchResult;
    error: null | string;
}

export interface TerrainGenerateResult {
    kind: 'building-pads' | 'road-grades' | 'water-digs' | 'bunker-digs' | 'creek-digs';
    imported: number;
    skipped: string[];
    report: string[];
}

export interface RoadsFetchResult {
    bbox: BboxWgs84;
    geojson: unknown;
    centerlines: null | string;
    report: string[];
}

export interface BboxWgs84 {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface TerrainGeneratorsApi {
    startRoadsFetch(input: { courseId: string }): Promise<RoadsFetchJob>;
    roadsFetchJob(input: { jobId: string }): Promise<RoadsFetchJob>;
    currentRoadsFetch(input: { courseId: string }): Promise<null | RoadsFetchJob>;
    generate(input: { courseId: string; kind: 'building-pads' | 'road-grades' | 'water-digs' | 'bunker-digs' | 'creek-digs' }): Promise<TerrainGenerateResult>;
}

export function createTerrainGeneratorsClient(baseUrl: string): TerrainGeneratorsApi {
    return {
        async startRoadsFetch(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/fetch-roads/start`, body: input });
        },
        async roadsFetchJob(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/course-features/fetch-roads/job${qs ? '?' + qs : ''}` });
        },
        async currentRoadsFetch(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/course-features/fetch-roads/current${qs ? '?' + qs : ''}` });
        },
        async generate(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/generate`, body: input });
        },
    };
}
