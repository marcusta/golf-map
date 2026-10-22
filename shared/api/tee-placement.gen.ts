// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface TeePlacementProposal {
    courseId: string;
    spots: TeeSpot[];
    counts: { place: number; ok: number; off: number; ambiguous: number; missed: number; skipped: number };
    sets: number;
}

export interface TeePlacementResult {
    placed: number;
    moved: number;
    dryRun: boolean;
    spots: ({ key: string; holeNumber: number; setName: string; action: 'place' | 'move'; moveM: null | number })[];
}

export interface TeeSpot {
    key: string;
    holeId: string;
    holeNumber: number;
    teeSetId: string;
    setName: string;
    color: null | string;
    lengthM: number;
    outcome: 'ok' | 'off' | 'ambiguous' | 'place' | 'missed' | 'too-short' | 'no-green';
    teeId: null | string;
    currentLengthM: null | number;
    at: null | [number, number];
    from: null | [number, number];
    moveM: null | number;
    shapeId: null | string;
    arc: null | [number, number][];
    reason: null | string;
}

export interface TeePlacementApi {
    propose(input: { courseId: string }): Promise<TeePlacementProposal>;
    accept(input: { keys?: string[]; dryRun?: boolean; courseId: string }): Promise<TeePlacementResult>;
}

export function createTeePlacementClient(baseUrl: string): TeePlacementApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tee-placement/propose`, body: input });
        },
        async accept(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/tee-placement/accept`, body: input });
        },
    };
}
