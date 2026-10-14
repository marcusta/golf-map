import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GsproSyncService } from '../services/gspro-sync.service';
import { GSPRO_TARGET_IDS } from '../../shared/gspro-targets';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

/** A target id, or `stale` for every stale, unblocked target in board order. */
const UpdateInput = Type.Object({
    courseId: Type.String(),
    target: Type.Union([...GSPRO_TARGET_IDS.map(id => Type.Literal(id)), Type.Literal('stale')]),
    /** Render every file of the chain again, whatever its input fingerprint says (export-fingerprint.ts). */
    force: Type.Optional(Type.Boolean()),
});

const JobInput = Type.Object({
    jobId: Type.String(),
});

// --- API descriptor ---

/**
 * The GSPro status board (`server/services/gspro-sync.service.ts`): one row
 * per target with "last updated / what changed since / Update", and the
 * update job the board polls. Builder-only (see routes.ts), like the export
 * API next to it: it writes files to an operator-chosen folder, shells out to
 * the pipeline and Blender, and drives the local Unity editor.
 */
export function createGsproSyncApi(svc: GsproSyncService) {
    const mw = [requireAuth()];
    return {
        /** The whole board: the open Unity editors, the shaping worker, every target, the job and the queue. */
        status: {
            method: 'GET' as const,
            path: '/gspro-sync/status',
            fn: (input: Static<typeof CourseInput>) => svc.status(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /**
         * Update one target (the whole chain for it, both terrains, the files
         * and the Unity push) — or `stale` for every stale one. Returns at
         * once; `queued` while another update, export or shaping run of the
         * course is still going. Poll `job`. Each file is rendered only when
         * its inputs changed; `force` renders them all.
         */
        update: {
            method: 'POST' as const,
            path: '/gspro-sync/update',
            fn: (input: Static<typeof UpdateInput>) => svc.update(input.courseId, input.target, { force: input.force === true }),
            schema: UpdateInput,
            middleware: mw,
        },
        job: {
            method: 'GET' as const,
            path: '/gspro-sync/job',
            fn: (input: Static<typeof JobInput>) => svc.job(input.jobId),
            schema: JobInput,
            middleware: mw,
        },
        /** The `unity` part of `status` alone — what the command bar's Unity chip polls. */
        editors: {
            method: 'GET' as const,
            path: '/unity/editors',
            fn: (input: Static<typeof CourseInput>) => svc.unity(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
    };
}
