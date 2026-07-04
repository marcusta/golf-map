import { Signal, Computed, effect } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { CourseFeature, CourseFeaturesApi } from '../../../shared/api/course-features.gen';
import type { FeatureCollection, Feature, Polygon } from 'geojson';
import { flattenRing, type FeatureGeometry } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { MapService } from '../map/map.service';
import { typeColorExpression, SELECTION_COLOR } from './feature-palette';

/** Flattening tolerance in meters — matches the server's GeoJSON derivation. */
export const FLATTEN_TOLERANCE_M = 0.25;

/** Overlay/source id for the persistent course-features rendering. */
export const FEATURES_OVERLAY_ID = 'features';

// Flattened + reprojected rings are cached per geometry OBJECT — geometry
// is replaced wholesale on every edit, so identity keying is exact and the
// WeakMap lets dropped geometries collect.
const wgs84RingsCache = new WeakMap<object, number[][][]>();

/** Geometry (EPSG:3006 bezier rings) → closed WGS84 GeoJSON rings. */
export function geometryToWgs84Rings(geometry: FeatureGeometry): number[][][] {
    const cached = wgs84RingsCache.get(geometry);
    if (cached) return cached;
    const rings = geometry.rings.map(ring => {
        const flat = flattenRing(ring, FLATTEN_TOLERANCE_M);
        const coords = flat.map(([x, y]) => {
            const { lat, lon } = sweref99tmToWgs84(x, y);
            return [lon, lat];
        });
        if (coords.length > 0) coords.push(coords[0]); // explicit ring closure
        return coords;
    });
    wgs84RingsCache.set(geometry, rings);
    return rings;
}

/**
 * Course features for the editor: EntityStore keyed by feature id, CRUD
 * against the courseFeatures API with optimistic locking (version), a
 * selection signal, and a Computed WGS84 FeatureCollection that renders as
 * a persistent MapService overlay (see `attachOverlay`).
 *
 * Geometry lives in EPSG:3006 bezier rings (the canonical model); the
 * FeatureCollection is derived client-side with the same flattening
 * tolerance and transform as the server, so what you see while editing is
 * what the server materializes.
 *
 * DI singleton. `load()` is cached per courseId; editing tools call
 * `patchLocal` for per-frame local updates (no network) and the `save*` /
 * `create` / `removeFeature` methods to persist (autosave). Save failures
 * set `saveError` and re-sync the store from the server.
 */
export class FeaturesService {
    readonly store = new EntityStore<CourseFeature>();
    /** Selected feature id (draw tool selection), or null. */
    readonly selectedId = new Signal<string | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove is in flight (autosave indicator). */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    private loadedCourseId: string | null = null;

    /** The currently selected feature, or null. */
    readonly selected = new Computed<CourseFeature | null>(() => {
        const id = this.selectedId.get();
        if (!id) return null;
        return this.store.items.get().find(f => f.id === id) ?? null;
    });

    /**
     * All features as a WGS84 FeatureCollection with rendering properties
     * (`type`, `holeId`, `selected`). Recomputes on store changes and
     * selection changes; unchanged geometries hit the flatten cache.
     */
    readonly geojson = new Computed<FeatureCollection>(() => {
        const selectedId = this.selectedId.get();
        const features: Feature[] = this.store.items.get().map(f => ({
            type: 'Feature',
            id: f.id,
            properties: {
                id: f.id,
                type: f.type,
                holeId: f.holeId,
                selected: f.id === selectedId,
            },
            geometry: {
                type: 'Polygon',
                coordinates: geometryToWgs84Rings(f.geometry),
            } satisfies Polygon,
        }));
        return { type: 'FeatureCollection', features };
    });

    constructor(private featuresApi: CourseFeaturesApi = api.courseFeatures) {}

    /** Load all features for a course. Cached per courseId. */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        this.selectedId.set(null);
        const items = await request(this.loading, this.error, () =>
            this.featuresApi.listByCourse({ courseId }));
        if (!items) return; // failed — error signal set, cache untouched
        this.store.set(items);
        this.loadedCourseId = courseId;
    }

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.loadedCourseId = null;
        await this.load(courseId);
    }

    select(id: string | null): void {
        this.selectedId.set(id);
    }

    /** Create a feature (autosave on ring close). Selects it on success. */
    async create(input: {
        type: string;
        holeId?: string | null;
        geometry: FeatureGeometry;
    }): Promise<CourseFeature | undefined> {
        const courseId = this.loadedCourseId;
        if (!courseId) return undefined;
        const created = await request(this.saving, this.saveError, () =>
            this.featuresApi.create({ courseId, ...input }));
        if (created) {
            this.store.add(created);
            this.selectedId.set(created.id);
        }
        return created;
    }

    /**
     * Local-only geometry patch for per-frame edit feedback (vertex drags).
     * No network; the version is unchanged so a later `update` still uses
     * the correct optimistic-locking version.
     */
    patchLocal(id: string, geometry: FeatureGeometry): void {
        const current = this.store.items.peek().find(f => f.id === id);
        if (!current) return;
        this.store.patch({ ...current, geometry });
    }

    /**
     * Persist a partial update (geometry / type / holeId) with optimistic
     * locking. On version conflict or other failure, `saveError` is set and
     * the store re-syncs from the server (dropping local patches).
     */
    async update(
        id: string,
        patch: { geometry?: FeatureGeometry; type?: string; holeId?: string | null },
    ): Promise<CourseFeature | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.store.mutate(id, version => this.featuresApi.update({ id, version: version!, ...patch })));
        if (result === undefined) void this.reload();
        return result;
    }

    /** Delete a feature (uses the store's current version). Deselects it. */
    async removeFeature(id: string): Promise<boolean> {
        const current = this.store.items.peek().find(f => f.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.featuresApi.remove({ id, version: current.version }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        this.store.remove(id);
        if (this.selectedId.peek() === id) this.selectedId.set(null);
        return true;
    }

    /**
     * Bind the persistent features overlay to the map: adds fill + outline
     * + selection-highlight layers when the map is ready, keeps the data in
     * sync with `geojson`, and re-adds after map re-creation (`ready`
     * false → true). Returns a disposer (give it to a component `track`).
     */
    attachOverlay(map: MapService): () => void {
        let added = false;
        const disposeEffect = effect(() => {
            const ready = map.ready.get();
            const data = this.geojson.get();
            if (!ready) {
                added = false; // overlay died with the map
                return;
            }
            if (!added) {
                map.addOverlayLayer(FEATURES_OVERLAY_ID, data, [
                    {
                        id: 'features-fill',
                        type: 'fill',
                        paint: {
                            'fill-color': typeColorExpression('fill') as never,
                            'fill-opacity': 0.4,
                        },
                    },
                    {
                        id: 'features-outline',
                        type: 'line',
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                        },
                    },
                    {
                        id: 'features-selected',
                        type: 'line',
                        filter: ['==', ['get', 'selected'], true],
                        paint: {
                            'line-color': SELECTION_COLOR,
                            'line-width': 2.5,
                        },
                    },
                ]);
                added = true;
            } else {
                map.updateOverlayData(FEATURES_OVERLAY_ID, data);
            }
        });
        return () => {
            disposeEffect();
            if (added) map.removeOverlayLayer(FEATURES_OVERLAY_ID);
        };
    }
}
