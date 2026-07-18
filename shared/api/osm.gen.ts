// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface OsmFetchResult {
    bbox: OsmBbox;
    source: string;
    license: string;
    attribution: string;
    fetched: string;
    features: OsmFeaturePolygon[];
    skipped: string[];
}

export interface OsmBbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface OsmFeaturePolygon {
    type: string;
    sourceRef: string;
    rings: number[][][];
}

export interface OsmApi {
    fetchOsm(input: { courseId: string }): Promise<OsmFetchResult>;
}

export function createOsmClient(baseUrl: string): OsmApi {
    return {
        async fetchOsm(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/fetch-osm`, body: input });
        },
    };
}
