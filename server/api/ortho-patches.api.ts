import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { OrthoPatchesService } from '../services/ortho-patches.service';

// --- Input schemas ---

const BoundsSchema = Type.Object({
    west: Type.Number(),
    south: Type.Number(),
    east: Type.Number(),
    north: Type.Number(),
});

const ApplyPatchInput = Type.Object({
    courseId: Type.String(),
    /** RGBA PNG, alpha = pixels to bake, base64 (no data-URL prefix). */
    pngBase64: Type.String(),
    /** The patch crop's exact EPSG:3857 frame. */
    bounds3857: BoundsSchema,
    /** Same area as an EPSG:3006 bbox (informational, logged). */
    boundsSweref: BoundsSchema,
    /** Mask mode that produced the patch ('sam' | 'ellipse'). */
    tool: Type.String(),
});

const CourseInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---

export function createOrthoPatchesApi(svc: OrthoPatchesService) {
    const mw = [requireAuth()];
    return {
        // Interactive photo cleaning (T55). apply/revert are synchronous:
        // replay + subtree retile take seconds, and the response's fresh
        // generatedAt is what tells the client to refetch tiles.
        applyOrthoPatch: {
            method: 'POST' as const,
            path: '/ortho-patches/apply',
            fn: (input: Static<typeof ApplyPatchInput>) => svc.apply(input.courseId, {
                pngBase64: input.pngBase64,
                bounds3857: input.bounds3857,
                boundsSweref: input.boundsSweref,
                tool: input.tool,
            }),
            schema: ApplyPatchInput,
            middleware: mw,
        },
        revertLastOrthoPatch: {
            method: 'POST' as const,
            path: '/ortho-patches/revert-last',
            fn: (input: Static<typeof CourseInput>) => svc.revertLast(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        orthoPatchesInfo: {
            method: 'GET' as const,
            path: '/ortho-patches/info',
            fn: (input: Static<typeof CourseInput>) => svc.info(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
    };
}
