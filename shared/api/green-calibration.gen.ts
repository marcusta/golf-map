// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GreenScan {
    id: string;
    greenId: string;
    kind: string;
    capturedAt: string;
    payloadJson: string;
    qualityJson: null | string;
    createdAt: string;
}

export interface GreenCalibration {
    greenId: string;
    biasJson: null | string;
    confidence: number;
    sampleCount: number;
    updatedAt: string;
}

export interface GreenConfidence {
    greenId: string;
    confidence: number;
    sampleCount: number;
    source: 'scans' | 'prior';
    bias?: GreenBias;
}

export interface GreenBias {
    tiltE: number;
    tiltN: number;
}

export interface GreenCalibrationApi {
    ingestScan(input: { quality?: unknown; greenId: string; kind: 'corridor' | 'spot_level'; capturedAt: string; payload: unknown }): Promise<{ scan: GreenScan; calibration: null | GreenCalibration }>;
    courseConfidence(input: { courseId: string }): Promise<{ greens: GreenConfidence[] }>;
}

export function createGreenCalibrationClient(baseUrl: string): GreenCalibrationApi {
    return {
        async ingestScan(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/green-calibration/scans`, body: input });
        },
        async courseConfidence(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/green-calibration/confidence${qs ? '?' + qs : ''}` });
        },
    };
}
