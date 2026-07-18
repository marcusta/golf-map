// GeoJSON draft-import wizard state (T43). Mirrors SvgImportService — the
// import flow for one course at a time: load .geojson text → parse +
// CRS-validate (geojson-parse.ts) → bucket features by a chosen property →
// user assigns each bucket a feature type (or skip) → build straight-segment
// FeatureGeometries (preview overlay rendered by GeojsonImportPanelComponent
// from `built`) → bulk-create through the course-features API.
//
// Strictly feature-source-agnostic: fetch-water (T43), fetch-osm (T44) and
// detect-trees (T46) all feed it the same EPSG:3006 typed-polygon files.
//
// DI singleton; the panel component (geojson-import-panel.component.ts) is
// the only UI. Testable headlessly: constructor takes the features API
// client.

import { Signal, Computed, batch } from '@basics/core/client/core';
import { api } from '../api';
import type { CourseFeaturesApi } from '../../../shared/api/course-features.gen';
import type { HydroApi, HydroFetchResult } from '../../../shared/api/hydro.gen';
import type { BucketAssignment, BuiltFeature, BuildResult, ImportSummary } from './svg-import.service';
import { bufferPolyline } from '../geo/polyline-buffer';
import {
    parseGeojsonDocument,
    bucketByProperty,
    polygonToGeometry,
    type ParsedGeojson,
    type GeojsonBucket,
} from './geojson-parse';

/** Parallel create requests during confirm (matches SvgImportService). */
const CREATE_CONCURRENCY = 6;

/**
 * Durable provenance (T49): map a source feature's properties onto the
 * create API's provenance fields. fetch-osm output carries
 * `source: "osm"` + `osm_type`/`osm_id` (see pipeline/golfpipe/osm.py);
 * OSM data is ODbL, so when the file lacks an explicit `license` property
 * an `osm` source defaults to 'ODbL'. An explicit `source_ref` property
 * (T50: the Lantmäteriet fetch path stamps the OGC feature id) wins over
 * the OSM composite.
 */
export function provenanceFromProperties(
    props: Record<string, unknown>,
): { source?: string; sourceRef?: string; license?: string } {
    const source = typeof props['source'] === 'string' ? (props['source'] as string) : undefined;

    let sourceRef: string | undefined;
    if (typeof props['source_ref'] === 'string') {
        sourceRef = props['source_ref'] as string;
    } else {
        const osmId = props['osm_id'];
        if (typeof osmId === 'string' || typeof osmId === 'number') {
            const osmType = props['osm_type'];
            sourceRef = typeof osmType === 'string' ? `${osmType}/${osmId}` : String(osmId);
        }
    }

    let license = typeof props['license'] === 'string' ? (props['license'] as string) : undefined;
    if (license === undefined && source === 'osm') license = 'ODbL';

    const result: { source?: string; sourceRef?: string; license?: string } = {};
    if (source !== undefined) result.source = source;
    if (sourceRef !== undefined) result.sourceRef = sourceRef;
    if (license !== undefined) result.license = license;
    return result;
}

/** Wizard-facing filename for the one-click Lantmäteriet fetch (T50). */
export const HYDRO_FETCH_FILENAME = 'lantmateriet-hydrografi.geojson';

/**
 * Format a fetch-hydro response as the pipeline-shaped GeoJSON document the
 * wizard already understands (EPSG:3006 crs member, `properties.type` per
 * feature, provenance properties per T49): water polygons pass through,
 * creek centerlines are buffered into `water_creek` ribbons of the
 * suggested width. Pure — exported for tests.
 */
export function hydroToFeatureCollection(result: HydroFetchResult): {
    type: 'FeatureCollection';
    crs: { type: 'name'; properties: { name: string } };
    attribution: string;
    features: unknown[];
} {
    const features: unknown[] = [];
    const properties = (type: string, sourceRef: string | null) => ({
        type,
        source: result.source,
        ...(sourceRef !== null ? { source_ref: sourceRef } : {}),
    });

    for (const water of result.water) {
        features.push({
            type: 'Feature',
            properties: properties('water', water.sourceRef),
            geometry: { type: 'Polygon', coordinates: water.rings },
        });
    }
    for (const creek of result.creeks) {
        const ring = bufferPolyline(creek.points, result.suggestedCreekWidthM);
        if (!ring) continue; // degenerate centerline run — nothing to import
        features.push({
            type: 'Feature',
            properties: properties('water_creek', creek.sourceRef),
            geometry: { type: 'Polygon', coordinates: [ring] },
        });
    }

    return {
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
        attribution: result.attribution,
        features,
    };
}

