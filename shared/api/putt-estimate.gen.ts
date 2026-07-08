// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PuttEstimateSample {
    id: string;
    greenId: null | string;
    distanceM: number;
    stimpFt: number;
    actualSlopePct: number;
    estimatedSlopePct: number;
    actualAimOffsetM: number;
    estimatedAimOffsetM: number;
    actualPlaysLikeM: number;
    estimatedPlaysLikeM: number;
    breakSideActual: 'left' | 'right' | 'straight';
    breakSideEstimated: 'left' | 'right' | 'straight';
    createdAt: string;
}

export interface AccuracyTrend {
    recent: AccuracyAggregate;
    overall: AccuracyAggregate;
    buckets: AccuracyBucket[];
}

export interface AccuracyAggregate {
    sampleCount: number;
    meanSlopeErrorPct: null | number;
    breakSideHitRate: null | number;
    meanPaceErrorM: null | number;
}

export interface AccuracyBucket {
    date: string;
    sampleCount: number;
    meanSlopeErrorPct: null | number;
    breakSideHitRate: null | number;
    meanPaceErrorM: null | number;
}

export interface PuttEstimateApi {
    recordSample(input: { greenId: null | string; distanceM: number; stimpFt: number; actualSlopePct: number; estimatedSlopePct: number; actualAimOffsetM: number; estimatedAimOffsetM: number; actualPlaysLikeM: number; estimatedPlaysLikeM: number; breakSideActual: 'left' | 'right' | 'straight'; breakSideEstimated: 'left' | 'right' | 'straight' }): Promise<PuttEstimateSample>;
    accuracyTrend(input: { greenId?: string; recentN?: number }): Promise<AccuracyTrend>;
}

export function createPuttEstimateClient(baseUrl: string): PuttEstimateApi {
    return {
        async recordSample(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/putt-estimates/samples`, body: input });
        },
        async accuracyTrend(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/putt-estimates/accuracy${qs ? '?' + qs : ''}` });
        },
    };
}
