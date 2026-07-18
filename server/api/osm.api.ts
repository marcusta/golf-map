import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { OsmService } from '../services/osm.service';

// --- Input schemas ---

const FetchOsmInput = Type.Object({
    courseId: Type.String(),
});

// --- API descriptor ---

export function createOsmApi(svc: OsmService) {
    const mw = [requireAuth()];
    return {
        // One-click OSM import (T53): proxy the Overpass API for the
        // course's map area. POST — Overpass rate-limits, so each call
        // spends shared public quota. The bbox is derived server-side
        // (course georeference, else the site's tile-manifest bounds).
        fetchOsm: {
            method: 'POST' as const,
            path: '/course-features/fetch-osm',
            fn: (input: Static<typeof FetchOsmInput>) => svc.fetchForCourse(input.courseId),
            schema: FetchOsmInput,
            middleware: mw,
        },
    };
}
