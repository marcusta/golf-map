// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface HoleAssignmentProposal {
    courseId: string;
    proposals: HoleProposal[];
    lines: HolePlayLine[];
    counts: { assign: number; roughs: number; others: number; otherCourse: number; ambiguous: number; none: number };
}

export interface HoleAssignmentResult {
    assigned: number;
    roughs: number;
    others: number;
    dryRun: boolean;
    holes: ({ featureId: string; featureNo: null | number; holeNumber: number })[];
}

export interface HoleProposal {
    featureId: string;
    featureNo: null | number;
    type: string;
    outcome: 'roughs' | 'assign' | 'others' | 'other-course' | 'ambiguous' | 'none';
    holeId: null | string;
    holeNumber: null | number;
    courseName: null | string;
    share: null | number;
    island: boolean;
    reason: null | string;
}

export interface HolePlayLine {
    holeId: string;
    courseId: string;
    number: number;
    line: [number, number][];
}

export interface HoleAssignmentApi {
    propose(input: { courseId: string }): Promise<HoleAssignmentProposal>;
    accept(input: { featureIds?: string[]; dryRun?: boolean; courseId: string }): Promise<HoleAssignmentResult>;
}

export function createHoleAssignmentClient(baseUrl: string): HoleAssignmentApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/hole-assignment/propose`, body: input });
        },
        async accept(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/hole-assignment/accept`, body: input });
        },
    };
}
