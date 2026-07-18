import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { HydroService } from '../services/hydro.service';

// --- Input schemas ---

const FetchHydroInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---

export function createHydroApi(svc: HydroService) {
    const mw = [requireAuth()];
    return {
        // One-click water import (T50): proxy Lantmäteriet Hydrografi Direkt
        // for the course's map area. POST — each call spends external API
        // quota. The bbox is derived server-side (course georeference, else
        // the site's tile-manifest bounds).
        fetchHydro: {
            method: 'POST' as const,
            path: '/course-features/fetch-hydro',
            fn: (input: Static<typeof FetchHydroInput>) => svc.fetchForCourse(input.courseId),
            schema: FetchHydroInput,
            middleware: mw,
        },
    };
}
