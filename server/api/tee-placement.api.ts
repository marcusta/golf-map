import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TeePlacementService } from '../services/tee-placement.service';

// --- Input schemas ---

const ProposeInput = Type.Object({
    courseId: Type.String(),
});

const AcceptInput = Type.Object({
    courseId: Type.String(),
    /** Exactly these `<holeId>:<teeSetId>` spots; omitted = every new tee (`place`) of a fresh proposal. */
    keys: Type.Optional(Type.Array(Type.String())),
    dryRun: Type.Optional(Type.Boolean()),
});

// --- API descriptor ---

/**
 * The tees placed from the scorecard's lengths on the drawn tee shapes, along the line of play
 * (Furniture mode's "Place tees", `bun run tees:place` is the same service). Propose writes nothing.
 */
export function createTeePlacementApi(svc: TeePlacementService) {
    const mw = [requireAuth()];
    return {
        /** Every hole's tee of every set with a length: the spot, and what needs a look. */
        propose: {
            method: 'POST' as const,
            path: '/tee-placement/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId),
            schema: ProposeInput,
            middleware: mw,
        },
        /** Write the tees (one transaction). */
        accept: {
            method: 'POST' as const,
            path: '/tee-placement/accept',
            fn: (input: Static<typeof AcceptInput>) => svc.accept(input.courseId, { keys: input.keys, dryRun: input.dryRun }),
            schema: AcceptInput,
            middleware: mw,
        },
    };
}
