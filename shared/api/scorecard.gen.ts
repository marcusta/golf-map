// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface StoredScorecard {
    courseId: string;
    sets: ({ teeSetId: string; name: string; color: null | string; totalM: number; lengths: { holeNumber: number; lengthM: number }[] })[];
}

export interface ScorecardProposal {
    courseId: string;
    unit: 'm' | 'yd';
    holes: ScorecardHole[];
    sets: ScorecardSetMatch[];
    warnings: string[];
    counts: { holes: number; parChanged: number; indexChanged: number; newSets: number; lengthsChanged: number; ratingsChanged: number };
}

export interface ScorecardResult {
    dryRun: boolean;
    setsCreated: number;
    lengthsWritten: number;
    holesChanged: number;
    ratingsWritten: number;
}

export interface ScorecardHole {
    number: number;
    holeId: null | string;
    par: null | number;
    parWas: null | number;
    strokeIndex: null | number;
    strokeIndexWas: null | number;
}

export interface ScorecardSetMatch {
    label: string;
    teeSetId: null | string;
    name: string;
    color: null | string;
    matchedBy: 'name' | 'length' | 'map' | 'colour' | 'new';
    totalM: number;
    holes: number;
    lengthsChanged: number;
    ratingMen: null | number;
    slopeMen: null | number;
    ratingWomen: null | number;
    slopeWomen: null | number;
    ratingsChanged: boolean;
}

export interface ScorecardApi {
    get(input: { courseId: string }): Promise<StoredScorecard>;
    propose(input: { map?: { label: string; teeSetId: string }[]; unit?: 'm' | 'yd'; courseId: string; text: string }): Promise<ScorecardProposal>;
    accept(input: { map?: { label: string; teeSetId: string }[]; dryRun?: boolean; unit?: 'm' | 'yd'; courseId: string; text: string }): Promise<ScorecardResult>;
}

export function createScorecardClient(baseUrl: string): ScorecardApi {
    return {
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/scorecard/by-course${qs ? '?' + qs : ''}` });
        },
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/scorecard/propose`, body: input });
        },
        async accept(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/scorecard/accept`, body: input });
        },
    };
}
