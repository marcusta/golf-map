import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PhotoStemsService } from '../services/photo-stems.service';

// --- Input schemas ---

const ProposeInput = Type.Object({
    courseId: Type.String(),
    /** Propose and keep nothing (no proposal kept for accept). */
    dryRun: Type.Optional(Type.Boolean()),
});

const AcceptInput = Type.Object({
    courseId: Type.String(),
    /** Ids of the last proposal to plant as photo stems. */
    accept: Type.Array(Type.String()),
    /** Ids no later proposal offers again. */
    skip: Type.Array(Type.String()),
});

// --- API descriptor ---

/**
 * Photo stems (the Vegetation mode's "Find trees in photo"; `bun run trees:photo` is the same service): young
 * trees on open ground the lidar missed, found from their shadows in the summer photo. Builder-only: runs the
 * pipeline on the site's photos. Accepted ones are planted like lidar stems by the GSPro trees export.
 */
export function createPhotoStemsApi(svc: PhotoStemsService) {
    const mw = [requireAuth()];
    return {
        /** The young trees the summer photo shows on the course's open ground, less those already accepted or skipped. */
        propose: {
            method: 'POST' as const,
            path: '/photo-stems/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId, { dryRun: input.dryRun }),
            schema: ProposeInput,
            middleware: mw,
        },
        /** Plant the accepted ids of the last proposal as photo stems and remember the skipped ones. */
        accept: {
            method: 'POST' as const,
            path: '/photo-stems/accept',
            fn: (input: Static<typeof AcceptInput>) => svc.accept(input.courseId, { accept: input.accept, skip: input.skip }),
            schema: AcceptInput,
            middleware: mw,
        },
    };
}