export class GeojsonImportService {
    /** Wizard visible? (Toggled by the command bar's "Import GeoJSON".) */
    readonly open = new Signal(false);
    readonly fileName = new Signal<string | null>(null);
    readonly parsed = new Signal<ParsedGeojson | null>(null);
    readonly parseError = new Signal<string | null>(null);
    /** Property the features are bucketed by (null = one bucket for all). */
    readonly propertyKey = new Signal<string | null>(null);
    /** bucket key → assignment. Prefilled from suggestions on load. */
    readonly assignments = new Signal<Record<string, BucketAssignment>>({});
    /** Built features awaiting preview/confirm — set by `build()`. */
    readonly built = new Signal<BuildResult | null>(null);
    readonly importing = new Signal(false);
    readonly progress = new Signal<{ done: number; total: number } | null>(null);
    readonly summary = new Signal<ImportSummary | null>(null);
    /** One-click Lantmäteriet fetch (T50) in flight / failed. */
    readonly fetching = new Signal(false);
    readonly fetchError = new Signal<string | null>(null);

    private courseId: string | null = null;

    /** The course the wizard is open for (panel refresh needs it). */
    get targetCourseId(): string | null {
        return this.courseId;
    }

    /** Current mapping rows (re-binned whenever the property changes). */
    readonly buckets = new Computed<GeojsonBucket[]>(() => {
        const parsed = this.parsed.get();
        if (!parsed) return [];
        return bucketByProperty(parsed, this.propertyKey.get());
    });

    /** Number of features `build()` would create with the current mapping. */
    readonly assignedFeatureCount = new Computed(() => {
        const assignments = this.assignments.get();
        let n = 0;
        for (const bucket of this.buckets.get()) {
            const a = assignments[bucket.key];
            if (a && a !== 'skip') n += bucket.polygonCount;
        }
        return n;
    });

    constructor(
        private featuresApi: CourseFeaturesApi = api.courseFeatures,
        private hydroApi: HydroApi = api.hydro,
    ) {}

    /** Open the wizard for a course (coordinates are already EPSG:3006 —
     * no georeference step, unlike the SVG wizard). */
    openFor(courseId: string): void {
        batch(() => {
            this.courseId = courseId;
            this.open.set(true);
            this.fileName.set(null);
            this.parsed.set(null);
            this.parseError.set(null);
            this.propertyKey.set(null);
            this.assignments.set({});
            this.built.set(null);
            this.summary.set(null);
            this.progress.set(null);
            this.fetching.set(false);
            this.fetchError.set(null);
        });
    }

    close(): void {
        batch(() => {
            this.open.set(false);
            this.built.set(null); // kills the preview overlay
        });
    }

    /**
     * One-click Lantmäteriet fetch (T50): call the server's Hydrografi
     * Direkt proxy for this course's map area, buffer the returned creek
     * centerlines into ribbons, and feed the result into the SAME
     * mapping/preview/accept flow a picked file goes through.
     */
    async fetchFromLantmateriet(): Promise<void> {
        const courseId = this.courseId;
        if (!courseId || this.fetching.peek()) return;
        this.fetching.set(true);
        this.fetchError.set(null);
        try {
            const result = await this.hydroApi.fetchHydro({ courseId });
            const collection = hydroToFeatureCollection(result);
            if (collection.features.length === 0) {
                this.fetchError.set('No water or creeks found within the course map area.');
                return;
            }
            this.loadGeojsonText(JSON.stringify(collection), HYDRO_FETCH_FILENAME);
        } catch (e) {
            this.fetchError.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.fetching.set(false);
        }
    }

