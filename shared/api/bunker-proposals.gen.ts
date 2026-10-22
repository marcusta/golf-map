// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface BunkerProposalsResult {
    courseId: string;
    siteId: string;
    collection: string;
    proposals: BunkerProposal[];
    left: { drawn: number; notCourse: number; small: number; skipped: number };
    predicted: boolean;
    seconds: number;
    dryRun: boolean;
}

export interface BunkerProposal {
    id: string;
    ring: [number, number][];
    lonLat: [number, number][];
    areaM2: number;
    confidence: number;
    edge: 'nir' | 'model';
    holeId: null | string;
    holeNumber: null | number;
}

export interface BunkerProposalsApi {
    propose(input: { dryRun?: boolean; courseId: string }): Promise<BunkerProposalsResult>;
    skip(input: { courseId: string; ids: string[] }): Promise<{ skipped: number; skippedNow: number }>;
}

export function createBunkerProposalsClient(baseUrl: string): BunkerProposalsApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/bunker-proposals/propose`, body: input });
        },
        async skip(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/bunker-proposals/skip`, body: input });
        },
    };
}
