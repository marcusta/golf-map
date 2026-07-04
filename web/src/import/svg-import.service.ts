// SVG course-feature import wizard state (Phase 3 / roadmap 2.4).
//
// Owns the import flow for one course at a time: load SVG text → parse into
// mapping buckets (svg-parse.ts) → user assigns each bucket a feature type
// (or skip) and confirms/adjusts the EPSG:3006 georeference bounds → build
// FeatureGeometries (preview overlay is rendered by SvgImportPanelComponent
// from `built`) → bulk-create through the course-features API.
//
// DI singleton; the panel component (svg-import-panel.component.ts) is the
// only UI. Testable headlessly: constructor takes the features API client.

import { Signal, Computed, batch } from '@basics/core/client/core';
import { api } from '../api';
import type { CourseFeaturesApi } from '../../../shared/api/course-features.gen';
import type { FeatureGeometry } from '../geo/bezier';
import type { FeatureType } from '../draw/feature-palette';
import {
    parseSvgDocument,
    parsePathToSubpaths,
    makeGeoreference,
    mapSubpath,
    subpathsToGeometries,
    applyAffine,
    type ParsedSvg,
    type GeoBounds,
} from './svg-parse';

/** A bucket's mapping choice: a feature type, or skip its paths entirely. */
export type BucketAssignment = FeatureType | 'skip';

/** One buildable feature (pre-create). */
export interface BuiltFeature {
    type: FeatureType;
    geometry: FeatureGeometry;
}

export interface BuildResult {
    features: BuiltFeature[];
    /** Degenerate rings (< 3 anchors) that were dropped, human-readable. */
    warnings: string[];
}

export interface ImportSummary {
    /** Created feature counts per type. */
    created: Record<string, number>;
    warnings: string[];
    /** Set when the bulk create aborted midway. */
    error: string | null;
}

/** Parallel create requests during confirm. */
const CREATE_CONCURRENCY = 6;

/**
 * Default georeference bounds from a course's georeference_json (the tile
 * pipeline writes `{ bbox: [minX, minY, maxX, maxY] }` in EPSG:3006).
 * Null when absent/malformed — the user then types bounds manually.
 */
export function boundsFromGeoreference(georeferenceJson: string | null): GeoBounds | null {
    if (!georeferenceJson) return null;
    try {
        const parsed = JSON.parse(georeferenceJson) as { bbox?: unknown };
        const bbox = parsed.bbox;
        if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(n => typeof n === 'number')) {
            return { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };
        }
    } catch {
        // fall through
    }
    return null;
}

