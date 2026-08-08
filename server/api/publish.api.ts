import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PublishService } from '../services/publish.service';

const StartPublishInput = Type.Object({
    courseId: Type.String(),
});

// Builder-only (routes.ts): publishing is an authoring act — the serve box
// receives bundles via /api/ingest, it never originates them.
export function createPublishApi(svc: PublishService) {
    const mw = [requireAuth()];
    return {
        start: {
            method: 'POST' as const,
            path: '/publish/start',
            fn: (input: Static<typeof StartPublishInput>) => svc.start(input.courseId),
            schema: StartPublishInput,
            middleware: mw,
        },
        status: {
            method: 'GET' as const,
            path: '/publish/status',
            fn: () => svc.status(),
            middleware: mw,
        },
    };
}
