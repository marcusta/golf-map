// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PondEdgeProposal {
    featureId: string;
    shape: string;
    version: number;
    ring: PondEdgePoint[];
    lidarRing: PondEdgePoint[];
    level: number;
    areaM2: { drawn: number; lidar: number; new: number };
    outsideLidarM: { p50: number; p90: number; max: number };
    movedM: { p50: number; p90: number; max: number };
    kept: PondEdgeKept[];
    photos: { separation: number }[];
    toward: null | number;
    image: null | string;
}

export interface PondEdgePoint {
    x: number;
    y: number;
}

export interface PondEdgeKept {
    fromM: number;
    toM: number;
    why: string;
}

export interface PondEdgeApi {
    propose(input: { toward?: number; courseId: string; featureId: string }): Promise<PondEdgeProposal>;
    proposeAll(input: { toward?: number; courseId: string }): Promise<{ proposals: PondEdgeProposal[]; failed: { featureId: string; shape: string; error: string }[] }>;
}

export function createPondEdgeClient(baseUrl: string): PondEdgeApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pond-edge/propose`, body: input });
        },
        async proposeAll(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/pond-edge/propose-all`, body: input });
        },
    };
}
