import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PondEdgeService } from '../services/pond-edge.service';

// --- Input schemas ---

const ProposeInput = Type.Object({
    courseId: Type.String(),
    featureId: Type.String(),
    /** 0-1: move each point that share of the way to the lidar's edge instead of reading the photo. */
    toward: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const ProposeAllInput = Type.Object({
    courseId: Type.String(),
    toward: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

// --- API descriptor ---

/**
 * Pond edges (the terrain editor's "Fit edge to water"; `bun run water:edge`
 * is the same service). Builder-only: reads the site's lidar DEM and
 * orthophotos and runs the pipeline. A proposal changes nothing — the web
 * fits it as a B-spline and stores it through the ordinary feature update.
 */
export function createPondEdgeApi(svc: PondEdgeService) {
    const mw = [requireAuth()];
    return {
        /** One pond's proposed water edge, found on the photo between the lidar's water and the drawn line. */
        propose: {
            method: 'POST' as const,
            path: '/pond-edge/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId, input.featureId, { toward: input.toward }),
            schema: ProposeInput,
            middleware: mw,
        },
        /** Every pond's proposal (and the ponds the photos or lidar could not read, with why). */
        proposeAll: {
            method: 'POST' as const,
            path: '/pond-edge/propose-all',
            fn: (input: Static<typeof ProposeAllInput>) => svc.proposeAll(input.courseId, { toward: input.toward }),
            schema: ProposeAllInput,
            middleware: mw,
        },
    };
}
