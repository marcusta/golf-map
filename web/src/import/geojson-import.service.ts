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
import type { CourseFeaturesApi, ImportedFeatureCount } from '../../../shared/api/course-features.gen';
import { PATH_SURFACE_ATTRIBUTE, isPathSurface } from '../../../shared/features/path-surface';
import type { HydroApi, HydroFetchResult } from '../../../shared/api/hydro.gen';
import type { OsmApi, OsmFetchResult } from '../../../shared/api/osm.gen';
import type { RoadsFetchJob, TerrainGeneratorsApi } from '../../../shared/api/terrain-generators.gen';
import type { BucketAssignment, BuiltFeature, BuildResult, ImportSummary } from './svg-import.service';
import { bufferPolyline } from '../geo/polyline-buffer';
import {
    IMPORTED_CORNER_TURN_DEG,
    autoCorners,
    centerlineGeometry,
    type FeatureCenterline,
} from '../../../shared/features/centerline';
import {
    parseGeojsonDocument,
    bucketByProperty,
    polygonToGeometry,
    type ParsedGeojson,
    type GeojsonBucket,
} from './geojson-parse';

/**
 * One clearable group of a course's imported features, as the wizard lists
 * them: what to call it, how many there are, and the `sources` (+ `types`)
 * that remove exactly those.
 */
export interface ImportGroup {
    key: string;
    label: string;
    count: number;
    /** Per type, e.g. `path 57`; the panel labels the types. */
    types: Array<{ type: string; count: number }>;
    sources: string[];
    /** Only these types of `sources` — unset means everything they imported. */
    onlyTypes?: string[];
}

/** Import sources the fetches stamp, by how the wizard names them. */
const SOURCE_LABELS: Record<string, string> = {
    'osm': 'OpenStreetMap features',
    'nvdb': 'NVDB roads',
    'lantmateriet-hydrografi': 'Lantmäteriet water',
};
/** fetch-roads output: `path` features from OSM, and from NVDB where OSM lacks the road. */
const ROAD_SOURCES = ['osm', 'nvdb'];

/**
 * A course's imported (source, type) counts → the wizard's clearable groups.
 * The roads fetch gets its own group (`path` from osm + nvdb, parking lots
 * included) so re-fetching roads never takes the OSM fairways with it; every
 * other source is one group of whatever it imported. Pure — exported for tests.
 */
export function importGroups(counts: ImportedFeatureCount[]): ImportGroup[] {
    const groups: ImportGroup[] = [];
    const roads = counts.filter(c => ROAD_SOURCES.includes(c.source) && c.type === 'path');
    if (roads.length > 0) {
        groups.push({
            key: 'roads',
            label: 'Roads & parking (OSM + NVDB)',
            count: roads.reduce((n, c) => n + c.count, 0),
            types: [{ type: 'path', count: roads.reduce((n, c) => n + c.count, 0) }],
            sources: [...new Set(roads.map(c => c.source))],
            onlyTypes: ['path'],
        });
    }
    const rest = counts.filter(c => !roads.includes(c));
    for (const source of [...new Set(rest.map(c => c.source))]) {
        const mine = rest.filter(c => c.source === source);
        const nonRoad = ROAD_SOURCES.includes(source);
        groups.push({
            key: `source:${source}`,
            label: SOURCE_LABELS[source] ?? source,
            count: mine.reduce((n, c) => n + c.count, 0),
            types: mine.map(c => ({ type: c.type, count: c.count })),
            sources: [source],
            // An OSM/NVDB group without the roads must not delete the roads.
            ...(nonRoad ? { onlyTypes: mine.map(c => c.type) } : {}),
        });
    }
    return groups;
}

/** How often a running road fetch job is polled (ms); tests pass something tiny. */
export const ROADS_POLL_MS = 1500;

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

/**
 * The attributes a source feature brings along for the type it is imported
 * as: a `path` keeps a valid `surface` property (fetch-roads writes one from
 * NVDB / the OSM surface tag). Everything else stays a source property only.
 * Null when there is nothing to carry. Pure — exported for tests.
 */
export function attributesFromProperties(type: string, props: Record<string, unknown>): Record<string, string> | null {
    if (type === 'path' && isPathSurface(props[PATH_SURFACE_ATTRIBUTE])) {
        return { [PATH_SURFACE_ATTRIBUTE]: props[PATH_SURFACE_ATTRIBUTE] as string };
    }
    return null;
}

/**
 * A fetch-roads corridor that is ONE way's carries that way's clipped
 * `centerline` ([[x, y], …], EPSG:3006) and `widthM`; such a road is
 * imported as a centerline feature — the line is the shape, the corridor is
 * derived — so moving it later is moving one line. Bends of
 * IMPORTED_CORNER_TURN_DEG or more are corners (the pipeline's own rule).
 * Null when the properties carry no usable line (the polygon is imported
 * instead). Pure — exported for tests.
 */
