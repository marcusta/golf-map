// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface CourseFeature {
    id: string;
    courseId: string;
    holeId: null | string;
    layer: null | 'roughs';
    type: string;
    geometry: { curveType?: 'bezier' | 'bspline'; centerline?: { startCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; endCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; points: { corner?: boolean; x: number; y: number }[]; widthM: number }; crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; corner?: boolean; x: number; y: number }[] }[] };
    sortOrder: number;
    source: null | string;
    generated: boolean;
    sourceRef: null | string;
    license: null | string;
    attributes: null | FeatureAttributes;
    no: null | number;
    version: number;
}

export interface CourseFeatureFeatureCollection {
    type: 'FeatureCollection';
    features: CourseFeatureGeoJsonFeature[];
    attribution?: string;
}

export interface ImportedFeatureCount {
    source: string;
    type: string;
    count: number;
}

export interface FeatureAttributes {

}

export interface CourseFeatureGeoJsonFeature {
    type: 'Feature';
    id: string;
    properties: { courseId: string; holeId: null | string; layer: null | 'roughs'; type: string; sortOrder: number; stackKey: number; source: null | string; sourceRef: null | string; license: null | string; attributes: null | FeatureAttributes };
    geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
}

export interface GeoJsonPolygon {
    type: 'Polygon';
    coordinates: number[][][];
}

export interface GeoJsonMultiPolygon {
    type: 'MultiPolygon';
    coordinates: number[][][][];
}

export interface CourseFeaturesApi {
    listByCourse(input: { courseId: string }): Promise<CourseFeature[]>;
    listByHole(input: { holeId: string }): Promise<CourseFeature[]>;
    geojsonByCourse(input: { resolved?: boolean; courseId: string }): Promise<CourseFeatureFeatureCollection>;
    create(input: { holeId?: null | string; layer?: null | 'roughs'; source?: string; sourceRef?: string; license?: string; attributes?: null | { [x: string]: string | number | boolean | { id: string; pattern: 'soft-fade' | 'overgrown-gravel' | 'wheel-tracks'; placement: 'start' | 'end' | 'section'; startM: number; direction: 1 | -1; transitionLengthM: number; holdLengthM: number; fadeLengthM: number; ending: 'grass' | 'continue'; edgeIrregularity: number; dirtAmount: number; centerGrassReachM: number; trackWidthM: number; trackSpacingM: number; variation: number; seed: number; }[]; }; courseId: string; geometry: { curveType?: 'bezier' | 'bspline'; centerline?: { startCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; endCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; points: { corner?: boolean; x: number; y: number }[]; widthM: number }; crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; corner?: boolean; x: number; y: number }[] }[] }; type: string }): Promise<CourseFeature>;
    update(input: { holeId?: null | string; geometry?: { curveType?: 'bezier' | 'bspline'; centerline?: { startCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; endCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; points: { corner?: boolean; x: number; y: number }[]; widthM: number }; crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; corner?: boolean; x: number; y: number }[] }[] }; layer?: null | 'roughs'; type?: string; attributes?: null | { [x: string]: string | number | boolean | { id: string; pattern: 'soft-fade' | 'overgrown-gravel' | 'wheel-tracks'; placement: 'start' | 'end' | 'section'; startM: number; direction: 1 | -1; transitionLengthM: number; holdLengthM: number; fadeLengthM: number; ending: 'grass' | 'continue'; edgeIrregularity: number; dirtAmount: number; centerGrassReachM: number; trackWidthM: number; trackSpacingM: number; variation: number; seed: number; }[]; }; id: string; version: number }): Promise<CourseFeature>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    imported(input: { courseId: string }): Promise<ImportedFeatureCount[]>;
    removeImported(input: { types?: string[]; courseId: string; sources: string[] }): Promise<{ removed: number }>;
    createMany(input: { courseId: string; items: ({ holeId?: null | string; layer?: null | 'roughs'; source?: string; sourceRef?: string; license?: string; attributes?: null | { [x: string]: string | number | boolean | { id: string; pattern: 'soft-fade' | 'overgrown-gravel' | 'wheel-tracks'; placement: 'start' | 'end' | 'section'; startM: number; direction: 1 | -1; transitionLengthM: number; holdLengthM: number; fadeLengthM: number; ending: 'grass' | 'continue'; edgeIrregularity: number; dirtAmount: number; centerGrassReachM: number; trackWidthM: number; trackSpacingM: number; variation: number; seed: number; }[]; }; geometry: { curveType?: 'bezier' | 'bspline'; centerline?: { startCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; endCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; points: { corner?: boolean; x: number; y: number }[]; widthM: number }; crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; corner?: boolean; x: number; y: number }[] }[] }; type: string })[] }): Promise<CourseFeature[]>;
    updateMany(input: { items: ({ holeId?: null | string; geometry?: { curveType?: 'bezier' | 'bspline'; centerline?: { startCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; endCap?: { rounding?: number; diameterM?: number; lengthM?: number; endWidthM?: number; shape: 'rounded' | 'turning' | 'taper' }; points: { corner?: boolean; x: number; y: number }[]; widthM: number }; crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; corner?: boolean; x: number; y: number }[] }[] }; layer?: null | 'roughs'; type?: string; attributes?: null | { [x: string]: string | number | boolean | { id: string; pattern: 'soft-fade' | 'overgrown-gravel' | 'wheel-tracks'; placement: 'start' | 'end' | 'section'; startM: number; direction: 1 | -1; transitionLengthM: number; holdLengthM: number; fadeLengthM: number; ending: 'grass' | 'continue'; edgeIrregularity: number; dirtAmount: number; centerGrassReachM: number; trackWidthM: number; trackSpacingM: number; variation: number; seed: number; }[]; }; id: string; version: number })[] }): Promise<CourseFeature[]>;
    removeMany(input: { items: { id: string; version: number }[] }): Promise<{ ok: boolean }>;
    reorder(input: { holeId?: null | string; layer?: null | 'roughs'; orderedIds: string[]; courseId: string }): Promise<{ ok: boolean }>;
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
        async imported(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/course-features/imported${qs ? '?' + qs : ''}` });
        },
        async removeImported(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/remove-imported`, body: input });
        },
        async createMany(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/create-many`, body: input });
        },
        async updateMany(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/update-many`, body: input });
        },
        async removeMany(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/features/remove-many`, body: input });
        },
        async reorder(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/reorder`, body: input });
        },
    };
}
