import { Signal, Computed, effect, di, batch } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { CourseFeature, CourseFeaturesApi } from '../../../shared/api/course-features.gen';
import type { FeatureCollection, Feature, Polygon } from 'geojson';
import type { FilterSpecification, GeoJSONSourceDiff, GeoJSONFeatureDiff } from 'maplibre-gl';
import { flattenRing, type FeatureGeometry } from '../geo/bezier';
import { ringWgs84 } from '../geo/wgs84-cache';
import type { MapService } from '../map/map.service';
import { DRAW_FILL_OPACITY, NICE_FILL_OPACITY, typeColorExpression, SELECTION_COLOR } from './feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { resolveSurfaceStack } from '../../../shared/render/resolved-surface-stack';
import { isGeneratedFeature } from './generated-features';

/**
 * D24 global composition key: `groupRank * 4096 + sortOrder`, groupRank 0 =
 * course-level, else the hole's number. Matches the server's
 * `geojsonByCourse` formula exactly (course-features.service.ts) so live-edit
 * GeoJSON and server-materialized GeoJSON agree.
 */
const GROUP_RANK_SPAN = 4096;

/** Flattening tolerance in meters — matches the server's GeoJSON derivation. */
export const FLATTEN_TOLERANCE_M = 0.25;

/** Overlay/source id for the persistent course-features rendering (hand-drawn). */
export const FEATURES_OVERLAY_ID = 'features';
/**
 * Overlay/source id for GENERATED features (non-null `source`, e.g. the
 * lidar canopy trees — ~2200 polygons / ~60k vertices on Landeryd). Kept in
 * its own source so hand-drawn edits never re-send it to the worker; it
 * only rebuilds when the generated set itself changes (load, delete).
 */
export const GENERATED_OVERLAY_ID = 'features-generated';

/**
 * Largest per-feature change set `attachOverlay` sends as a
 * GeoJSONSource.updateData diff. Bigger changes (load, bulk import, hole
 * renumber) go as one setData: the worker re-tiles everything either way.
 */
export const OVERLAY_DIFF_MAX_FEATURES = 50;

// Flattened + reprojected rings are cached per geometry OBJECT. Geometry
// is replaced wholesale on every edit, so identity keying is exact and the
// WeakMap lets dropped geometries collect. Below that, ringWgs84 caches each
// reprojected point on its flattened tuple, so an edited geometry reprojects
// only the points of the segments that changed.
const wgs84RingsCache = new WeakMap<object, number[][][]>();

