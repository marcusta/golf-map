import { Signal } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../../api';
import type { CourseFeature, CourseFeaturesApi } from '../../../../shared/api/course-features.gen';

/**
 * Read-only loader for a course's RAW feature rows (EPSG:3006 bezier
 * geometry + ids), which the resolved GeoJSON the map renders does NOT carry.
 * The green screen needs both: the green feature's ID keys the DEM sample-grid
 * fetch, and its GEOMETRY is the frame the putt surface is sampled in.
 *
 * The desktop equivalent (draw/features.service) is an editing EntityStore in a
 * forbidden area; this is the read-only half — one cached fetch per course.
 * DI singleton.
 */
export class GreenFeaturesService {
    readonly items = new Signal<CourseFeature[]>([]);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);

    private loadedCourseId: string | null = null;

    constructor(private featuresApi: CourseFeaturesApi = api.courseFeatures) {}

    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        const rows = await request(this.loading, this.error, () =>
            this.featuresApi.listByCourse({ courseId }));
        if (!rows) return; // failed — error signal set, cache untouched
        this.items.set(rows);
        this.loadedCourseId = courseId;
    }
}
