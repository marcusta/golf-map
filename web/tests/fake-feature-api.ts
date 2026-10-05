// Test support for the courseFeatures API fakes (not a test file).
import { ApiError } from '@basics/core/client/api-error';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

/**
 * Adds createMany / updateMany / removeMany to an in-memory fake that already
 * implements create / update / remove over `rows`. Same contract as the
 * server: every version is checked before anything is written, and one
 * conflict (or a missing row) rejects the whole batch with a 409.
 */
export function withBatchEndpoints(api: CourseFeaturesApi, rows: Map<string, CourseFeature>): CourseFeaturesApi {
    const single = { create: api.create, update: api.update, remove: api.remove };
    const assertVersions = (items: { id: string; version: number }[]) => {
        for (const item of items) {
            const row = rows.get(item.id);
            if (!row || row.version !== item.version) throw new ApiError(409, 'Version conflict');
        }
    };
    api.createMany = async ({ courseId, items }) => {
        const created: CourseFeature[] = [];
        for (const item of items) created.push(await single.create({ courseId, ...item }));
        return created;
    };
    api.updateMany = async ({ items }) => {
        assertVersions(items);
        const updated: CourseFeature[] = [];
        for (const item of items) updated.push(await single.update(item));
        return updated;
    };
    api.removeMany = async ({ items }) => {
        assertVersions(items);
        for (const item of items) await single.remove(item);
        return { ok: true };
    };
    return api;
}

/**
 * Wraps every API method so each call appends its method name to `log`
 * (one entry per HTTP request the real client would send). Calls made
 * inside a batch fake to the single-row methods are not logged.
 */
export function recordRequests(api: CourseFeaturesApi): { api: CourseFeaturesApi; log: string[] } {
    const log: string[] = [];
    const wrapped = {} as Record<string, unknown>;
    for (const [name, fn] of Object.entries(api)) {
        wrapped[name] = (...args: unknown[]) => {
            log.push(name);
            return (fn as (...a: unknown[]) => unknown)(...args);
        };
    }
    return { api: wrapped as unknown as CourseFeaturesApi, log };
}
