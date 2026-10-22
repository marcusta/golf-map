import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { ScorecardService } from '../services/scorecard.service';

// --- Input schemas ---

const GetInput = Type.Object({
    courseId: Type.String(),
});

/** The card as text (holes across or down, rating lines) or JSON; shared/scorecard.ts. */
const Text = Type.String({ maxLength: 200_000 });
/** Lengths in metres or yards; omitted = what the text says. */
const Unit = Type.Optional(Type.Union([Type.Literal('m'), Type.Literal('yd')]));
/** A card label onto one of the course's tee set ids, or `new`, over the automatic match. */
const SetMap = Type.Optional(Type.Array(Type.Object({ label: Type.String(), teeSetId: Type.String() })));

const ProposeInput = Type.Object({
    courseId: Type.String(),
    text: Text,
    unit: Unit,
    map: SetMap,
});

const AcceptInput = Type.Object({
    courseId: Type.String(),
    text: Text,
    unit: Unit,
    map: SetMap,
    dryRun: Type.Optional(Type.Boolean()),
});

// --- API descriptor ---

/**
 * A club's scorecard into the course: par, stroke index, each tee set's hole lengths, ratings and slopes
 * (Furniture mode's "Scorecard", `bun run scorecard` is the same service). Propose writes nothing.
 */
export function createScorecardApi(svc: ScorecardService) {
    const mw = [requireAuth()];
    return {
        /** The lengths the course's tee sets hold. */
        get: {
            method: 'GET' as const,
            path: '/scorecard/by-course',
            fn: (input: Static<typeof GetInput>) => svc.get(input.courseId),
            schema: GetInput,
            middleware: mw,
        },
        /** The card read and matched to the course's sets: what accept would change. */
        propose: {
            method: 'POST' as const,
            path: '/scorecard/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId, { text: input.text, unit: input.unit, map: input.map }),
            schema: ProposeInput,
            middleware: mw,
        },
        /** Write it: new sets, par, stroke index, lengths, ratings. */
        accept: {
            method: 'POST' as const,
            path: '/scorecard/accept',
            fn: (input: Static<typeof AcceptInput>) => svc.accept(input.courseId, { text: input.text, unit: input.unit, map: input.map, dryRun: input.dryRun }),
            schema: AcceptInput,
            middleware: mw,
        },
    };
}
