// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CourseFeature {
    id: string;
    courseId: string;
    holeId: null | string;
    type: string;
    geometry: { crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; x: number; y: number }[] }[] };
    geojson: null | GeoJsonPolygon;
    version: number;
}

export interface CourseFeatureFeatureCollection {
    type: 'FeatureCollection';
    features: CourseFeatureGeoJsonFeature[];
}

export interface GeoJsonPolygon {
    type: 'Polygon';
    coordinates: number[][][];
}

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: { courseId: string; holeId: null | string; type: string };
    geometry: GeoJsonPolygon;
}

export interface CourseFeaturesApi {
    listByCourse(input: { courseId: string }): Promise<CourseFeature[]>;
    listByHole(input: { holeId: string }): Promise<CourseFeature[]>;
    geojsonByCourse(input: { courseId: string }): Promise<CourseFeatureFeatureCollection>;
    create(input: { holeId?: null | string; courseId: string; geometry: { crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; x: number; y: number }[] }[] }; type: string }): Promise<CourseFeature>;
    update(input: { geometry?: { crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; x: number; y: number }[] }[] }; holeId?: null | string; type?: string; id: string; version: number }): Promise<CourseFeature>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createCourseFeaturesClient(baseUrl: string): CourseFeaturesApi {
    return {
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/features${qs ? '?' + qs : ''}` });
        },
        async listByHole(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/features/by-hole${qs ? '?' + qs : ''}` });
        },
        async geojsonByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/features.geojson${qs ? '?' + qs : ''}` });
        },
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/create`, body: input });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/remove`, body: input });
        },
    };
}