/** Geometry (EPSG:3006 bezier rings) -> closed WGS84 GeoJSON rings. */
export function geometryToWgs84Rings(geometry: FeatureGeometry): number[][][] {
    const cached = wgs84RingsCache.get(geometry);
    if (cached) return cached;
    const rings = geometry.rings.map(ring => {
        // GeoJSON positions are mutable by type; these tuples are shared
        // with the point cache and nothing downstream writes to them.
        const coords = ringWgs84(flattenRing(ring, FLATTEN_TOLERANCE_M, geometry.curveType)) as unknown as number[][];
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
    /**
     * Selected feature ids (draw tool selection). Multi-select is a set;
     * the single-select common case is a one-element set (see `selected`).
     */
    readonly selectedIds = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Feature TYPES hidden from the overlay + hit tests (panel eye
     * toggles). Purely client-side view state — never persisted.
     */
    readonly hiddenTypes = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Individual feature IDS hidden from the overlay + hit tests (stack
     * panel eye toggles, Inkscape/Photoshop-style). Same lifecycle rules
     * as `hiddenTypes`: client-side view state, never persisted.
     */
    readonly hiddenIds = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Generated-feature SOURCES hidden from the overlay + hit tests (stack
     * panel group-row eye, e.g. 'lidar-canopy'). Client-side view state.
     */
    readonly hiddenSources = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Nice mode is a photo-blended, stroke-free vector tint. Draw mode uses
     * a high-contrast palette with visible feature boundaries.
     */
    readonly niceRendering = new Signal(true);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove is in flight (autosave indicator). */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    /** Hole numbers for the D24 `stackKey` groupRank — set before `geojson`/`stackTopDown` (both Computed eagerly on construction). */
    private courseDetail = di.get(CourseDetailService);

    private loadedCourseId: string | null = null;

    /**
     * The selected feature when EXACTLY ONE is selected, else null.
     * Single-feature affordances (vertex editing, panel detail) key off
     * this; multi-select consumers use `selectedFeatures`.
     */
    readonly selected = new Computed<CourseFeature | null>(() => {
        const ids = this.selectedIds.get();
        if (ids.size !== 1) return null;
        const [id] = ids;
        return this.store.items.get().find(f => f.id === id) ?? null;
    });

    /**
     * T49 course-level ODbL posture, derived live from the loaded features:
     * a course containing ANY ODbL-licensed feature (OSM-derived imports)
     * is ODbL for its map data. Drives the command-bar pill, the publish
     * confirm note, and the map status-bar attribution. Cheap (one scan per
     * store change) and always current while editing — no server flag.
     */
    readonly hasOdblFeatures = new Computed<boolean>(() =>
        this.store.items.get().some(f => f.license === 'ODbL'));

    /** All currently selected features (store order). */
    readonly selectedFeatures = new Computed<CourseFeature[]>(() => {
        const ids = this.selectedIds.get();
        if (ids.size === 0) return [];
        return this.store.items.get().filter(f => ids.has(f.id));
    });

    /**
     * `selected` when it is hand-drawn, null when it is generated (read-only):
     * every geometry-editing affordance (vertex handles, edge insertion,
     * offset/simplify previews, context-menu vertex delete) keys off THIS.
     */
    readonly editableSelected = new Computed<CourseFeature | null>(() => {
        const f = this.selected.get();
        return f && !isGeneratedFeature(f) ? f : null;
    });

    /** `selectedFeatures` minus generated (read-only) rows — move/duplicate/retype/rehole targets. */
    readonly editableSelectedFeatures = new Computed<CourseFeature[]>(() =>
        this.selectedFeatures.get().filter(f => !isGeneratedFeature(f)));

    /**
     * Generated (non-null `source`) features, identity-stable: the same array
     * instance comes back while the generated set is unchanged (same rows in
     * the same order), even though every store edit re-runs this. That
     * stability is what keeps `generatedGeojson` from rebuilding ~60k
     * vertices on each hand-drawn vertex drag.
     */
    readonly generatedFeatures = new Computed<CourseFeature[]>(() => {
        const next = this.store.items.get().filter(isGeneratedFeature);
        const prev = this.lastGenerated;
        if (prev && prev.length === next.length && prev.every((f, i) => f === next[i])) return prev;
        this.lastGenerated = next;
        return next;
    });
    private lastGenerated: CourseFeature[] | null = null;

    /**
     * All VISIBLE features as a WGS84 FeatureCollection with rendering
     * properties (`type`, `holeId`). Recomputes on store and visibility
     * changes; unchanged geometries hit the flatten cache. Hidden types
     * are filtered HERE (rather than via per-layer filters) so one
     * computed drives fill, outline and selection layers consistently.
     *
     * Deliberately NOT selection-dependent: this collection is ~20 MB of
     * flattened rings for a full course, and a full send costs the MapLibre
     * worker a full re-tile (~250 ms). Selection highlighting is
     * feature-state (see attachOverlay) and per-frame drag feedback is a
     * ghost overlay (see DrawToolService), so neither touches this
     * collection.
     *
     * Each rebuild also records how it differs from the collection it
     * replaces (`geojsonDiffs`), so attachOverlay can send a small edit as
     * a per-feature updateData diff. Rows whose render signature did not
     * change keep their Feature object from the previous build.
     *
     * Identity-stable: when the visible rows render identically to the last
     * build (same ids, geometry objects, type, holeId, sortOrder, stackKey,
     * source), the PREVIOUS collection object comes back. A row change that
     * does not affect rendering (e.g. a save reply bumping `version`)
     * therefore never re-sends the source — `attachOverlay` keys on identity.
     */
    readonly geojson = new Computed<FeatureCollection>(() => {
        const hidden = this.hiddenTypes.get();
        const hiddenIds = this.hiddenIds.get();
        const visible = this.store.items.get()
            .filter(f => !isGeneratedFeature(f) && !hidden.has(f.type) && !hiddenIds.has(f.id));
        const signature = visible.map(f => this.renderSignature(f));
        const memo = this.geojsonMemo;
        if (memo && sameSignatures(memo.signature, signature)) return memo.data;
        const comparable = !!memo && memo.hidden === hidden && memo.hiddenIds === hiddenIds
            && memo.loadGeneration === this.loadGeneration;
        // Previous Feature per id while its render signature is unchanged.
        const reuse = comparable ? memo.featureById : null;
        const featureById = new Map<string, { sig: RenderSignature; feature: Feature }>();
        const features = visible.map((f, i) => {
            const sig = signature[i]!;
            const prev = reuse?.get(f.id);
            const feature = prev && sameSignature(prev.sig, sig) ? prev.feature : this.toGeojsonFeature(f);
            featureById.set(f.id, { sig, feature });
            return feature;
        });
        const data: FeatureCollection = { type: 'FeatureCollection', features };
        if (comparable) {
            const diff = overlayDiff(memo.featureById, featureById, signature);
            if (diff) this.geojsonDiffs.set(data, { from: memo.data, diff });
        }
        this.geojsonMemo = { signature, data, featureById, hidden, hiddenIds, loadGeneration: this.loadGeneration };
        return data;
    });
    private geojsonMemo: {
        signature: RenderSignature[];
        data: FeatureCollection;
        featureById: Map<string, { sig: RenderSignature; feature: Feature }>;
        hidden: ReadonlySet<string>;
        hiddenIds: ReadonlySet<string>;
        loadGeneration: number;
    } | null = null;
    /**
     * For a `geojson` collection: the collection it was built from and the
     * updateData diff between them. Absent when the change is not safe or
     * not worth sending as a diff (see `overlayDiff`), or after a load or a
     * visibility toggle.
     */
    private geojsonDiffs = new WeakMap<FeatureCollection, { from: FeatureCollection; diff: GeoJSONSourceDiff }>();
    /** Bumped by every store replacement from the server (load, reload). */
    private loadGeneration = 0;

    /** Everything `toGeojsonFeature` reads from a row (geometry by identity). */
    private renderSignature(f: CourseFeature): RenderSignature {
        return [f.id, f.geometry, f.type, f.holeId, f.sortOrder, this.stackKeyFor(f), f.source];
    }

    /**
     * GENERATED features as their own WGS84 FeatureCollection (see
     * `GENERATED_OVERLAY_ID`). Memoized on the identity-stable
     * `generatedFeatures` array + the visibility sets, so a hand-drawn edit
     * returns the SAME collection object and `attachOverlay` skips the
     * source re-send entirely.
     */
    readonly generatedGeojson = new Computed<FeatureCollection>(() => {
        const items = this.generatedFeatures.get();
        const hidden = this.hiddenTypes.get();
        const hiddenIds = this.hiddenIds.get();
        const hiddenSources = this.hiddenSources.get();
        const memo = this.generatedGeojsonMemo;
        if (memo && memo.items === items && memo.hidden === hidden && memo.hiddenIds === hiddenIds
            && memo.hiddenSources === hiddenSources) {
            return memo.data;
        }
        const features: Feature[] = items
            .filter(f => !hidden.has(f.type) && !hiddenIds.has(f.id) && !hiddenSources.has(f.source!))
            .map(f => this.toGeojsonFeature(f));
        const data: FeatureCollection = { type: 'FeatureCollection', features };
        this.generatedRebuildCount++;
        this.generatedGeojsonMemo = { items, hidden, hiddenIds, hiddenSources, data };
        return data;
    });
    private generatedGeojsonMemo: {
        items: CourseFeature[];
        hidden: ReadonlySet<string>;
        hiddenIds: ReadonlySet<string>;
        hiddenSources: ReadonlySet<string>;
        data: FeatureCollection;
    } | null = null;

    /** Number of times `generatedGeojson` actually rebuilt (perf tests / diagnostics). */
    get generatedRebuilds(): number {
        return this.generatedRebuildCount;
    }
    private generatedRebuildCount = 0;

    private toGeojsonFeature(f: CourseFeature): Feature {
        return {
            type: 'Feature',
            id: f.id,
            properties: {
                id: f.id,
                type: f.type,
                holeId: f.holeId,
                sortOrder: f.sortOrder,
                stackKey: this.stackKeyFor(f),
                source: f.source,
            },
            geometry: {
                type: 'Polygon',
                coordinates: geometryToWgs84Rings(f.geometry),
            } satisfies Polygon,
        };
    }

    /**
     * Every feature across the whole course (hidden types included — hit
     * testing decides what to skip), topmost-first by the D24 global stack
     * key. Cached: only recomputes when the store or hole numbers change,
     * not per hit-test call.
     */
    readonly stackTopDown = new Computed<CourseFeature[]>(() =>
        [...this.store.items.get()].sort((a, b) => this.stackKeyFor(b) - this.stackKeyFor(a)));

    constructor(private featuresApi: CourseFeaturesApi = api.courseFeatures) {}

    /** D24 stack key for one feature (see `GROUP_RANK_SPAN`). */
    private stackKeyFor(f: CourseFeature): number {
        const groupRank = f.holeId === null
            ? 0
            : this.courseDetail.holes.get().find(h => h.id === f.holeId)?.number ?? 0;
        return groupRank * GROUP_RANK_SPAN + f.sortOrder;
    }

    /**
     * D24 stack key for the feature with `id` (0 when unknown). Public so the
     * draw tool's transient drag ghosts can carry their original feature's
     * `stackKey` and z-sort seamlessly with the persistent overlay (T24).
     */
    stackKeyForId(id: string): number {
        const f = this.store.items.peek().find(item => item.id === id);
        return f ? this.stackKeyFor(f) : 0;
    }

    /**
     * A group's features (course-level when `holeId` is null) ordered
     * bottom-to-top by `sortOrder` (D23). Not memoized — cheap filter+sort
     * over one group, called on demand (panel row lists, reorder ops).
     */
    stackFor(holeId: string | null): CourseFeature[] {
        return this.store.items.get()
            .filter(f => f.holeId === holeId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    /** Load all features for a course. Cached per courseId. */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        // Land queued saves for the previous course before its rows go.
        await this.flush();
        this.selectedIds.set(new Set());
        const items = await request(this.loading, this.error, () =>
            this.featuresApi.listByCourse({ courseId }));
        if (!items) return; // failed — error signal set, cache untouched
        this.loadGeneration++;
        this.store.set(items);
        this.loadedCourseId = courseId;
    }

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.dropQueues();
        this.loadedCourseId = null;
        await this.load(courseId);
    }

    /**
     * Guarantee `courseId`'s features are freshly loaded — re-fetch when it
     * is the loaded course, initial-load otherwise. Post-import refresh
     * MUST use this, not `reload()`: opening a course and importing before
     * the draw tool ever activates leaves the store unloaded, and a bare
     * `reload()` silently no-ops — features land in the DB but nothing
     * renders until a full page reload.
     */
    async reloadOrLoad(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) this.loadedCourseId = null;
        await this.load(courseId);
    }

    /** Replace the selection with a single feature (or clear with null). */
    select(id: string | null): void {
        this.selectedIds.set(id ? new Set([id]) : new Set());
    }

    /** Replace the whole selection (marquee result, duplicate clones). */
    setSelection(ids: Iterable<string>): void {
        this.selectedIds.set(new Set(ids));
    }

    /** Toggle one feature's selection membership (Cmd/Ctrl+click). */
    toggleSelected(id: string): void {
        const next = new Set(this.selectedIds.peek());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.selectedIds.set(next);
    }

    /**
     * Toggle a feature TYPE's visibility (panel eye icons). Hiding a type
     * also drops its features from the selection — invisible features
     * must not remain silently editable.
     */
    toggleTypeVisibility(type: string): void {
        const next = new Set(this.hiddenTypes.peek());
        if (next.has(type)) {
            next.delete(type);
        } else {
            next.add(type);
            const keep = new Set([...this.selectedIds.peek()].filter(id => {
                const f = this.store.items.peek().find(item => item.id === id);
                return f !== undefined && f.type !== type;
            }));
            if (keep.size !== this.selectedIds.peek().size) this.selectedIds.set(keep);
        }
        this.hiddenTypes.set(next);
    }

    /**
     * Toggle ONE feature's visibility (stack panel eye toggles). Hiding a
     * feature also drops it from the selection — same invariant as
     * `toggleTypeVisibility`: invisible features must not remain silently
     * editable.
     */
    toggleFeatureVisibility(id: string): void {
        const next = new Set(this.hiddenIds.peek());
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
            if (this.selectedIds.peek().has(id)) {
                const keep = new Set(this.selectedIds.peek());
                keep.delete(id);
                this.selectedIds.set(keep);
            }
        }
        this.hiddenIds.set(next);
    }

    /**
     * Toggle a generated SOURCE's visibility (stack panel group-row eye).
     * Hiding drops that source's features from the selection, like the
     * type/id toggles.
     */
    toggleSourceVisibility(source: string): void {
        const next = new Set(this.hiddenSources.peek());
        if (next.has(source)) {
            next.delete(source);
        } else {
            next.add(source);
            const keep = new Set([...this.selectedIds.peek()].filter(id => {
                const f = this.store.items.peek().find(item => item.id === id);
                return f !== undefined && f.source !== source;
            }));
            if (keep.size !== this.selectedIds.peek().size) this.selectedIds.set(keep);
        }
        this.hiddenSources.set(next);
    }

    /** True when `f` is hidden by any of the three view toggles (type, id, source). */
    isHidden(f: CourseFeature): boolean {
        return this.hiddenTypes.peek().has(f.type)
            || this.hiddenIds.peek().has(f.id)
            || (f.source !== null && this.hiddenSources.peek().has(f.source));
    }

    /**
     * Create a feature (autosave on ring close). Selects it on success
     * unless `select: false` (the caller sets the selection itself).
     */
    async create(input: CreateInput, opts: { select?: boolean } = {}): Promise<CourseFeature | undefined> {
        const created = await this.createMany([input], opts);
        return created?.[0];
    }

    /**
     * Create several features with ONE request (`createMany`; a single item
     * uses `create`) and add them to the store in one `batch()`, so the
     * overlay collection rebuilds once. Selects all of them on success
     * unless `select: false`. Returns undefined on failure (`saveError` set,
     * nothing added).
     */
    async createMany(inputs: CreateInput[], opts: { select?: boolean } = {}): Promise<CourseFeature[] | undefined> {
        const courseId = this.loadedCourseId;
        if (!courseId || inputs.length === 0) return undefined;
        const done = this.track(inputs.length === 1
            ? request(this.saving, this.saveError, () => this.featuresApi.create({ courseId, ...inputs[0]! }))
                .then(c => c && [c])
            : request(this.saving, this.saveError, () => this.featuresApi.createMany({ courseId, items: inputs })));
        const server = await done;
        if (!server) return undefined;
        // The server stores exactly the geometry it was sent: keep the local
        // object so the flatten cache and history snapshots share it.
        const created = server.map((c, i) => ({ ...c, geometry: inputs[i]?.geometry ?? c.geometry }));
        batched(() => {
            for (const c of created) this.store.add(c);
            if (opts.select !== false) this.selectedIds.set(new Set(created.map(c => c.id)));
        });
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
     * Persist a partial update (geometry / type / holeId) through the
     * feature's save queue (see `SaveQueue`): one request in flight per
     * feature, later patches coalesce into one pending patch that goes out
     * with the version the reply returned. Geometry-only patches wait
     * `geometryDebounceMs` for more; type/holeId patches go as soon as the
     * feature is idle. Callers `patchLocal` first for instant feedback.
     *
     * Resolves with the stored row once the request carrying this patch
     * lands. On version conflict or other failure, `saveError` is set, every
     * queued patch is dropped and the store re-syncs from the server.
     */
    update(id: string, patch: FeaturePatch): Promise<CourseFeature | undefined> {
        if (!this.store.items.peek().some(f => f.id === id)) {
            this.saveError.set({ message: `Feature ${id} not found`, code: 'unknown' });
            void this.reload();
            return Promise.resolve(undefined);
        }
        const q = this.queueFor(id);
        return new Promise(resolve => {
            const pending = q.pending ??= { patch: {}, base: null!, waiters: [], timer: null, ready: false };
            Object.assign(pending.patch, definedFields(patch));
            pending.base = this.baseOf(id)!;
            pending.waiters.push(resolve);
            if (pending.timer) clearTimeout(pending.timer);
            pending.timer = null;
            const geometryOnly = Object.keys(pending.patch).every(k => k === 'geometry');
            if (geometryOnly && !pending.ready && this.geometryDebounceMs > 0) {
                pending.timer = setTimeout(() => {
                    pending.timer = null;
                    pending.ready = true;
                    this.kick(id);
                }, this.geometryDebounceMs);
            } else {
                pending.ready = true;
                this.kick(id);
            }
        });
    }

    /**
     * Persist updates to several features with ONE request (`updateMany`;
     * a single item uses `update`), bypassing the debounce. With
     * `local: true` the patches land in the store first, in one `batch()`
     * (undo/redo, retype, multi-move). Earlier queued saves for the same
     * features go out first, so versions never race. The reply is applied
     * in one `batch()` with the LOCAL geometry objects kept, so an
     * unchanged render does not re-send the overlay.
     */
    async updateMany(
        items: { id: string; patch: FeaturePatch }[],
        opts: { local?: boolean } = {},
    ): Promise<CourseFeature[] | undefined> {
        if (items.length === 0) return [];
        if (opts.local) {
            batched(() => {
                for (const { id, patch } of items) {
                    const row = this.store.items.peek().find(f => f.id === id);
                    if (row) this.store.patch({ ...row, ...definedFields(patch) });
                }
            });
        }
        const ids = items.map(i => i.id);
        const bases = new Map(ids.map(id => [id, this.baseOf(id)]));
        const work = (async () => {
            const release = await this.acquire(ids);
            try {
                const versions = new Map<string, number>();
                for (const { id } of items) {
                    const row = this.store.items.peek().find(f => f.id === id);
                    if (row) versions.set(id, row.version);
                }
                const live = items.filter(i => versions.has(i.id) && bases.get(i.id));
                if (live.length === 0) return [];
                const body = live.map(({ id, patch }) => ({ id, version: versions.get(id)!, ...definedFields(patch) }));
                const server = body.length === 1
                    ? await request(this.saving, this.saveError, () => this.featuresApi.update(body[0]!)).then(r => r && [r])
                    : await request(this.saving, this.saveError, () => this.featuresApi.updateMany({ items: body }));
                if (server === undefined) {
                    this.dropQueues();
                    void this.reload();
                    return undefined;
                }
                const patches = new Map(live.map(i => [i.id, i.patch]));
                const result: CourseFeature[] = [];
                batched(() => {
                    for (const row of server) {
                        const merged = this.mergeReply(row, bases.get(row.id)!, patches.get(row.id) ?? {});
                        result.push(merged ?? row);
                    }
                });
                return result;
            } finally {
                release();
            }
        })();
        return this.track(work);
    }

    /** Delete a feature. Deselects it. See `removeMany`. */
    async removeFeature(id: string): Promise<boolean> {
        return this.removeMany([id]);
    }

    /**
     * Delete several features with ONE request (`removeMany`; a single id
     * uses `remove`). The rows leave the store and the selection first, in
     * one `batch()`; queued patches for them are dropped and an in-flight
     * save is awaited for its version. On failure `saveError` is set and the
     * store re-syncs from the server (the rows come back).
     */
    async removeMany(ids: string[]): Promise<boolean> {
        const rows = ids
            .map(id => this.store.items.peek().find(f => f.id === id))
            .filter((f): f is CourseFeature => f !== undefined);
        if (rows.length === 0) return false;
        const gone = new Set(rows.map(r => r.id));
        for (const id of gone) this.cancelPending(id);
        batched(() => {
            for (const id of gone) this.store.remove(id);
            const selection = this.selectedIds.peek();
            if ([...selection].some(id => gone.has(id))) {
                this.selectedIds.set(new Set([...selection].filter(id => !gone.has(id))));
            }
        });
        const work = (async () => {
            const release = await this.acquire([...gone]);
            try {
                const items = rows.map(r => ({ id: r.id, version: this.removedVersions.get(r.id) ?? r.version }));
                const result = items.length === 1
                    ? await request(this.saving, this.saveError, () => this.featuresApi.remove(items[0]!))
                    : await request(this.saving, this.saveError, () => this.featuresApi.removeMany({ items }));
                if (result === undefined) {
                    this.dropQueues();
                    void this.reload();
                    return false;
                }
                return true;
            } finally {
                for (const id of gone) this.removedVersions.delete(id);
                release();
            }
        })();
        return this.track(work);
    }

    /**
     * Resolves once every queued and in-flight save has landed (debounced
     * patches are sent immediately). Call before deactivating the editor
     * or switching course; tests use it to wait for the queue to drain.
     */
    async flush(): Promise<void> {
        for (;;) {
            const waits: Promise<unknown>[] = [...this.inflight];
            for (const [id, q] of this.queues) {
                if (q.pending && !q.pending.ready) {
                    if (q.pending.timer) clearTimeout(q.pending.timer);
                    q.pending.timer = null;
                    q.pending.ready = true;
                    this.kick(id);
                }
                if (q.busy) waits.push(q.busy);
            }
            if (waits.length === 0) return;
            await Promise.all(waits);
        }
    }

    // ── Save queue internals ─────────────────────────────────────────────

    /** Trailing debounce for geometry-only `update` patches, in ms. */
    geometryDebounceMs = 150;
    private readonly queues = new Map<string, SaveQueue>();
    /** Every create/updateMany/removeMany request still in flight (`flush`). */
    private readonly inflight = new Set<Promise<unknown>>();
    /**
     * Versions returned by saves that landed after their row left the store
     * (removed locally while the save was in flight); `removeMany` sends them.
     */
    private readonly removedVersions = new Map<string, number>();

    private track<T>(work: Promise<T>): Promise<T> {
        this.inflight.add(work);
        const done = () => { this.inflight.delete(work); };
        work.then(done, done);
        return work;
    }

    private queueFor(id: string): SaveQueue {
        let q = this.queues.get(id);
        if (!q) {
            q = { busy: null, pending: null };
            this.queues.set(id, q);
        }
        return q;
    }

    /** Send `id`'s pending patch when it is due and nothing is in flight for `id`. */
    private kick(id: string): void {
        const q = this.queues.get(id);
        if (!q) return;
        if (q.busy || !q.pending?.ready) {
            if (!q.busy && !q.pending) this.queues.delete(id);
            return;
        }
        const pending = q.pending;
        q.pending = null;
        const release = this.claim([id]);
        void this.sendUpdate(id, pending).finally(release);
    }

    private async sendUpdate(id: string, pending: PendingPatch): Promise<void> {
        const sent = this.store.items.peek().find(f => f.id === id);
        if (!sent) {
            for (const w of pending.waiters) w(undefined);
            return;
        }
        const server = await request(this.saving, this.saveError, () =>
            this.featuresApi.update({ id, version: sent.version, ...pending.patch }));
        if (server === undefined) {
            this.dropQueues();
            for (const w of pending.waiters) w(undefined);
            void this.reload();
            return;
        }
        const merged = this.mergeReply(server, pending.base, pending.patch);
        for (const w of pending.waiters) w(merged ?? server);
    }

    /** The row's geometry/type/holeId when a save is requested (see `mergeReply`). */
    private baseOf(id: string): Required<FeaturePatch> | null {
        const row = this.store.items.peek().find(f => f.id === id);
        return row ? { geometry: row.geometry, type: row.type, holeId: row.holeId } : null;
    }

    /**
     * Patch the store with a save reply. Not the raw server row: its geometry
     * is a freshly parsed object that would miss the flatten cache and
     * re-send the whole overlay. A field the store changed locally after the
     * save was requested (`base` → current) keeps the local value; otherwise
     * geometry takes the object the caller passed (or the current one) and
     * type/holeId take the server's. Returns undefined when the row left the
     * store meanwhile (its version is kept for `removeMany`).
     */
    private mergeReply(server: CourseFeature, base: Required<FeaturePatch>, patch: FeaturePatch): CourseFeature | undefined {
        const current = this.store.items.peek().find(f => f.id === server.id);
        if (!current) {
            this.removedVersions.set(server.id, server.version);
            return undefined;
        }
        const merged: CourseFeature = {
            ...server,
            geometry: current.geometry !== base.geometry ? current.geometry : (patch.geometry ?? current.geometry),
            type: current.type !== base.type ? current.type : server.type,
            holeId: current.holeId !== base.holeId ? current.holeId : server.holeId,
        };
        this.store.patch(merged);
        return merged;
    }

    /** Mark `ids` busy until the returned release runs; release sends what queued up meanwhile. */
    private claim(ids: string[]): () => void {
        let resolve!: () => void;
        const busy = new Promise<void>(r => { resolve = r; });
        for (const id of ids) this.queueFor(id).busy = busy;
        return () => {
            for (const id of ids) {
                const q = this.queues.get(id);
                if (q?.busy === busy) q.busy = null;
                this.kick(id);
            }
            resolve();
        };
    }

    /** Wait until every id is idle (queued patches sent first), then claim them all. */
    private async acquire(ids: string[]): Promise<() => void> {
        for (;;) {
            const waits: Promise<void>[] = [];
            for (const id of ids) {
                const q = this.queues.get(id);
                if (!q) continue;
                if (q.pending && !q.pending.ready) {
                    if (q.pending.timer) clearTimeout(q.pending.timer);
                    q.pending.timer = null;
                    q.pending.ready = true;
                    this.kick(id);
                }
                if (q.busy) waits.push(q.busy);
            }
            if (waits.length === 0) return this.claim(ids);
            await Promise.all(waits);
        }
    }

    /** Drop `id`'s unsent patch (the feature is being deleted). */
    private cancelPending(id: string): void {
        const q = this.queues.get(id);
        const pending = q?.pending;
        if (!q || !pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        q.pending = null;
        for (const w of pending.waiters) w(undefined);
    }

    /** Drop every unsent patch (a failed save re-syncs the store from the server). */
    private dropQueues(): void {
        for (const id of [...this.queues.keys()]) this.cancelPending(id);
    }

    // ── Stack reorder (D27 verbs) ───────────────────────────────────────

    /** Raise the given features one step toward the top of their group's stack. */
    async raise(ids: string[]): Promise<boolean> {
        return this.reorderOp(ids, order => shiftBlock(order, new Set(ids), 1));
    }

    /** Lower the given features one step toward the bottom of their group's stack. */
    async lower(ids: string[]): Promise<boolean> {
        return this.reorderOp(ids, order => shiftBlock(order, new Set(ids), -1));
    }

    /** Raise the given features to the top of their group's stack. */
    async raiseToTop(ids: string[]): Promise<boolean> {
        return this.reorderOp(ids, order => moveBlockToEdge(order, new Set(ids), 'top'));
    }

    /** Lower the given features to the bottom of their group's stack. */
    async lowerToBottom(ids: string[]): Promise<boolean> {
        return this.reorderOp(ids, order => moveBlockToEdge(order, new Set(ids), 'bottom'));
    }

    /**
     * Shared reorder plumbing: resolve `ids`' shared group (they must all
     * share one `holeId` — mixed-group calls are a no-op, since D23's stack
     * is scoped per group), compute the new order, patch `sortOrder`
     * optimistically, then persist via the reorder endpoint. Reverts (via
     * `reload()`) on failure, matching `update`'s error handling.
     */
    private async reorderOp(ids: string[], compute: (order: string[]) => string[]): Promise<boolean> {
        const courseId = this.loadedCourseId;
        if (!courseId || ids.length === 0) return false;
        const rows = ids.map(id => this.store.items.peek().find(f => f.id === id));
        const first = rows[0];
        if (!first || rows.some(r => !r || r.holeId !== first.holeId)) return false;
        if (rows.some(r => r && isGeneratedFeature(r))) return false; // generated rows are read-only
        const holeId = first.holeId;
        const order = this.stackFor(holeId).map(f => f.id);
        const nextOrder = compute(order);
        if (nextOrder.length === order.length && nextOrder.every((id, i) => id === order[i])) return true; // no-op (already at the edge)

        // Optimistic local patch — mirrors furniture.service.ts's applySortOrder.
        nextOrder.forEach((id, index) => {
            const row = this.store.items.peek().find(f => f.id === id);
            if (row) this.store.patch({ ...row, sortOrder: index });
        });
        const result = await request(this.saving, this.saveError, () =>
            this.featuresApi.reorder({ courseId, holeId, orderedIds: nextOrder }));
        if (result === undefined) {
            await this.reload();
            return false;
        }
        return true;
    }

    /**
     * Bind the persistent features overlay to the map: adds fill + outline
     * + selection-highlight layers when the map is ready, keeps the data in
     * sync with `geojson`, and re-adds after map re-creation (`ready`
     * false → true). Returns a disposer (give it to a component `track`).
     *
     * Selection is a `selected` feature-state read by the features-selected
     * line paint. Selecting touches neither the source data nor any layer
     * filter, so it costs no worker message and no bucket re-layout.
     *
     * Data updates: when `geojson` records a diff from the collection last
     * sent (see `geojsonDiffs`) and Draw mode is on, the change goes out as
     * a GeoJSONSource.updateData diff, which re-tiles only the changed
     * features. Nice mode, the first send, visibility toggles and loads
     * send the full collection with setData.
     */
    attachOverlay(map: MapService): () => void {
        let added = false;
        let lastGeneratedSent: FeatureCollection | null = null;
        // Last hand-drawn collection + paint mode handed to the map. The
        // effect re-runs on every store change (selection-independent, but
        // e.g. a generated-row delete or a version bump); `geojson` is
        // identity-stable, so an unchanged pair means nothing visible moved.
        let lastRawSent: FeatureCollection | null = null;
        let lastNiceSent = false;
        this.overlayMap = map;
        // Ids that currently carry the `selected` feature-state on the map.
        let selectionState = new Set<string>();
        // Move the `selected` state from `selectionState` to `ids`. Each id
        // is set on both sources: a feature lives in exactly one of them,
        // and state on an id a source does not have is inert. Map fakes in
        // unit tests may lack the feature-state methods, hence the `?.`.
        const applySelection = (ids: ReadonlySet<string>): void => {
            const raw = map.map.peek();
            if (!raw) return;
            for (const id of selectionState) {
                if (ids.has(id)) continue;
                raw.removeFeatureState?.({ source: FEATURES_OVERLAY_ID, id }, 'selected');
                raw.removeFeatureState?.({ source: GENERATED_OVERLAY_ID, id }, 'selected');
            }
            for (const id of ids) {
                if (selectionState.has(id)) continue;
                raw.setFeatureState?.({ source: FEATURES_OVERLAY_ID, id }, { selected: true });
                raw.setFeatureState?.({ source: GENERATED_OVERLAY_ID, id }, { selected: true });
            }
            selectionState = new Set(ids);
        };
        // Per-feature "dragging" state hides originals while the draw
        // tool renders their ghost (paint-only — no source/layout work).
        const draggingHide = (visible: number): unknown =>
            ['case', ['boolean', ['feature-state', 'dragging'], false], 0, visible];
        // Selection outline: drawn only for features whose `selected`
        // state is set, and hidden while the feature is dragging.
        const selectedOpacity = [
            'case',
            ['boolean', ['feature-state', 'dragging'], false], 0,
            ['boolean', ['feature-state', 'selected'], false], 1,
            0,
        ];
        const disposeData = effect(() => {
            const ready = map.ready.get();
            const nice = this.niceRendering.get();
            const rawData = this.geojson.get();
            // Generated trees overlay the surface stack (no occlusion
            // resolution needed — they are never differenced against it).
            const generated = this.generatedGeojson.get();
            if (!ready) {
                added = false; // overlay died with the map
                lastGeneratedSent = null;
                lastRawSent = null;
                return;
            }
            const featuresChanged = rawData !== lastRawSent || nice !== lastNiceSent;
            const data = !added || featuresChanged
                ? (nice ? resolveSurfaceStack(rawData) : rawData)
                : null;
            const previousRaw = lastRawSent;
            const previousNice = lastNiceSent;
            lastRawSent = rawData;
            lastNiceSent = nice;
            if (!added) {
                // Set the correct paint at layer creation too. On a cold map
                // load, the tint effect can observe `ready` before this
                // effect finishes adding layers; `added` is deliberately not
                // reactive, so that missed pass cannot be our only initial
                // configuration path.
                const fillOpacity = draggingHide(nice ? NICE_FILL_OPACITY : DRAW_FILL_OPACITY);
                const boundaryOpacity = draggingHide(nice ? 0 : 1);
                map.addOverlayLayer(FEATURES_OVERLAY_ID, data!, [
                    {
                        id: 'features-fill',
                        type: 'fill',
                        // D23/D24: explicit per-feature stack order, not the
                        // TYPE_Z_ORDER heuristic — sort keys make later-in-
                        // stack features render on top within this one layer.
                        layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'fill-color': typeColorExpression('draw') as never,
                            'fill-opacity': fillOpacity as never,
                        },
                    },
                    {
                        id: 'features-outline',
                        type: 'line',
                        filter: surfaceOutlineFilter(),
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': boundaryOpacity as never,
                        },
                    },
                    {
                        // Rules do not belong to the material-tint texture.
                        // Their boundaries stay visible while drawing and are
                        // hidden with every other feature boundary in nice mode.
                        id: 'features-rules-outline',
                        type: 'line',
                        filter: rulesOutlineFilter(),
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': boundaryOpacity as never,
                        },
                    },
                    {
                        id: 'features-selected',
                        type: 'line',
                        paint: {
                            'line-color': SELECTION_COLOR,
                            'line-width': 2.5,
                            'line-opacity': selectedOpacity as never,
                        },
                    },
                ], { waterSurface: true, promoteId: 'id' });
                // Generated features: own source, slotted just under the
                // hand-drawn selection highlight (above hand-drawn fills, so
                // canopy reads as the topmost surface, like drawn trees).
                map.addOverlayLayer(GENERATED_OVERLAY_ID, generated, [
                    {
                        id: 'features-generated-fill',
                        type: 'fill',
                        layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'fill-color': typeColorExpression('draw') as never,
                            'fill-opacity': nice ? NICE_FILL_OPACITY : DRAW_FILL_OPACITY,
                        },
                    },
                    {
                        id: 'features-generated-outline',
                        type: 'line',
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': nice ? 0 : 1,
                        },
                    },
                    {
                        id: 'features-generated-selected',
                        type: 'line',
                        paint: {
                            'line-color': SELECTION_COLOR,
                            'line-width': 2.5,
                            'line-opacity': selectedOpacity as never,
                        },
                    },
                ], { beforeId: 'features-selected', promoteId: 'id' });
                lastGeneratedSent = generated;
                added = true;
                // Fresh sources carry no feature-state: re-apply the selection.
                selectionState = new Set();
                applySelection(this.selectedIds.peek());
            } else {
                if (data) {
                    // A diff applies only to the exact collection the map
                    // holds, and only in Draw mode (nice mode sends the
                    // resolved surface stack, not `geojson` itself).
                    const step = !nice && !previousNice ? this.geojsonDiffs.get(rawData) : undefined;
                    if (step && step.from === previousRaw) map.updateOverlayData(FEATURES_OVERLAY_ID, data, step.diff);
                    else map.updateOverlayData(FEATURES_OVERLAY_ID, data);
                }
                // Identity check: `generatedGeojson` hands back the same
                // object while the generated set is unchanged, so hand-drawn
                // edits never re-send the ~60k-vertex canopy collection.
                if (generated !== lastGeneratedSent) {
                    lastGeneratedSent = generated;
                    map.updateOverlayData(GENERATED_OVERLAY_ID, generated);
                }
            }
        });
        const disposeSelection = effect(() => {
            const ids = this.selectedIds.get();
            if (!map.ready.get() || !added) return;
            applySelection(ids);
        });
        const disposeTint = effect(() => {
            // Nice mode uses the proven MapLibre fill path as a baseline:
            // same data and D24 sort order as Draw, photo-blended opacity,
            // and no strokes.
            const ready = map.ready.get();
            const nice = this.niceRendering.get();
            if (!ready || !added) return;
            const rawMap = map.map.get();
            if (!rawMap) return;

            if (nice) {
                rawMap.setPaintProperty('features-fill', 'fill-opacity', draggingHide(NICE_FILL_OPACITY) as never);
                rawMap.setPaintProperty('features-outline', 'line-opacity', draggingHide(0) as never);
                rawMap.setPaintProperty('features-rules-outline', 'line-opacity', draggingHide(0) as never);
                rawMap.setPaintProperty('features-generated-fill', 'fill-opacity', NICE_FILL_OPACITY);
                rawMap.setPaintProperty('features-generated-outline', 'line-opacity', 0);
            } else {
                rawMap.setPaintProperty('features-fill', 'fill-opacity', draggingHide(DRAW_FILL_OPACITY) as never);
                rawMap.setPaintProperty('features-outline', 'line-opacity', draggingHide(1) as never);
                rawMap.setPaintProperty('features-rules-outline', 'line-opacity', draggingHide(1) as never);
                rawMap.setPaintProperty('features-generated-fill', 'fill-opacity', DRAW_FILL_OPACITY);
                rawMap.setPaintProperty('features-generated-outline', 'line-opacity', 1);
            }
        });
        return () => {
            disposeData();
            disposeSelection();
            disposeTint();
            this.overlayMap = null;
            if (added) {
                map.removeOverlayLayer(GENERATED_OVERLAY_ID);
                map.removeOverlayLayer(FEATURES_OVERLAY_ID);
            }
        };
    }

    /** Map the overlay is currently attached to (drag feature-state target). */
    private overlayMap: MapService | null = null;

    /**
     * Hide/unhide features in the persistent overlay while the draw tool
     * drags their ghost. Feature-state only touches paint — per-call cost
     * is O(ids), no source re-send or layer re-layout. No-op when the
     * overlay is not attached/ready (nothing to hide then anyway).
     */
    setDragging(ids: Iterable<string>, dragging: boolean): void {
        const svc = this.overlayMap;
        const map = svc?.ready.peek() ? svc.map.peek() : null;
        if (!map || !map.getSource(FEATURES_OVERLAY_ID)) return;
        const featureIds = [...ids];
        for (const id of featureIds) {
            if (dragging) map.setFeatureState({ source: FEATURES_OVERLAY_ID, id }, { dragging: true });
            else map.removeFeatureState({ source: FEATURES_OVERLAY_ID, id }, 'dragging');
        }
    }
}

