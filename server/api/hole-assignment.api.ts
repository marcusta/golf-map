import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { HoleAssignmentService } from '../services/hole-assignment.service';

// --- Input schemas ---

const ProposeInput = Type.Object({
    courseId: Type.String(),
});

const AcceptInput = Type.Object({
    courseId: Type.String(),
    /** Only these shapes of a fresh proposal; omitted = every shape it puts on a hole. */
    featureIds: Type.Optional(Type.Array(Type.String())),
    dryRun: Type.Optional(Type.Boolean()),
});

// --- API descriptor ---

/**
 * Shapes in Others onto their holes, from the holes' tees, aim points and green centre (the Draw mode's
 * "Assign to holes", `bun run holes:assign` is the same service). Propose writes nothing.
 */
export function createHoleAssignmentApi(svc: HoleAssignmentService) {
    const mw = [requireAuth()];
    return {
        /** What each shape in Others would get, and the holes' play lines. */
        propose: {
            method: 'POST' as const,
            path: '/hole-assignment/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId),
            schema: ProposeInput,
            middleware: mw,
        },
        /** Put the proposed shapes on their holes (one transaction, undo through the feature history). */
        accept: {
            method: 'POST' as const,
            path: '/hole-assignment/accept',
            fn: (input: Static<typeof AcceptInput>) => svc.accept(input.courseId, { featureIds: input.featureIds, dryRun: input.dryRun }),
            schema: AcceptInput,
            middleware: mw,
        },
    };
}
