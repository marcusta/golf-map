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
    planned?: TerrainEditInput[];
}

export interface RoadsFetchResult {
    bbox: BboxWgs84;
    geojson: unknown;
    centerlines: null | string;
    report: string[];
}

export interface TerrainEditInput {
    op: 'corridor' | 'plane' | 'smooth' | 'dig' | 'shore' | 'delta' | 'recipe' | 'wall';
    params: TerrainEditParams;
    rings: { x: number; y: number }[][];
    originRef?: null | string;
    enabled?: boolean;
}

export interface BboxWgs84 {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface TerrainEditParams {
    featherM: number;
    radiusM?: number;
    flat?: boolean;
    centerline?: { x: number; y: number }[];
    smoothM?: number;
    widthM?: number;
    depthM?: number;
    bankSlopeDeg?: number;
    faceSlopeDeg?: number;
    faceBearingDeg?: number;
    shelfM?: number;
    shelfDepthM?: number;
    reference?: 'plane' | 'level' | 'stream';
    rimM?: number;
    bankAboveDeg?: number;
    levelOffsetM?: number;
    steps?: { line: { x: number; y: number }[]; sillM: number }[];
    variation?: number;
    seed?: number;
    levelM?: number;
    runM?: number;
    minShelfM?: number;
    edgeSlope?: number;
    edgeM?: number;
    edgeEaseM?: number;
    shelfSlope?: number;
    shelfEndM?: number;
    shelfEaseM?: number;
    slope?: number;
    floorRoundM?: number;
    channelDepthM?: number;
    channelRatio?: number;
    channelFullM?: number;
    channelGoneM?: number;
    cliffRunM?: number;
    cliffRiseLowM?: number;
    cliffRiseHighM?: number;
    cliffSlope?: number;
    cliffDepthM?: number;
    cliffHoldM?: number;
    cliffFadeM?: number;
    cliffSmoothM?: number;
    innerDepthM?: number;
    raster?: string;
    changedM2?: number;
    maxRaiseM?: number;
    maxLowerM?: number;
    recipe?: string;
    overrides?: Record<string, unknown>;
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