/** Fields `update` / `updateMany` can persist. */
export type FeaturePatch = { geometry?: FeatureGeometry; type?: string; holeId?: string | null };

/** Input for `create` / `createMany`. */
export type CreateInput = { type: string; holeId?: string | null; geometry: FeatureGeometry };

/** Unsent `update` patches for one feature, merged in call order. */
interface PendingPatch {
    patch: FeaturePatch;
    /** Row fields at the latest `update` call merged into `patch`. */
    base: Required<FeaturePatch>;
    /** Resolvers of every `update` call merged into this patch. */
    waiters: Array<(row: CourseFeature | undefined) => void>;
    /** Geometry debounce timer; null once due or when not debounced. */
    timer: ReturnType<typeof setTimeout> | null;
    /** True when the patch may go as soon as the feature is idle. */
    ready: boolean;
}

/**
 * Per-feature save queue. `busy` is the request in flight for this feature
 * (a single update or a batch that includes it); `pending` collects later
 * patches and is sent after `busy` settles, with the version it returned.
 */
interface SaveQueue {
    busy: Promise<void> | null;
    pending: PendingPatch | null;
}

function definedFields(patch: FeaturePatch): FeaturePatch {
    const out: FeaturePatch = {};
    if (patch.geometry !== undefined) out.geometry = patch.geometry;
    if (patch.type !== undefined) out.type = patch.type;
    if (patch.holeId !== undefined) out.holeId = patch.holeId;
    return out;
}

