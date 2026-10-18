import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { WaterStepsService } from '../services/water-steps.service';

// --- Input schemas ---

const Point = Type.Object({ x: Type.Number(), y: Type.Number() });

const ProposeInput = Type.Object({
    courseId: Type.String(),
    /** The ponds (water) and creeks (water_creek) to read, one or more. */
    featureIds: Type.Array(Type.String(), { minItems: 1 }),
    /** Points on the water (EPSG:3006) where a step is wanted though the lidar shows none sharply. */
    cuts: Type.Optional(Type.Array(Point)),
    /** Points near a found step that is no step. */
    skips: Type.Optional(Type.Array(Point)),
    /** The least drop that is a fall (m, default 0.3). */
    minDropM: Type.Optional(Type.Number({ minimum: 0.05, maximum: 10 })),
    /** A sill's crest width left out between two waters (m, default 1). */
    sillM: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
    /** Bodies drawn this close (m, default 12) at different levels get an outlet fall. */
    gapM: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
});

// --- API descriptor ---

/**
 * Water steps (the terrain editor's "Find falls"; `bun run water:steps` is
 * the same service). Builder-only: reads the site's raw lidar DEM and runs
 * the pipeline. A proposal changes nothing — the web turns it into feature
 * edits with the shared planner and stores them through the ordinary
 * feature calls, one undo step.
 */
export function createWaterStepsApi(svc: WaterStepsService) {
    const mw = [requireAuth()];
    return {
        /** The pieces (ponds at their levels, creeks) and falls of the selected ponds and creeks. */
        propose: {
            method: 'POST' as const,
            path: '/water-steps/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId, input.featureIds, {
                cuts: input.cuts, skips: input.skips, minDropM: input.minDropM, sillM: input.sillM, gapM: input.gapM,
            }),
            schema: ProposeInput,
            middleware: mw,
        },
    };
}
