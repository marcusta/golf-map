// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface TerrainEdit {
    id: string;
    siteId: string;
    op: 'corridor' | 'plane' | 'smooth' | 'dig' | 'shore' | 'delta' | 'recipe';
    params: TerrainEditParams;
    rings: { x: number; y: number }[][];
    enabled: boolean;
    origin: null | string;
    originRef: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
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
    variation?: number;
    seed?: number;
    levelM?: number;
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

export interface TerrainEditsApi {
    list(input: { siteId: string }): Promise<TerrainEdit[]>;
    create(input: { featureId?: string; rings?: { x: number; y: number }[][]; enabled?: boolean; params: { centerline?: { x: number; y: number }[]; widthM?: number; flat?: boolean; variation?: number; seed?: number; recipe?: string; featherM?: number; radiusM?: number; smoothM?: number; depthM?: number; bankSlopeDeg?: number; faceSlopeDeg?: number; faceBearingDeg?: number; shelfM?: number; shelfDepthM?: number; reference?: 'plane' | 'level' | 'stream'; rimM?: number; bankAboveDeg?: number; levelOffsetM?: number; levelM?: number; edgeSlope?: number; edgeM?: number; edgeEaseM?: number; shelfSlope?: number; shelfEndM?: number; shelfEaseM?: number; slope?: number; floorRoundM?: number; channelDepthM?: number; channelRatio?: number; channelFullM?: number; channelGoneM?: number; cliffRunM?: number; cliffRiseLowM?: number; cliffRiseHighM?: number; cliffSlope?: number; cliffDepthM?: number; cliffHoldM?: number; cliffFadeM?: number; cliffSmoothM?: number; innerDepthM?: number; raster?: string; changedM2?: number; maxRaiseM?: number; maxLowerM?: number; overrides?: { [x: string]: unknown; } }; siteId: string; op: 'corridor' | 'plane' | 'smooth' | 'dig' | 'shore' | 'delta' | 'recipe' }): Promise<TerrainEdit>;
    update(input: { params?: { centerline?: { x: number; y: number }[]; widthM?: number; flat?: boolean; variation?: number; seed?: number; recipe?: string; featherM?: number; radiusM?: number; smoothM?: number; depthM?: number; bankSlopeDeg?: number; faceSlopeDeg?: number; faceBearingDeg?: number; shelfM?: number; shelfDepthM?: number; reference?: 'plane' | 'level' | 'stream'; rimM?: number; bankAboveDeg?: number; levelOffsetM?: number; levelM?: number; edgeSlope?: number; edgeM?: number; edgeEaseM?: number; shelfSlope?: number; shelfEndM?: number; shelfEaseM?: number; slope?: number; floorRoundM?: number; channelDepthM?: number; channelRatio?: number; channelFullM?: number; channelGoneM?: number; cliffRunM?: number; cliffRiseLowM?: number; cliffRiseHighM?: number; cliffSlope?: number; cliffDepthM?: number; cliffHoldM?: number; cliffFadeM?: number; cliffSmoothM?: number; innerDepthM?: number; raster?: string; changedM2?: number; maxRaiseM?: number; maxLowerM?: number; overrides?: { [x: string]: unknown; } }; rings?: { x: number; y: number }[][]; op?: 'corridor' | 'plane' | 'smooth' | 'dig' | 'shore' | 'delta' | 'recipe'; enabled?: boolean; id: string; version: number }): Promise<TerrainEdit>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    import(input: { siteId: string; origin: string; geojson: unknown }): Promise<{ imported: TerrainEdit[]; skipped: string[] }>;
}

export function createTerrainEditsClient(baseUrl: string): TerrainEditsApi {
    return {
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/terrain-edits${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/remove`, body: input });
        },
        async import(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/terrain-edits/import`, body: input });
        },
    };
}