let batchDepth = 0;

/**
 * `batch()` that nests: core's batch flushes when ANY batch ends, so an
 * inner batch would flush the outer one early. Only the outermost call
 * batches; history.ts wraps a remove + update pair in one.
 */
export function batched(fn: () => void): void {
    if (batchDepth > 0) {
        fn();
        return;
    }
    batchDepth++;
    try {
        batch(fn);
    } finally {
        batchDepth--;
    }
}

/** Per-feature render inputs: id, geometry (by identity), type, holeId, sortOrder, stackKey, source. */
type RenderSignature = readonly [string, object, string, string | null, number, number, string | null];

function sameSignatures(a: readonly RenderSignature[], b: readonly RenderSignature[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!, y = b[i]!;
        for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
    }
    return true;
}

function sameSignature(x: RenderSignature, y: RenderSignature): boolean {
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
    return true;
}

/** RenderSignature slot of the geometry; every slot after it is a property. */
const SIG_GEOMETRY = 1;
/** RenderSignature slot of the D24 stackKey. */
const STACK_KEY_SLOT = 5;

/**
 * The updateData diff from the `prev` build of `geojson` to the `next` one,
 * or null when a full setData is required:
 *
 * - more than OVERLAY_DIFF_MAX_FEATURES features changed;
 * - an added or changed feature shares its stackKey with another visible
 *   feature. maplibre's worker moves an updated feature to the end of its
 *   feature list, and the fill/line buckets sort by sort key with a stable
 *   sort, so equal keys draw in source order. A unique key makes the
 *   worker's order irrelevant. Equal keys occur when a local create
 *   leaves its neighbours' sortOrder stale until the next load.
 *
 * Removals never change the order of the remaining features.
 */
