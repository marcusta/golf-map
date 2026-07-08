import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { MapBuildService } from '../services/map-build.service';

// --- Input schemas ---

const BboxSchema = Type.Object({
    west: Type.Number(),
    south: Type.Number(),
    east: Type.Number(),
    north: Type.Number(),
});

const StartBuildInput = Type.Object({
    courseId: Type.String(),
    bbox: BboxSchema,
});

const GetJobInput = Type.Object({
    jobId: Type.String(),
});

const LatestForCourseInput = Type.Object({
    courseId: Type.String(),
});

const SetOrthoInput = Type.Object({
    courseId: Type.String(),
    collection: Type.String(),
});

// --- API descriptor ---

export function createMapBuildApi(svc: MapBuildService) {
    const mw = [requireAuth()];
    return {
        start: {
            method: 'POST' as const,
            path: '/mapbuild/start',
            fn: (input: Static<typeof StartBuildInput>) => svc.start(input.courseId, input.bbox),
            schema: StartBuildInput,
            middleware: mw,
        },
        status: {
            method: 'GET' as const,
            path: '/mapbuild/status',
            fn: (input: Static<typeof GetJobInput>) => svc.get(input.jobId),
            schema: GetJobInput,
            middleware: mw,
        },
        latest: {
            method: 'GET' as const,
            path: '/mapbuild/latest',
            fn: (input: Static<typeof LatestForCourseInput>) => svc.latestForCourse(input.courseId),
            schema: LatestForCourseInput,
            middleware: mw,
        },
        setOrtho: {
            method: 'POST' as const,
            path: '/mapbuild/set-ortho',
            fn: (input: Static<typeof SetOrthoInput>) => svc.setActiveOrtho(input.courseId, input.collection),
            schema: SetOrthoInput,
            middleware: mw,
        },
    };
}
