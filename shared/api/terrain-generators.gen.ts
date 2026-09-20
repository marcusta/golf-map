// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface RoadsFetchResult {
    bbox: BboxWgs84;
    geojson: unknown;
    centerlines: null | string;
    report: string[];
}

export interface TerrainGenerateResult {
    kind: 'building-pads' | 'road-grades';
    imported: number;
    skipped: string[];
    report: string[];
}

export interface BboxWgs84 {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface TerrainGeneratorsApi {
    fetchRoads(input: { courseId: string }): Promise<RoadsFetchResult>;
    generate(input: { courseId: string; kind: 'building-pads' | 'road-grades' }): Promise<TerrainGenerateResult>;
}

export function createTerrainGeneratorsClient(baseUrl: string): TerrainGeneratorsApi {
    return {
        async fetchRoads(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/fetch-roads`, body: input });
        },
        async generate(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/generate`, body: input });
        },
    };
}