function overlayDiff(
    prev: ReadonlyMap<string, { sig: RenderSignature; feature: Feature }>,
    next: ReadonlyMap<string, { sig: RenderSignature; feature: Feature }>,
    signature: readonly RenderSignature[],
): GeoJSONSourceDiff | null {
    const remove: string[] = [];
    const add: Feature[] = [];
    const update: GeoJSONFeatureDiff[] = [];
    let changed = 0;
    for (const id of prev.keys()) {
        if (next.has(id)) continue;
        remove.push(id);
        if (++changed > OVERLAY_DIFF_MAX_FEATURES) return null;
    }
    const touchedKeys: number[] = [];
    for (const [id, { sig, feature }] of next) {
        const before = prev.get(id);
        if (before && before.feature === feature) continue;
        if (++changed > OVERLAY_DIFF_MAX_FEATURES) return null;
        touchedKeys.push(sig[STACK_KEY_SLOT]);
        if (!before) {
            add.push(feature);
            continue;
        }
        const entry: GeoJSONFeatureDiff = { id };
        if (before.sig[SIG_GEOMETRY] !== sig[SIG_GEOMETRY]) entry.newGeometry = feature.geometry;
        let propsChanged = false;
        for (let k = SIG_GEOMETRY + 1; k < sig.length; k++) if (before.sig[k] !== sig[k]) propsChanged = true;
        if (propsChanged) {
            entry.addOrUpdateProperties = Object.entries(feature.properties ?? {}).map(([key, value]) => ({ key, value }));
        }
        update.push(entry);
    }
    if (changed === 0) return null;
    if (touchedKeys.length > 0) {
        const touched = new Set(touchedKeys);
        if (touched.size !== touchedKeys.length) return null;
        let seen = 0;
        for (const sig of signature) if (touched.has(sig[STACK_KEY_SLOT])) seen++;
        if (seen !== touchedKeys.length) return null;
    }
    const diff: GeoJSONSourceDiff = {};
    if (remove.length) diff.remove = remove;
    if (add.length) diff.add = add;
    if (update.length) diff.update = update;
    return diff;
}

