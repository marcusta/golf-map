import { Type, type Static } from '@sinclair/typebox';
import type { MiddlewareHandler } from 'hono';
import { requireAuth } from '@basics/core/server/auth';
import type { BunkerProposalsService } from '../services/bunker-proposals.service';
import { liftIdleTimeout } from './cleaned-photo.routes';

/** The model can run past Bun's 10 s idle timeout (a minute on the GPU, longer without). */
const noIdleTimeout: MiddlewareHandler = async (c, next) => {
    liftIdleTimeout(c);
    await next();
};

// --- Input schemas ---

const ProposeInput = Type.Object({
    courseId: Type.String(),
    /** Propose and keep nothing (no proposal kept for the CLI to add from). */
    dryRun: Type.Optional(Type.Boolean()),
});

const SkipInput = Type.Object({
    courseId: Type.String(),
    /** Ids of the last proposal no later proposal offers again. */
    ids: Type.Array(Type.String()),
});

// --- API descriptor ---

/**
 * Bunker proposals (the Draw mode's "Find bunkers"; `bun run bunkers` is the same service): the bunkers the
 * course-surface model finds on the photo, edges from its NIR band, each with its hole. Builder-only: runs the
 * pipeline on the site's photo. The caller adds the ones kept as features (FeaturesService.createMany).
 */
export function createBunkerProposalsApi(svc: BunkerProposalsService) {
    const mw = [requireAuth()];
    return {
        /** The bunkers the model finds that are neither drawn on the site nor skipped. */
        propose: {
            method: 'POST' as const,
            path: '/bunker-proposals/propose',
            fn: (input: Static<typeof ProposeInput>) => svc.propose(input.courseId, { dryRun: input.dryRun }),
            schema: ProposeInput,
            middleware: [...mw, noIdleTimeout],
        },
        /** Turn proposals down for good. */
        skip: {
            method: 'POST' as const,
            path: '/bunker-proposals/skip',
            fn: (input: Static<typeof SkipInput>) => svc.skip(input.courseId, { ids: input.ids }),
            schema: SkipInput,
            middleware: mw,
        },
    };
}
