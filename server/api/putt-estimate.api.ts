import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PuttEstimateService } from '../services/putt-estimate.service';

// --- Input schemas ---

const BreakSide = Type.Union([
    Type.Literal('left'),
    Type.Literal('right'),
    Type.Literal('straight'),
]);

const RecordSampleInput = Type.Object({
    /** Green row id, or null for a Tier-3 manual read with no surface. */
    greenId: Type.Union([Type.String(), Type.Null()]),
    distanceM: Type.Number(),
    stimpFt: Type.Number(),
    actualSlopePct: Type.Number(),
    estimatedSlopePct: Type.Number(),
    actualAimOffsetM: Type.Number(),
    estimatedAimOffsetM: Type.Number(),
    actualPlaysLikeM: Type.Number(),
    estimatedPlaysLikeM: Type.Number(),
    breakSideActual: BreakSide,
    breakSideEstimated: BreakSide,
});

const AccuracyTrendInput = Type.Object({
    greenId: Type.Optional(Type.String()),
    recentN: Type.Optional(Type.Number()),
});

// --- API descriptor ---

export function createPuttEstimateApi(svc: PuttEstimateService) {
    const mw = [requireAuth()];
    return {
        recordSample: {
            method: 'POST' as const,
            path: '/putt-estimates/samples',
            fn: (input: Static<typeof RecordSampleInput>) => svc.recordSample(input),
            schema: RecordSampleInput,
            middleware: mw,
        },
        accuracyTrend: {
            method: 'GET' as const,
            path: '/putt-estimates/accuracy',
            fn: (input: Static<typeof AccuracyTrendInput>) =>
                svc.accuracyTrend({ greenId: input.greenId, recentN: input.recentN }),
            schema: AccuracyTrendInput,
            middleware: mw,
        },
    };
}
