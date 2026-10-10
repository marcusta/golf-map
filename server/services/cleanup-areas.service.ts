import type { Kysely } from 'kysely';
import { NotFoundError } from '@basics/core/server/auth';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import type { Database } from '../db/schema';
import { cleanupAreaGeoJson, validateCleanupAreas, type CleanupArea, type CleanupAreasDocument } from '../../shared/cleanup-areas';

export class InvalidCleanupAreasError extends Error {}

/** The site owns these boundaries, just as it owns the cleaned photo. */
export class CleanupAreasService {
    constructor(private db: Kysely<Database>) {}

    private async site(courseId: string): Promise<string> {
        const course = await this.db.selectFrom('courses').select('site_id').where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course not found: ${courseId}`);
        if (!course.site_id) throw new InvalidCleanupAreasError('Build a map before defining cleanup areas.');
        return course.site_id;
    }

    async get(courseId: string): Promise<CleanupAreasDocument> {
        const siteId = await this.site(courseId);
        const row = await this.db.selectFrom('cleanup_areas').selectAll().where('site_id', '=', siteId).executeTakeFirst();
        return { siteId, version: row?.version ?? 0, areas: row ? JSON.parse(row.areas_json) : [] };
    }

    async save(courseId: string, version: number, areas: CleanupArea[]): Promise<CleanupAreasDocument> {
        try {
            validateCleanupAreas(areas);
            // Verify clipping now, so the server never stores an unexportable outline.
            cleanupAreaGeoJson({ siteId: '', version, areas });
        } catch (e) { throw new InvalidCleanupAreasError((e as Error).message); }
        const siteId = await this.site(courseId);
        const json = JSON.stringify(areas);
        if (version === 0) {
            const result = await this.db.insertInto('cleanup_areas').values({ site_id: siteId, version: 1, areas_json: json })
                .onConflict(oc => oc.column('site_id').doNothing()).returning('site_id').executeTakeFirst();
            if (!result) throw new VersionConflictError('cleanup_areas', siteId);
        } else {
            const result = await this.db.updateTable('cleanup_areas').set({ areas_json: json, version: version + 1 })
                .where('site_id', '=', siteId).where('version', '=', version).returning('site_id').executeTakeFirst();
            if (!result) throw new VersionConflictError('cleanup_areas', siteId);
        }
        return { siteId, version: version + 1, areas };
    }

    async export(courseId: string) {
        return cleanupAreaGeoJson(await this.get(courseId));
    }
}
