import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { VegetationRulesService } from '../services/vegetation-rules.service';

const CourseInput = Type.Object({
    courseId: Type.String(),
});

/**
 * The planting rules of a course's vegetation, for reading (Vegetation mode's
 * "Planting rules" panel; `bun run vegetation:rules` prints the same).
 * Builder-only (see routes.ts): it reads the pipeline's rules files.
 */
export function createVegetationRulesApi(svc: VegetationRulesService) {
    const mw = [requireAuth()];
    return {
        /** Every generator's rules with the course's values, the tree rules and the tree species areas. */
        get: {
            method: 'GET' as const,
            path: '/vegetation-rules',
            fn: (input: Static<typeof CourseInput>) => svc.forCourse(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
    };
}
