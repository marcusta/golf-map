import { Signal } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { SitesApi, SiteOverview, SiteMapBounds } from '../../../shared/api/sites.gen';
import type { CoursesApi, Course, CourseSummary } from '../../../shared/api/courses.gen';

/** The server caps a course page at 100 rows. */
const COURSE_PAGE = 100;

export function boundsCenter(b: SiteMapBounds): { lat: number; lon: number } {
    return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

/**
 * Site setup: a site owns the map, its courses share it. Backs the sites page
 * and the new-course wizard's site step.
 *
 * Writes re-read the overview instead of patching it locally. Every write
 * changes a version the next write needs, and the lists are short.
 */
export class SitesService {
    readonly sites = new Signal<SiteOverview[]>([]);
    /** Courses with no site, so no map. */
    readonly unassigned = new Signal<CourseSummary[]>([]);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** Bumps on every successful write; the course list reloads when it sees a new value. */
    readonly revision = new Signal(0);

    constructor(
        private sitesApi: SitesApi = api.sites,
        private coursesApi: CoursesApi = api.courses,
    ) {}

    async load(): Promise<void> {
        await request(this.loading, this.error, () => this.fetch());
    }

    private async fetch(): Promise<void> {
        const [sites, courses] = await Promise.all([this.sitesApi.overview(), this.allCourses()]);
        this.sites.set(sites);
        this.unassigned.set(courses.filter(c => c.siteId === null));
    }

    private async allCourses(): Promise<CourseSummary[]> {
        const all: CourseSummary[] = [];
        for (;;) {
            const page = await this.coursesApi.list({ offset: all.length, limit: COURSE_PAGE });
            all.push(...page.items);
            if (page.items.length === 0 || all.length >= page.total) return all;
        }
    }

    renameSite(id: string, name: string): Promise<boolean> {
        const site = this.site(id);
        const next = name.trim();
        if (!site || !next || next === site.name) return Promise.resolve(false);
        return this.write(() => this.sitesApi.update({ id, version: site.version, name: next }));
    }

    setSiteNotes(id: string, notes: string): Promise<boolean> {
        const site = this.site(id);
        if (!site || notes === (site.notes ?? '')) return Promise.resolve(false);
        return this.write(() => this.sitesApi.update({ id, version: site.version, notes }));
    }

    /** The server refuses while courses are attached; the caller detaches them first. */
    removeSite(id: string): Promise<boolean> {
        const site = this.site(id);
        if (!site) return Promise.resolve(false);
        return this.write(() => this.sitesApi.remove({ id, version: site.version }));
    }

    renameCourse(courseId: string, name: string): Promise<boolean> {
        const next = name.trim();
        if (!next) return Promise.resolve(false);
        return this.write(async () => {
            // The overview carries no course version, so read it at write time.
            const course = await this.coursesApi.get({ id: courseId });
            if (course.name !== next) await this.coursesApi.update({ id: courseId, version: course.version, name: next });
        });
    }

    /** Detach a course from its site. The course keeps its holes and features and loses its map. */
    detachCourse(courseId: string): Promise<boolean> {
        return this.write(async () => {
            const course = await this.coursesApi.get({ id: courseId });
            await this.coursesApi.update({ id: courseId, version: course.version, siteId: null });
        });
    }

    /** Add a course on an existing site. No build: the course uses the site's map as it is. */
    async addCourse(siteId: string, name: string): Promise<Course | null> {
        const bounds = this.site(siteId)?.mapBounds ?? null;
        const home = bounds ? boundsCenter(bounds) : null;
        let created: Course | null = null;
        await this.write(async () => {
            created = await this.coursesApi.create({
                name: name.trim(),
                siteId,
                ...(home ? { homeLat: home.lat, homeLon: home.lon } : {}),
            });
        });
        return created;
    }

    /**
     * Create a site and its first course. The site is created first so it gets
     * its own name: a build started for a course without a site names the new
     * site after the course.
     */
    async createSiteWithCourse(input: {
        siteName: string;
        courseName: string;
        home: { lat: number; lon: number };
    }): Promise<Course | null> {
        let created: Course | null = null;
        await this.write(async () => {
            const site = await this.sitesApi.create({ name: input.siteName.trim() });
            try {
                created = await this.coursesApi.create({
                    name: input.courseName.trim(),
                    siteId: site.id,
                    homeLat: input.home.lat,
                    homeLon: input.home.lon,
                });
            } catch (err) {
                // Do not leave an empty site behind for the retry to duplicate.
                await this.sitesApi.remove({ id: site.id, version: site.version }).catch(() => {});
                throw err;
            }
        });
        return created;
    }

    private site(id: string): SiteOverview | undefined {
        return this.sites.get().find(s => s.id === id);
    }

    private async write(op: () => Promise<unknown>): Promise<boolean> {
        const done = await request(this.loading, this.error, async () => { await op(); return true; });
        // Re-read on failure too: a 409 means the local versions are stale. Not
        // through load(), which would clear the error the failed write just set.
        await this.fetch().catch(() => {});
        if (done) this.revision.update(n => n + 1);
        return done === true;
    }
}
