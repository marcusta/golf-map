// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface WaterStepsProposal {
    courseId: string;
    bodies: WaterStepsBody[];
    pieces: WaterStepsPiece[];
    falls: WaterStepsFall[];
    cuts: WaterStepsPoint[];
    skips: WaterStepsPoint[];
    image: null | string;
}

export interface WaterStepsBody {
    featureId: string;
    shape: string;
    type: string;
    version: number;
    line: null | WaterStepsPoint[];
    profile: null | { s: number[]; z: number[] };
    steps: number;
}

export interface WaterStepsPiece {
    bodyId: string;
    shape: string;
    index: number;
    kind: 'creek' | 'pond';
    ring: WaterStepsPoint[];
    levelM: null | number;
    topM: null | number;
    bottomM: null | number;
    areaM2: number;
    digLevelOffsetM: null | number;
}

export interface WaterStepsFall {
    style: 'cascade' | 'sill' | 'outlet';
    fromBodyId: string;
    toBodyId: string;
    fromPiece: null | number;
    toPiece: null | number;
    line: WaterStepsPoint[];
    at: WaterStepsPoint;
    flow: WaterStepsPoint;
    topM: number;
    bottomM: number;
    dropM: number;
    widthM: number;
    sillM: null | number;
    forced: boolean;
    gapM: null | number;
    exists: boolean;
    existingId: null | string;
}

export interface WaterStepsPoint {
    x: number;
    y: number;
}

export interface WaterStepsApi {
    propose(input: { cuts?: { x: number; y: number }[]; skips?: { x: number; y: number }[]; minDropM?: number; sillM?: number; gapM?: number; courseId: string; featureIds: string[] }): Promise<WaterStepsProposal>;
}

export function createWaterStepsClient(baseUrl: string): WaterStepsApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/water-steps/propose`, body: input });
        },
    };
}
