import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, SitesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

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

/** WGS84 bounds of a site's built map. */
export interface SiteMapBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** A site with what the site-management UI needs: its courses and its map. */
export interface SiteOverview extends Site {
    courses: SiteCourse[];
    /** Area of the last successful map build; null when the site has no build on record. */
    mapBounds: SiteMapBounds | null;
    mapBuiltAt: string | null;
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

function parseBounds(json: string): SiteMapBounds | null {
    try {
        const b = JSON.parse(json);
        const bounds = { west: b.west, south: b.south, east: b.east, north: b.north };
        return Object.values(bounds).every((v) => typeof v === 'number' && Number.isFinite(v)) ? bounds : null;
    } catch {
        return null;
    }
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

    /** Every site with its courses and the area of its last successful map build. */
    async overview(): Promise<SiteOverview[]> {
        const [sites, courses, builds] = await Promise.all([
            this.list(),
            this.db.selectFrom('courses').select(['id', 'name', 'site_id'])
                .where('site_id', 'is not', null).orderBy('name').execute(),
            // Oldest first, so the newest build per site wins the map below.
            this.db.selectFrom('map_build_jobs').select(['site_id', 'bbox_json', 'updated_at'])
                .where('site_id', 'is not', null).where('kind', '=', 'build').where('status', '=', 'succeeded')
                .orderBy('updated_at').execute(),
        ]);

        const lastBuild = new Map<string, { bounds: SiteMapBounds | null; at: string }>();
        for (const b of builds) lastBuild.set(b.site_id!, { bounds: parseBounds(b.bbox_json), at: b.updated_at });

        return sites.map((site) => ({
            ...site,
            courses: courses.filter((c) => c.site_id === site.id).map((c) => ({ id: c.id, name: c.name })),
            mapBounds: lastBuild.get(site.id)?.bounds ?? null,
            mapBuiltAt: lastBuild.get(site.id)?.at ?? null,
        }));
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

        // A site with courses owns the map those courses draw on. Deleting it
        // would strand them without tiles, so the caller detaches them first.
        const courses = await this.listCoursesForSite(id);
        if (courses.length > 0) {
            throw new ConflictError(`Site ${row.name} still has ${courses.length} course${courses.length === 1 ? '' : 's'}`);
        }

        // App-level referential integrity (site_id columns are unenforced): detach
        // referencing asset rows before deleting so nothing dangles.
        await this.db.updateTable('course_assets').where('site_id', '=', id).set({ site_id: null }).execute();
        await this.db.deleteFrom('sites').where('id', '=', id).execute();
    }
}
