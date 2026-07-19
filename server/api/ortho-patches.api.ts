import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { OrthoPatchesService, OrthoEditInput } from '../services/ortho-patches.service';

// --- Input schemas ---

const BoundsSchema = Type.Object({
    west: Type.Number(),
    south: Type.Number(),
    east: Type.Number(),
    north: Type.Number(),
});

const MaskEditSchema = Type.Object({
    kind: Type.Literal('mask'),
    /** MASK PNG (white/opaque = inpaint), base64 (no data-URL prefix). The
     * fill is computed server-side by LaMa against the working raster. */
    maskPngBase64: Type.String(),
    /** The mask crop's exact EPSG:3857 frame. */
    bounds3857: BoundsSchema,
    /** Same area as an EPSG:3006 bbox (informational, logged). */
    boundsSweref: BoundsSchema,
    /** Mask mode that produced the patch ('sam' | 'ellipse'). */
    tool: Type.String(),
});

const StampEditSchema = Type.Object({
    kind: Type.Literal('stamp'),
    /** Brush params — diameter (ground m), opacity/flow (0..1], hardness [0..1]. */
    brush: Type.Object({
        sizeM: Type.Number(),
        opacity: Type.Number(),
        flow: Type.Number(),
        hardness: Type.Number(),
    }),
    /** source = dest + offset, EPSG:3006 metres (dx east, dy north). */
    offsetM: Type.Object({ dx: Type.Number(), dy: Type.Number() }),
    /** Dest stroke polyline, EPSG:3006 metres. */
    path: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() })),
    /** Aligned-clone flag state at capture. */
    aligned: Type.Boolean(),
    /** Tone-match toggle state for this stroke. */
    toneMatch: Type.Boolean(),
    /** Dest stroke bbox + brush radius, EPSG:3857 — the retile frame. */
    bounds3857: BoundsSchema,
    boundsSweref: BoundsSchema,
});

const ApplyEditsInput = Type.Object({
    courseId: Type.String(),
    /** The client's whole pending queue, in accept order — ONE server call
     * bakes them all (single retile pass + single sim version bump). */
    edits: Type.Array(Type.Union([MaskEditSchema, StampEditSchema])),
});

const CourseInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---

export function createOrthoPatchesApi(svc: OrthoPatchesService) {
    const mw = [requireAuth()];
    return {
        // Interactive photo cleaning. apply/revert are synchronous: the
        // windowed batch bake / replay + union-subtree retile take seconds,
        // and the response's fresh patchesGeneratedAt (the SIM overlay's
        // version — the pristine tree is never touched) tells the client to
        // refetch ortho-sim tiles.
        applyOrthoEdits: {
            method: 'POST' as const,
            path: '/ortho-patches/apply',
            fn: (input: Static<typeof ApplyEditsInput>) =>
                svc.applyEdits(input.courseId, input.edits as OrthoEditInput[]),
            schema: ApplyEditsInput,
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