export class SvgImportService {
    /** Wizard visible? (Toggled by the course-detail "Import SVG" button.) */
    readonly open = new Signal(false);
    readonly fileName = new Signal<string | null>(null);
    readonly parsed = new Signal<ParsedSvg | null>(null);
    readonly parseError = new Signal<string | null>(null);
    /** bucket key → assignment. Prefilled from suggestions on load. */
    readonly assignments = new Signal<Record<string, BucketAssignment>>({});
    /** Georeference bounds (EPSG:3006 meters) the viewBox maps onto. */
    readonly bounds = new Signal<GeoBounds>({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    /** Built features awaiting preview/confirm — set by `build()`. */
    readonly built = new Signal<BuildResult | null>(null);
    readonly importing = new Signal(false);
    readonly progress = new Signal<{ done: number; total: number } | null>(null);
    readonly summary = new Signal<ImportSummary | null>(null);

    private courseId: string | null = null;

    /** Number of features that `build()` would create with current mapping. */
    readonly assignedPathCount = new Computed(() => {
        const parsed = this.parsed.get();
        if (!parsed) return 0;
        const assignments = this.assignments.get();
        let n = 0;
        for (const bucket of parsed.buckets) {
            const a = assignments[bucket.key];
            if (a && a !== 'skip') n += bucket.paths.length;
        }
        return n;
    });

    constructor(private featuresApi: CourseFeaturesApi = api.courseFeatures) {}

    /**
     * Open the wizard for a course. `defaultBounds` prefills the
     * georeference (course georeference_json bbox when present).
     */
    openFor(courseId: string, defaultBounds: GeoBounds | null): void {
        batch(() => {
            this.courseId = courseId;
            this.open.set(true);
            this.fileName.set(null);
            this.parsed.set(null);
            this.parseError.set(null);
            this.assignments.set({});
            this.built.set(null);
            this.summary.set(null);
            this.progress.set(null);
            if (defaultBounds) this.bounds.set(defaultBounds);
        });
    }

    close(): void {
        batch(() => {
            this.open.set(false);
            this.built.set(null); // kills the preview overlay
        });
    }

    /** Parse SVG text into buckets; prefill assignments from suggestions. */
    loadSvgText(text: string, fileName: string): void {
        batch(() => {
            this.fileName.set(fileName);
            this.built.set(null);
            this.summary.set(null);
            try {
                const parsed = parseSvgDocument(text);
                if (parsed.totalPaths === 0) throw new Error('No <path> elements found');
                const assignments: Record<string, BucketAssignment> = {};
                for (const bucket of parsed.buckets) {
                    assignments[bucket.key] = bucket.suggestedType ?? 'skip';
                }
                this.parsed.set(parsed);
                this.assignments.set(assignments);
                this.parseError.set(null);
            } catch (e) {
                this.parsed.set(null);
                this.assignments.set({});
                this.parseError.set(e instanceof Error ? e.message : String(e));
            }
        });
    }

    assign(bucketKey: string, assignment: BucketAssignment): void {
        this.assignments.set({ ...this.assignments.peek(), [bucketKey]: assignment });
        this.built.set(null); // mapping changed — stale preview
    }

    /** Assign/skip every bucket of a layer at once. */
    assignLayer(layer: string, assignment: 'skip' | 'suggested'): void {
        const parsed = this.parsed.peek();
        if (!parsed) return;
        const next = { ...this.assignments.peek() };
        for (const bucket of parsed.buckets) {
            if (bucket.layer !== layer) continue;
            next[bucket.key] = assignment === 'skip' ? 'skip' : bucket.suggestedType ?? 'skip';
        }
        this.assignments.set(next);
        this.built.set(null);
    }

    setBounds(bounds: GeoBounds): void {
        this.bounds.set(bounds);
        this.built.set(null); // georeference changed — stale preview
    }

    /**
     * Build FeatureGeometries from the current mapping + bounds. Sets
     * `built` (the panel renders it as the dashed preview overlay) and
     * returns it. Degenerate rings (< 3 anchors) are dropped with warnings.
     */
    build(): BuildResult | null {
        const parsed = this.parsed.peek();
        if (!parsed) return null;
        const georef = makeGeoreference(parsed.viewBox, this.bounds.peek());
        const assignments = this.assignments.peek();
        const features: BuiltFeature[] = [];
        const warnings: string[] = [];

        for (const bucket of parsed.buckets) {
            const type = assignments[bucket.key];
            if (!type || type === 'skip') continue;
            const label = `${bucket.layer || 'root'} / ${bucket.fill ?? bucket.className ?? 'none'}`;
            bucket.paths.forEach((path, pathIdx) => {
                const rings = parsePathToSubpaths(path.d)
                    .map(sub => mapSubpath(sub, p => georef(applyAffine(path.transform, p))))
                    .filter(ring => {
                        if (ring.points.length >= 3) return true;
                        warnings.push(`${label} path ${pathIdx + 1}: dropped ring with ${ring.points.length} point(s)`);
                        return false;
                    });
                for (const geometry of subpathsToGeometries(rings)) {
                    features.push({ type, geometry });
                }
            });
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
                    await this.featuresApi.create({ courseId, type: item.type, geometry: item.geometry });
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
            this.built.set(null); // imported — preview overlay off, real features take over
        });
        return summary;
    }
}
