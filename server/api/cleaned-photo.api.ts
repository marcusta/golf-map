import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { CleanedPhotoService } from '../services/cleaned-photo.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---
//
// The photo download, the image upload and the Clean tool's pixel routes are
// raw Hono routes in `cleaned-photo.routes.ts` (file streams and raw request
// bodies, which `mount()` cannot carry).

export function createCleanedPhotoApi(svc: CleanedPhotoService) {
    const mw = [requireAuth()];
    return {
        // Back to the photo as it was before the last editing session or import.
        undoPhotoChange: {
            method: 'POST' as const,
            path: '/cleaned-photo/undo',
            fn: (input: Static<typeof CourseInput>) => svc.undo(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        cleanedPhotoInfo: {
            method: 'GET' as const,
            path: '/cleaned-photo/info',
            fn: (input: Static<typeof CourseInput>) => svc.info(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
    };
}
