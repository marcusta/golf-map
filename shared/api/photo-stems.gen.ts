// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PhotoStemsProposal {
    courseId: string;
    siteId: string;
    proposals: PhotoStemProposal[];
    calibration: PhotoStemsCalibration;
    matched: PhotoStemMatch[];
    summer: string;
    leafOff: null | string;
    accepted: number;
    skipped: number;
    dryRun: boolean;
}

export interface PhotoStemsAcceptResult {
    courseId: string;
    accepted: number;
    skipped: number;
    path: string;
}

export interface PhotoStemProposal {
    id: string;
    x: number;
    y: number;
    heightM: number;
    crownRadiusM: number;
    groundM?: number;
    kind: number;
    source: string;
    shadowLengthM?: number;
    shadowAreaM2?: number;
}

export interface PhotoStemsCalibration {
    shadowAzimuthDeg: number;
    directionFrom: number;
    matched: number;
    fallback: boolean;
    sunFactor: number;
    radiusPerWidth: number;
    heightLine: null | number[];
    radiusLine: null | number[];
    matchedOffsetM: null | number;
    shadows: number;
    tiles: number;
}

export interface PhotoStemMatch {
    x: number;
    y: number;
    heightM: number;
    crownRadiusM: number;
    heightFromShadowM: number;
}

export interface PhotoStemsApi {
    propose(input: { dryRun?: boolean; courseId: string }): Promise<PhotoStemsProposal>;
    accept(input: { courseId: string; accept: string[]; skip: string[] }): Promise<PhotoStemsAcceptResult>;
}

export function createPhotoStemsClient(baseUrl: string): PhotoStemsApi {
    return {
        async propose(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photo-stems/propose`, body: input });
        },
        async accept(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photo-stems/accept`, body: input });
        },
    };
}
