import { Signal } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../../api';
import type { CourseFeaturesApi, CourseFeatureFeatureCollection } from '../../../../shared/api/course-features.gen';

/**
 * Read-only loader for a course's RESOLVED feature GeoJSON (surface polygons,
 * already projected to WGS84 and clipped by the server — see
 * course-features.service.geojsonByCourse). The mobile map renders these as a
 * single fill layer; it never edits them, so unlike the desktop
 * FeaturesService (which lives in draw/ and is forbidden here) this is just a
 * cached fetch. Cached per courseId.
 */
export class FeaturesGeojsonService {
    readonly data = new Signal<CourseFeatureFeatureCollection | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);

    private loadedCourseId: string | null = null;

    constructor(private featuresApi: CourseFeaturesApi = api.courseFeatures) {}

    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        const fc = await request(this.loading, this.error, () =>
            this.featuresApi.geojsonByCourse({ courseId, resolved: true }));
        if (!fc) return; // failed — error signal set, cache untouched
        this.data.set(fc);
        this.loadedCourseId = courseId;
    }
}
