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

const EnsureOrthoInput = Type.Object({
    courseId: Type.String(),
    collection: Type.String(),
});

const CourseLidarInput = Type.Object({
    courseId: Type.String(),
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
        ensureOrtho: {
            method: 'POST' as const,
            path: '/mapbuild/ensure-ortho',
            fn: (input: Static<typeof EnsureOrthoInput>) => svc.ensureOrthoTiled(input.courseId, input.collection),
            schema: EnsureOrthoInput,
            middleware: mw,
        },
        // Persisted lidar (.laz) source assets — listed for the editor menu and
        // deleted on explicit user action (builds no longer auto-delete them).
        lidarInfo: {
            method: 'GET' as const,
            path: '/mapbuild/lidar',
            fn: (input: Static<typeof CourseLidarInput>) => svc.lidarInfo(input.courseId),
            schema: CourseLidarInput,
            middleware: mw,
        },
        deleteLidar: {
            method: 'POST' as const,
            path: '/mapbuild/lidar/delete',
            fn: (input: Static<typeof CourseLidarInput>) => svc.deleteLidar(input.courseId),
            schema: CourseLidarInput,
            middleware: mw,
        },
    };
}
