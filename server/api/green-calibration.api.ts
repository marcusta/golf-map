import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GreenCalibrationService } from '../services/green-calibration.service';

// --- Input schemas ---

const IngestScanInput = Type.Object({
    greenId: Type.String(),
    kind: Type.Union([Type.Literal('corridor'), Type.Literal('spot_level')]),
    capturedAt: Type.String(),
    /**
     * Raw scan/sample data — stored verbatim. Wire contract:
     * docs/reference/green-scan-payload.md (v1). Unknown versions/kinds are
     * stored but excluded from calibration.
     */
    payload: Type.Unknown(),
    /**
     * QC verdict + agreement stats (contract quality_json). Verdict gates
     * calibration: green = full weight, yellow = half, red = stored only.
     */
    quality: Type.Optional(Type.Unknown()),
});

const CourseConfidenceInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---

export function createGreenCalibrationApi(svc: GreenCalibrationService) {
    const mw = [requireAuth()];
    return {
        ingestScan: {
            method: 'POST' as const,
            path: '/green-calibration/scans',
            fn: (input: Static<typeof IngestScanInput>) =>
                svc.ingestScan({
                    greenId: input.greenId,
                    kind: input.kind,
                    capturedAt: input.capturedAt,
                    payload: input.payload,
                    quality: input.quality,
                }),
            schema: IngestScanInput,
            middleware: mw,
        },
        courseConfidence: {
            method: 'GET' as const,
            path: '/green-calibration/confidence',
            fn: async (input: Static<typeof CourseConfidenceInput>) => ({
                greens: await svc.confidenceForCourse(input.courseId),
            }),
            schema: CourseConfidenceInput,
            middleware: mw,
        },
    };
}
