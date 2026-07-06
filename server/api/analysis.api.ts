import { Type, type Static } from '@sinclair/typebox';
import { requireAuth, NotFoundError } from '@basics/core/server/auth';
import type { AnalysisService } from '../services/analysis.service';
import { InvalidAnalysisRequestError } from '../services/analysis.service';
import type { CourseFeaturesService } from '../services/course-features.service';
import type { FeatureGeometry } from '../services/geo';

// --- Input schemas ---

const PointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
});

const AnchorPointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
    hIn: Type.Optional(PointSchema),
    hOut: Type.Optional(PointSchema),
});

const PathRingSchema = Type.Object({
    points: Type.Array(AnchorPointSchema),
});

const FeatureGeometrySchema = Type.Object({
    crs: Type.String(),
    rings: Type.Array(PathRingSchema),
});

const SampleGridInput = Type.Object({
    courseId: Type.String(),
    /** A course feature of type `green` to analyse — or pass `geometry` directly. */
    featureId: Type.Optional(Type.String()),
    geometry: Type.Optional(FeatureGeometrySchema),
    /** Surrounds buffer in meters (clamped server-side to 0–50, default 20). */
    bufferM: Type.Optional(Type.Number()),
    /** Grid cell size in meters (clamped server-side, default 0.5 = DEM native). */
    resolutionM: Type.Optional(Type.Number()),
});

const ElevationPointSchema = Type.Object({
    e: Type.Number(),
    n: Type.Number(),
});

const SampleElevationsInput = Type.Object({
    courseId: Type.String(),
    /** EPSG:3006 points to sample. Raw bilinear height, no blur. */
    points: Type.Array(ElevationPointSchema),
});

// --- API descriptor ---

export function createAnalysisApi(svc: AnalysisService, features: CourseFeaturesService) {
    const mw = [requireAuth()];

    async function resolveGeometry(input: Static<typeof SampleGridInput>): Promise<FeatureGeometry> {
        if (input.featureId) {
            const feature = await features.findById(input.featureId).catch(() => {
                throw new NotFoundError(`Feature ${input.featureId} not found`);
            });
            if (feature.courseId !== input.courseId) {
                throw new NotFoundError(`Feature ${input.featureId} not found on course ${input.courseId}`);
            }
            if (feature.type !== 'green') {
                throw new InvalidAnalysisRequestError('Green analysis requires a feature of type green');
            }
            return feature.geometry;
        }
        if (input.geometry) return input.geometry;
        throw new InvalidAnalysisRequestError('Either featureId or geometry is required');
    }

    return {
        sampleGrid: {
            method: 'POST' as const,
            path: '/analysis/sample-grid',
            fn: async (input: Static<typeof SampleGridInput>) =>
                svc.sampleGrid(input.courseId, await resolveGeometry(input), input.bufferM, input.resolutionM),
            schema: SampleGridInput,
            middleware: mw,
        },
        sampleElevations: {
            method: 'POST' as const,
            path: '/analysis/sample-elevations',
            fn: async (input: Static<typeof SampleElevationsInput>) => ({
                elevations: await svc.sampleElevations(input.courseId, input.points),
            }),
            schema: SampleElevationsInput,
            middleware: mw,
        },
    };
}
