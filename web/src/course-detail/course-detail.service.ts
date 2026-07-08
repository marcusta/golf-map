import { Signal, Computed, batch } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { Course, CoursesApi } from '../../../shared/api/courses.gen';
import type { Hole, HolesApi } from '../../../shared/api/holes.gen';

export class CourseDetailService {
    readonly course = new Signal<Course | null>(null);
    /** Per-hole signals so $each rows re-render on single-hole edits. */
    readonly holeStore = new EntityStore<Hole>();
    readonly holes = this.holeStore.items;
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a publish request is in flight. */
    readonly publishing = new Signal(false);
    readonly publishError = new Signal<RequestError | null>(null);
    private loadedCourseId: string | null = null;

    readonly totalPar = new Computed(() =>
        this.holes.get().reduce((sum, hole) => sum + hole.par, 0)
    );

    constructor(
        private coursesApi: CoursesApi = api.courses,
        private holesApi: HolesApi = api.holes,
    ) {}

    /**
     * Publish the loaded course: bumps `revision` (the device-sync cache
     * key) and sets status `published`, using the loaded course's version
     * for optimistic locking. On success the course signal is replaced
     * with the server row (new status/revision/version); on failure
     * `publishError` is set and the course is refetched so a stale
     * version self-heals for the next attempt.
     */
    async publish(): Promise<Course | undefined> {
        const current = this.course.peek();
        if (!current) return undefined;
        const updated = await request(this.publishing, this.publishError, () =>
            this.coursesApi.publish({ id: current.id, version: current.version }));
        if (updated) {
            this.course.set(updated);
        } else {
            this.loadedCourseId = null;
            void this.load(current.id);
        }
        return updated;
    }

    /**
     * Update a hole (par / stroke index) with optimistic locking. Patches the
     * `holes` signal in place with the server row on success (new version). On
     * a version conflict the hole is refetched so the next edit self-heals, and
     * `error` is set. Returns the updated hole or undefined on failure.
     *
     * A blank stroke index is expressed as `strokeIndex: null` (clears it);
     * omitting the field leaves it untouched.
     */
    async updateHole(id: string, patch: { par?: number; strokeIndex?: number | null }): Promise<Hole | undefined> {
        const current = this.holes.peek().find(h => h.id === id);
        if (!current) return undefined;
        const updated = await request(this.loading, this.error, () =>
            this.holesApi.update({ id, version: current.version, ...patch }));
        if (updated) {
            this.holeStore.patch(updated);
            return updated;
        }
        // Conflict/failure — refetch just this hole so its version self-heals.
        const fresh = await request(this.loading, this.error, () => this.holesApi.get({ id }));
        if (fresh) this.holeStore.patch(fresh);
        return undefined;
    }

    /** Append a new hole at the next course number and add it to the loaded sidebar state. */
    async addHole(par = 4): Promise<Hole | undefined> {
        const course = this.course.peek();
        if (!course) return undefined;
        const holes = this.holes.peek();
        const nextNumber = holes.reduce((max, hole) => Math.max(max, hole.number), 0) + 1;
        const created = await request(this.loading, this.error, () =>
            this.holesApi.create({ courseId: course.id, number: nextNumber, par }));
        if (created) {
            this.holeStore.set([...this.holes.peek(), created].sort((a, b) => a.number - b.number));
            return created;
        }
        await this.reloadHoles(course.id);
        return undefined;
    }

    /**
     * Delete a hole and replace local state from the server so compacted hole
     * numbers, cascaded rows, and version bumps are reflected immediately.
     */
    async removeHole(id: string): Promise<boolean> {
        const current = this.holes.peek().find(h => h.id === id);
        if (!current) return false;
        const result = await request(this.loading, this.error, () =>
            this.holesApi.remove({ id, version: current.version }));
        if (result !== undefined) {
            await this.reloadHoles(current.courseId);
            return true;
        }
        const shouldRetry = this.error.peek()?.code === 'conflict';
        await this.reloadHoles(current.courseId);
        if (!shouldRetry) return false;

        const fresh = this.holes.peek().find(h => h.id === id);
        if (!fresh) return true;
        const retry = await request(this.loading, this.error, () =>
            this.holesApi.remove({ id, version: fresh.version }));
        await this.reloadHoles(current.courseId);
        return retry !== undefined;
    }

    /** Load course + holes. Cached per courseId — only refetches when the id changes. */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        const data = await request(this.loading, this.error, async () => {
            const [course, holes] = await Promise.all([
                this.coursesApi.get({ id: courseId }),
                this.holesApi.listByCourse({ courseId }),
            ]);
            return { course, holes };
        });
        if (data) {
            batch(() => {
                this.course.set(data.course);
                this.holeStore.set([...data.holes].sort((a, b) => a.number - b.number));
            });
            this.loadedCourseId = courseId;
        }
    }

    async reloadHoles(courseId: string): Promise<void> {
        const holes = await request(this.loading, this.error, () =>
            this.holesApi.listByCourse({ courseId }));
        if (holes) this.holeStore.set([...holes].sort((a, b) => a.number - b.number));
    }
}