    /** Parse GeoJSON text into buckets; prefill assignments from suggestions. */
    loadGeojsonText(text: string, fileName: string): void {
        batch(() => {
            this.fileName.set(fileName);
            this.built.set(null);
            this.summary.set(null);
            this.fetchError.set(null);
            try {
                const parsed = parseGeojsonDocument(text);
                // Pipeline convention: `type` (always sorted first when
                // present); otherwise the most common property key.
                const key = parsed.propertyKeys[0] ?? null;
                this.parsed.set(parsed);
                this.propertyKey.set(key);
                this.assignments.set(this.prefill(parsed, key));
                this.parseError.set(null);
            } catch (e) {
                this.parsed.set(null);
                this.propertyKey.set(null);
                this.assignments.set({});
                this.parseError.set(e instanceof Error ? e.message : String(e));
            }
        });
    }

    /** Re-bin by another property; assignments re-prefill from suggestions. */
    setPropertyKey(key: string | null): void {
        const parsed = this.parsed.peek();
        if (!parsed) return;
        batch(() => {
            this.propertyKey.set(key);
            this.assignments.set(this.prefill(parsed, key));
            this.built.set(null); // mapping changed — stale preview
        });
    }

    private prefill(parsed: ParsedGeojson, key: string | null): Record<string, BucketAssignment> {
        const assignments: Record<string, BucketAssignment> = {};
        for (const bucket of bucketByProperty(parsed, key)) {
            assignments[bucket.key] = bucket.suggestedType ?? 'skip';
        }
        return assignments;
    }

    assign(bucketKey: string, assignment: BucketAssignment): void {
        this.assignments.set({ ...this.assignments.peek(), [bucketKey]: assignment });
        this.built.set(null); // mapping changed — stale preview
    }

    /**
     * Build FeatureGeometries from the current mapping. Sets `built` (the
     * panel renders it as the dashed preview overlay) and returns it.
     * Degenerate rings are dropped with warnings; parse-time skips (non-
     * polygon geometries) are carried into the warnings too.
     */
    build(): BuildResult | null {
        const parsed = this.parsed.peek();
        if (!parsed) return null;
        const assignments = this.assignments.peek();
        const features: BuiltFeature[] = [];
        const warnings: string[] = [...parsed.skipped];

        for (const bucket of this.buckets.peek()) {
            const type = assignments[bucket.key];
            if (!type || type === 'skip') continue;
            for (const feature of bucket.features) {
                const provenance = provenanceFromProperties(feature.properties);
                feature.polygons.forEach((rings, polyIdx) => {
                    const label = `${bucket.value} feature ${feature.index + 1}${feature.polygons.length > 1 ? `.${polyIdx + 1}` : ''}`;
                    const { geometry, warnings: ringWarnings } = polygonToGeometry(rings, label);
                    warnings.push(...ringWarnings);
                    if (geometry) features.push({ type, geometry, ...provenance });
                });
            }
        }

        const result: BuildResult = { features, warnings };
        this.built.set(result);
        return result;
    }

    /**
     * Bulk-create the built features (building first if needed). Reports
     * progress; on a failed request the remaining queue is abandoned and
     * `summary.error` is set (already-created features stay). Returns the
     * summary. The CALLER refreshes FeaturesService (`reload()`).
     */
    async confirmImport(): Promise<ImportSummary | null> {
        const courseId = this.courseId;
        const built = this.built.peek() ?? this.build();
        if (!courseId || !built || built.features.length === 0) return null;

        this.importing.set(true);
        this.progress.set({ done: 0, total: built.features.length });
        const created: Record<string, number> = {};
        let done = 0;
        let error: string | null = null;

        const queue = [...built.features];
        const worker = async () => {
            for (;;) {
                const item = queue.shift();
                if (!item || error) return;
                try {
                    await this.featuresApi.create({
                        courseId,
                        type: item.type,
                        geometry: item.geometry,
                        source: item.source,
                        sourceRef: item.sourceRef,
                        license: item.license,
                    });
                    created[item.type] = (created[item.type] ?? 0) + 1;
                    done++;
                    this.progress.set({ done, total: built.features.length });
                } catch (e) {
                    error = e instanceof Error ? e.message : String(e);
                    return;
                }
            }
        };
        await Promise.all(Array.from({ length: CREATE_CONCURRENCY }, worker));

        const summary: ImportSummary = { created, warnings: built.warnings, error };
        batch(() => {
            this.summary.set(summary);
            this.importing.set(false);
            this.built.set(null); // imported — preview off, real features take over
        });
        return summary;
    }
}
