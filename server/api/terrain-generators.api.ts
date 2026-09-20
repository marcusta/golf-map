import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TerrainGeneratorsService } from '../services/terrain-generators.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const GenerateInput = Type.Object({
    courseId: Type.String(),
    kind: Type.Union([Type.Literal('building-pads'), Type.Literal('road-grades')]),
});

// --- API descriptor ---

/**
 * One-click roads + buildings (T-roads). Builder-only (see routes.ts): both
 * shell out to the pipeline and write under `sources/<siteId>/`.
 */
export function createTerrainGeneratorsApi(svc: TerrainGeneratorsService) {
    const mw = [requireAuth()];
    return {
        // The OSM road network as corridor polygons for the import wizard
        // (POST: Overpass rate-limits, like fetch-osm).
        fetchRoads: {
            method: 'POST' as const,
            path: '/course-features/fetch-roads',
            fn: (input: Static<typeof CourseInput>) => svc.fetchRoads(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        // Building pads / road grades into the site's terrain_edits under
        // their origin, replacing that origin's previous generation.
        generate: {
            method: 'POST' as const,
            path: '/terrain-edits/generate',
            fn: (input: Static<typeof GenerateInput>) => svc.generate(input.courseId, input.kind),
            schema: GenerateInput,
            middleware: mw,
        },
    };
}
