// GeoJSON draft-import wizard state (T43). Mirrors SvgImportService — the
// import flow for one course at a time: load .geojson text → parse +
// CRS-validate (geojson-parse.ts) → bucket features by a chosen property →
// user assigns each bucket a feature type (or skip) → the features are built
// at once (geojson-build.ts) and shown on the map (GeojsonImportPanelComponent
// renders `built`), where a click picks or drops one → the picked ones are
// bulk-created through the course-features API. Shapes the course already
// has (same source + sourceRef) start dropped and cannot be picked, so a
// fetch can be imported a few shapes at a time.
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
import type { HydroApi } from '../../../shared/api/hydro.gen';
import type { OsmApi, OsmFetchResult } from '../../../shared/api/osm.gen';
import type { RoadsFetchJob, TerrainGeneratorsApi } from '../../../shared/api/terrain-generators.gen';
import type { BucketAssignment, BuiltFeature, BuildResult, ImportSummary } from './svg-import.service';
import { parseGeojsonDocument, bucketByProperty, type ParsedGeojson, type GeojsonBucket } from './geojson-parse';
import { HYDRO_FETCH_FILENAME, alreadyImported, buildFeatures, hydroToFeatureCollection, importedRefs } from './geojson-build';

export {
    provenanceFromProperties,
    attributesFromProperties,
    centerlineFromProperties,
    hydroToFeatureCollection,
    HYDRO_FETCH_FILENAME,
} from './geojson-build';

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
    /** Built features on the map, to pick from — rebuilt whenever the mapping changes. */
    readonly built = new Signal<BuildResult | null>(null);
    /** Pick key → picked (true) or dropped (false) on the map; unset is picked. Kept while the mapping changes. */
    readonly picks = new Signal<Record<string, boolean>>({});
    /** The course's (source, sourceRef) keys (geojson-build `importedRefs`), loaded with `imported`. */
    readonly existingRefs = new Signal<ReadonlySet<string>>(new Set());
    /** Pick keys created from the loaded file in this wizard — on the course even without a sourceRef. */
    readonly importedKeys = new Signal<ReadonlySet<string>>(new Set());
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

    /** The built features `confirmImport` creates: picked, and not on the course yet. */
    readonly pickedFeatures = new Computed<BuiltFeature[]>(() =>
        (this.built.get()?.features ?? []).filter(f => this.isPicked(f)));

    /** How many built features the course already has. */
    readonly onCourseCount = new Computed(() =>
        (this.built.get()?.features ?? []).filter(f => this.isOnCourse(f)).length);

    /** The course already has this shape (same source + sourceRef, or imported from this file). */
    isOnCourse(f: BuiltFeature): boolean {
        return (f.key !== undefined && this.importedKeys.get().has(f.key)) || alreadyImported(f, this.existingRefs.get());
    }

    /** Picked on the map (the default) and not on the course. */
    isPicked(f: BuiltFeature): boolean {
        if (this.isOnCourse(f)) return false;
        return f.key === undefined || (this.picks.get()[f.key] ?? true);
    }

    /** Pick a dropped shape or drop a picked one. A shape already on the course stays dropped. */
    togglePick(key: string): void {
        const f = this.built.peek()?.features.find(x => x.key === key);
        if (!f || this.isOnCourse(f)) return;
        this.picks.set({ ...this.picks.peek(), [key]: !this.isPicked(f) });
    }

    /** Pick every shape not on the course (true), or drop them all (false). */
    pickAll(on: boolean): void {
        const picks: Record<string, boolean> = {};
        for (const f of this.built.peek()?.features ?? []) if (f.key !== undefined) picks[f.key] = on;
        this.picks.set(picks);
    }

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
            this.picks.set({});
            this.importedKeys.set(new Set());
            this.existingRefs.set(new Set());
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

    /**
     * Refresh `imported` and `existingRefs` for the open course (a failure
     * just leaves the list, or the refs, empty).
     */
    async loadImported(): Promise<void> {
        const courseId = this.courseId;
        if (!courseId) return;
        await Promise.all([
            this.featuresApi.imported({ courseId })
                .then(counts => { if (this.courseId === courseId) this.imported.set(importGroups(counts)); })
                .catch(() => { if (this.courseId === courseId) this.imported.set([]); }),
            this.featuresApi.listByCourse({ courseId })
                .then(features => { if (this.courseId === courseId) this.existingRefs.set(importedRefs(features)); })
                .catch(() => { if (this.courseId === courseId) this.existingRefs.set(new Set()); }),
        ]);
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
            this.importedKeys.set(new Set()); // what is still on the course comes back with the refs
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
                this.picks.set({});
                this.importedKeys.set(new Set());
                this.build();
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
            this.build();
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
        this.build();
    }

    /**
     * Build the features of the current mapping (geojson-build
     * `buildFeatures`) and put them on the map. Called whenever the file or
     * the mapping changes; picks carry over by key.
     */
    build(): BuildResult | null {
        const parsed = this.parsed.peek();
        if (!parsed) return null;
        const result = buildFeatures(parsed, bucketByProperty(parsed, this.propertyKey.peek()), this.assignments.peek());
        this.built.set(result);
        return result;
    }

    /**
     * Create the picked features (`pickedFeatures`, building first if
     * needed). Reports progress; on a failed request the remaining queue is
     * abandoned and `summary.error` is set (already-created features stay).
     * The preview stays: what was created now counts as on the course, so
     * the next shapes can be picked from the same fetch. Returns the
     * summary. The CALLER refreshes FeaturesService (`reload()`).
     */
    async confirmImport(): Promise<ImportSummary | null> {
        const courseId = this.courseId;
        const built = this.built.peek() ?? this.build();
        if (!courseId || !built) return null;
        const picked = this.pickedFeatures.peek();
        if (picked.length === 0) return null;

        this.importing.set(true);
        this.progress.set({ done: 0, total: picked.length });
        const created: Record<string, number> = {};
        const createdKeys = new Set(this.importedKeys.peek());
        let done = 0;
        let error: string | null = null;

        const queue = [...picked];
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
                    if (item.key !== undefined) createdKeys.add(item.key);
                    done++;
                    this.progress.set({ done, total: picked.length });
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
            this.importedKeys.set(createdKeys);
        });
        await this.loadImported();
        return summary;
    }
}