const RULES_OUTLINE_TYPES = ['penalty_yellow', 'penalty_red', 'oob'];

function rulesOutlineFilter(): FilterSpecification {
    return ['in', ['get', 'type'], ['literal', RULES_OUTLINE_TYPES]] as unknown as FilterSpecification;
}

function surfaceOutlineFilter(): FilterSpecification {
    return ['!', rulesOutlineFilter()] as unknown as FilterSpecification;
}

/**
 * Move the `ids` subset of `order` one step toward the end (dir=1) or start
 * (dir=-1), preserving their relative order, by swapping past exactly one
 * neighboring non-selected item. No-op if the block is already at that edge.
 * Exported for unit tests.
 */
export function shiftBlock(order: readonly string[], ids: ReadonlySet<string>, dir: 1 | -1): string[] {
    const next = [...order];
    const indices = next.reduce<number[]>((acc, id, i) => {
        if (ids.has(id)) acc.push(i);
        return acc;
    }, []);
    if (indices.length === 0) return next;
    if (dir === 1) {
        const last = indices[indices.length - 1]!;
        if (last >= next.length - 1) return next;
        const [neighbor] = next.splice(last + 1, 1);
        next.splice(indices[0]!, 0, neighbor!);
    } else {
        const first = indices[0]!;
        if (first <= 0) return next;
        const [neighbor] = next.splice(first - 1, 1);
        next.splice(indices[indices.length - 1]!, 0, neighbor!);
    }
    return next;
}

/**
 * Move the `ids` subset of `order` to the top or bottom, preserving their
 * relative order. Exported for unit tests.
 */
export function moveBlockToEdge(order: readonly string[], ids: ReadonlySet<string>, edge: 'top' | 'bottom'): string[] {
    const selected = order.filter(id => ids.has(id));
    const rest = order.filter(id => !ids.has(id));
    return edge === 'top' ? [...rest, ...selected] : [...selected, ...rest];
}