export function centerlineFromProperties(props: Record<string, unknown>): FeatureCenterline | null {
    const line = props['centerline'];
    const widthM = props['widthM'];
    if (!Array.isArray(line) || typeof widthM !== 'number') return null;
    const points: Array<{ x: number; y: number }> = [];
    for (const c of line) {
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
        points.push({ x: c[0] as number, y: c[1] as number });
    }
    const centerline = { points: autoCorners(points, IMPORTED_CORNER_TURN_DEG), widthM };
    return centerlineGeometry('EPSG:3006', centerline) ? centerline : null;
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
            // The line rides along as `centerline` + `widthM`, so the wizard
            // imports the creek as a centerline feature (like a fetched road):
            // the creek digs and the R.A.M. export follow its line, and it
            // edits as one line with a width. The ribbon is the preview shape.
            properties: { ...properties('water_creek', creek.sourceRef), centerline: creek.points, widthM: result.suggestedCreekWidthM },
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

/** Wizard-facing filename for the one-click OSM fetch (T53). */
export const OSM_FETCH_FILENAME = 'openstreetmap.geojson';
/** The wizard's file name for a road fetch (T-roads) — ODbL like the OSM fetch. */
export const ROADS_FETCH_FILENAME = 'osm-roads.geojson';

/**
 * Format a fetch-osm response as the pipeline-shaped GeoJSON document the
 * wizard already understands (EPSG:3006 crs member, `properties.type` per
 * feature, provenance properties per T49). The server returns typed,
 * clipped EPSG:3006 polygons with composite sourceRefs (`way/<id>` /
 * `relation/<id>` — the same value provenanceFromProperties composes from
 * a fetch-osm FILE's `osm_type`+`osm_id`), so `source_ref` carries them
 * verbatim; `license: 'ODbL'` is explicit. Pure — exported for tests.
 */
export function osmToFeatureCollection(result: OsmFetchResult): {
    type: 'FeatureCollection';
    crs: { type: 'name'; properties: { name: string } };
    attribution: string;
    features: unknown[];
} {
    return {
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
        attribution: result.attribution,
        features: result.features.map(feature => ({
            type: 'Feature',
            properties: {
                type: feature.type,
                source: result.source,
                source_ref: feature.sourceRef,
                license: result.license,
                fetched: result.fetched,
            },
            geometry: { type: 'Polygon', coordinates: feature.rings },
        })),
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
    /** One-click fetch (T50 Lantmäteriet / T53 OSM) in flight / failed. */
    readonly fetching = new Signal(false);
    /** Which fetch variant is in flight (labels the right button). */
    readonly fetchSource = new Signal<'lantmateriet' | 'osm' | 'roads' | null>(null);
    readonly fetchError = new Signal<string | null>(null);
    /** The course's imported features, grouped for clearing (loaded on open and after imports). */
    readonly imported = new Signal<ImportGroup[]>([]);
    /** Key of the group being removed, while it is. */
    readonly clearing = new Signal<string | null>(null);
    readonly clearError = new Signal<string | null>(null);

    private courseId: string | null = null;

    /** The course the wizard is open for (panel refresh needs it). */
    get targetCourseId(): string | null {
        return this.courseId;
    }

    /**
     * Pipeline-generated tree polygons (`source: 'lidar-canopy'`) are bulk-
     * replaced through `PUT /features/generated`, not created one by one
     * here (server/AGENTS.md "Generated features"). When a picked file
     * carries them, say so — the wizard still imports, as hand-drawn rows.
     */
    readonly generatedSourceNote = new Computed<string | null>(() => {
        const parsed = this.parsed.get();
        if (!parsed) return null;
        const n = parsed.features.filter(f => f.properties['source'] === 'lidar-canopy').length;
        if (n === 0) return null;
        return `${n} feature${n === 1 ? '' : 's'} carry source "lidar-canopy". Lidar tree polygons are imported by the pipeline `
            + `(golfpipe detect-trees → PUT /api/courses/:id/features/generated), which replaces the whole set and keeps them read-only; `
            + `importing them here creates ordinary hand-drawn copies.`;
    });

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
        private osmApi: OsmApi = api.osm,
        private generatorsApi: TerrainGeneratorsApi = api.terrainGenerators,
        private readonly pollMs = ROADS_POLL_MS,
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
            this.fetchSource.set(null);
            this.fetchError.set(null);
            this.imported.set([]);
            this.clearing.set(null);
            this.clearError.set(null);
        });
        void this.loadImported();
    }

    /** Refresh `imported` for the open course (a failure just leaves the list empty). */
    async loadImported(): Promise<void> {
        const courseId = this.courseId;
        if (!courseId) return;
        try {
            const counts = await this.featuresApi.imported({ courseId });
            if (this.courseId === courseId) this.imported.set(importGroups(counts));
        } catch {
            if (this.courseId === courseId) this.imported.set([]);
        }
    }

    /**
     * Delete one group of imported features (the caller confirms first and
     * reloads the map's features after). Returns how many were removed, or
     * null when it failed (`clearError` says why).
     */
    async clearImported(group: ImportGroup): Promise<number | null> {
        const courseId = this.courseId;
        if (!courseId || this.clearing.peek()) return null;
        this.clearing.set(group.key);
        this.clearError.set(null);
        try {
            const { removed } = await this.featuresApi.removeImported({
                courseId, sources: group.sources, ...(group.onlyTypes ? { types: group.onlyTypes } : {}),
            });
            await this.loadImported();
            return removed;
        } catch (e) {
            this.clearError.set(e instanceof Error ? e.message : String(e));
            return null;
        } finally {
            this.clearing.set(null);
        }
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
        await this.runFetch('lantmateriet', async courseId => {
            const result = await this.hydroApi.fetchHydro({ courseId });
            const collection = hydroToFeatureCollection(result);
            if (collection.features.length === 0) {
                this.fetchError.set('No water or creeks found within the course map area.');
                return;
            }
            this.loadGeojsonText(JSON.stringify(collection), HYDRO_FETCH_FILENAME);
        });
    }

    /**
     * One-click OSM fetch (T53): call the server's Overpass proxy for this
     * course's map area and feed the typed, ODbL-tagged result into the
     * SAME mapping/preview/accept flow a picked file goes through.
     */
    async fetchFromOsm(): Promise<void> {
        await this.runFetch('osm', async courseId => {
            const result = await this.osmApi.fetchOsm({ courseId });
            const collection = osmToFeatureCollection(result);
            if (collection.features.length === 0) {
                this.fetchError.set('No OSM golf or terrain features found within the course map area.');
                return;
            }
            this.loadGeojsonText(JSON.stringify(collection), OSM_FETCH_FILENAME);
        });
    }

    /**
     * One-click roads (T-roads): the server runs the pipeline's `fetch-roads`
     * over the course's area as a job — Overpass is retried while busy, so it
     * can take a minute — and the finished job hands back the corridor
     * polygons as the typed EPSG:3006 collection the wizard already reads
     * (`path` features; bucket on `road_class` to keep roads and drop
     * footpaths). The centerlines stay on the server for the terrain tool's
     * road grading. A start refused because a fetch already runs for the
     * course follows that one instead.
     */
    async fetchFromRoads(): Promise<void> {
        await this.runFetch('roads', async courseId => {
            let job: RoadsFetchJob;
            try {
                job = await this.generatorsApi.startRoadsFetch({ courseId });
            } catch (e) {
                const running = e instanceof Error && /already running/i.test(e.message)
                    ? await this.generatorsApi.currentRoadsFetch({ courseId }).catch(() => null)
                    : null;
                if (running?.status !== 'running') throw e;
                job = running;
            }
            while (job.status === 'running') {
                await new Promise(r => setTimeout(r, this.pollMs));
                if (this.courseId !== courseId) return;  // the wizard moved on
                job = await this.generatorsApi.roadsFetchJob({ jobId: job.id });
            }
            if (job.status === 'failed' || !job.result) throw new Error(job.error ?? 'Road fetch failed');
            const collection = job.result.geojson as { features?: unknown[] };
            if (!collection.features || collection.features.length === 0) {
                this.fetchError.set('No roads found near the course.');
                return;
            }
            this.loadGeojsonText(JSON.stringify(job.result.geojson), ROADS_FETCH_FILENAME);
        });
    }

    /** Shared fetch-variant plumbing: single-flight, error capture. */
    private async runFetch(
        source: 'lantmateriet' | 'osm' | 'roads',
        action: (courseId: string) => Promise<void>,
    ): Promise<void> {
        const courseId = this.courseId;
        if (!courseId || this.fetching.peek()) return;
        this.fetching.set(true);
        this.fetchSource.set(source);
        this.fetchError.set(null);
        try {
            await action(courseId);
        } catch (e) {
            this.fetchError.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.fetching.set(false);
            this.fetchSource.set(null);
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
                const attributes = attributesFromProperties(type, feature.properties);
                const centerline = centerlineFromProperties(feature.properties);
                const lineGeometry = centerline ? centerlineGeometry('EPSG:3006', centerline) : null;
                if (lineGeometry) {
                    features.push({ type, geometry: lineGeometry, ...provenance, ...(attributes ? { attributes } : {}) });
                    continue;
                }
                feature.polygons.forEach((rings, polyIdx) => {
                    const label = `${bucket.value} feature ${feature.index + 1}${feature.polygons.length > 1 ? `.${polyIdx + 1}` : ''}`;
                    const { geometry, warnings: ringWarnings } = polygonToGeometry(rings, label, {
                        exact: feature.properties['exact'] === true,
                    });
                    warnings.push(...ringWarnings);
                    if (geometry) features.push({ type, geometry, ...provenance, ...(attributes ? { attributes } : {}) });
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
                        ...(item.attributes ? { attributes: item.attributes } : {}),
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
        await this.loadImported();
        return summary;
    }
}
