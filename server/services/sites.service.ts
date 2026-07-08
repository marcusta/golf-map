import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, SitesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Site {
    id: string;
    name: string;
    notes: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

/** A course that uses a given site's map (for the site's course list). */
export interface SiteCourse {
    id: string;
    name: string;
}

// --- Row mapping ---

type SiteRow = Selectable<SitesTable>;

function toSite(row: SiteRow): Site {
    return {
        id: row.id,
        name: row.name,
        notes: row.notes,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * A physical location that owns a shared map (ortho/terrain/DEM/manifest, later
 * SVG). Multiple courses reference one site and share its map; the build targets
 * a site. A golf club (org) above sites is deferred.
 */
export class SitesService {
    constructor(private db: Kysely<Database>) {}

    private sites() {
        return this.db.selectFrom('sites').selectAll();
    }

    private byId(id: string) {
        return this.sites().where('id', '=', id);
    }

    async list(): Promise<Site[]> {
        const rows = await this.sites().orderBy('name').execute();
        return rows.map(toSite);
    }

    async get(id: string): Promise<Site> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Site ${id} not found`);
        return toSite(row);
    }

    async listCoursesForSite(siteId: string): Promise<SiteCourse[]> {
        const rows = await this.db
            .selectFrom('courses')
            .select(['id', 'name'])
            .where('site_id', '=', siteId)
            .orderBy('name')
            .execute();
        return rows.map((r) => ({ id: r.id, name: r.name }));
    }

    async create(input: { id?: string; name: string; notes?: string }): Promise<Site> {
        const id = input.id ?? crypto.randomUUID();
        await this.db.insertInto('sites').values({
            id,
            name: input.name,
            notes: input.notes ?? null,
            version: 1,
        }).execute();
        return this.get(id);
    }

    async update(id: string, version: number, patch: { name?: string; notes?: string }): Promise<Site> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Site ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('sites', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.name !== undefined) dbInput.name = patch.name;
        if (patch.notes !== undefined) dbInput.notes = patch.notes;

        await this.db.updateTable('sites').where('id', '=', id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Site ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('sites', id);

        // App-level referential integrity (site_id columns are unenforced): detach
        // referencing rows before deleting so nothing dangles.
        await this.db.updateTable('courses').where('site_id', '=', id).set({ site_id: null }).execute();
        await this.db.updateTable('course_assets').where('site_id', '=', id).set({ site_id: null }).execute();
        await this.db.deleteFrom('sites').where('id', '=', id).execute();
    }
}
