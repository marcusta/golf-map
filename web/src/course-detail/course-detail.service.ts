import { Signal, Computed, batch } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { Course, CoursesApi } from '../../../shared/api/courses.gen';
import type { Hole, HolesApi } from '../../../shared/api/holes.gen';

export class CourseDetailService {
    readonly course = new Signal<Course | null>(null);
    readonly holes = new Signal<Hole[]>([]);
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
                this.holes.set([...data.holes].sort((a, b) => a.number - b.number));
            });
            this.loadedCourseId = courseId;
        }
    }
}
