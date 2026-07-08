import { Signal, Computed, effect, di } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { CourseFeature, CourseFeaturesApi } from '../../../shared/api/course-features.gen';
import type { FeatureCollection, Feature, Polygon } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import { flattenRing, type FeatureGeometry } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { MapService } from '../map/map.service';
import { typeColorExpression, SELECTION_COLOR } from './feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';

/**
 * D24 global composition key: `groupRank * 4096 + sortOrder`, groupRank 0 =
 * course-level, else the hole's number. Matches the server's
 * `geojsonByCourse` formula exactly (course-features.service.ts) so live-edit
 * GeoJSON and server-materialized GeoJSON agree.
 */
const GROUP_RANK_SPAN = 4096;

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
        const flat = flattenRing(ring, FLATTEN_TOLERANCE_M, geometry.curveType);
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

    /** All currently selected features (store order). */
    readonly selectedFeatures = new Computed<CourseFeature[]>(() => {
        const ids = this.selectedIds.get();
        if (ids.size === 0) return [];
        return this.store.items.get().filter(f => ids.has(f.id));
    });

    /**
     * All VISIBLE features as a WGS84 FeatureCollection with rendering
     * properties (`type`, `holeId`). Recomputes on store and visibility
     * changes; unchanged geometries hit the flatten cache. Hidden types
     * are filtered HERE (rather than via per-layer filters) so one
     * computed drives fill, outline and selection layers consistently.
     *
     * Deliberately NOT selection-dependent: this collection is ~20 MB of
     * flattened rings for a full course and every change re-sends it to
     * the MapLibre worker for a full re-tile (~250 ms) — selection
     * highlighting is a per-layer FILTER (see attachOverlay) and per-frame
     * drag feedback is a ghost overlay (see DrawToolService) so neither
     * touches this collection.
     */
    readonly geojson = new Computed<FeatureCollection>(() => {
        const hidden = this.hiddenTypes.get();
        const features: Feature[] = this.store.items.get()
            .filter(f => !hidden.has(f.type))
            .map(f => ({
                type: 'Feature',
                id: f.id,
                properties: {
                    id: f.id,
                    type: f.type,
                    holeId: f.holeId,
                    sortOrder: f.sortOrder,
                    stackKey: this.stackKeyFor(f),
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: geometryToWgs84Rings(f.geometry),
                } satisfies Polygon,
            }));
        return { type: 'FeatureCollection', features };
    });

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
        this.selectedIds.set(new Set());
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
            this.selectedIds.set(new Set([created.id]));
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
        if (this.selectedIds.peek().has(id)) {
            const next = new Set(this.selectedIds.peek());
            next.delete(id);
            this.selectedIds.set(next);
        }
        return true;
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
     * Selection is a features-selected layer FILTER (cheap layer re-layout,
     * ~40 ms) rather than a `selected` geojson property (full ~20 MB source
     * re-send, ~250 ms) — see the `geojson` doc comment.
     */
    attachOverlay(map: MapService): () => void {
        let added = false;
        this.overlayMap = map;
        // Per-feature "dragging" state hides originals while the draw
        // tool renders their ghost (paint-only — no source/layout work).
        const draggingHide = (visible: number): unknown =>
            ['case', ['boolean', ['feature-state', 'dragging'], false], 0, visible];
        const disposeData = effect(() => {
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
                        // D23/D24: explicit per-feature stack order, not the
                        // TYPE_Z_ORDER heuristic — sort keys make later-in-
                        // stack features render on top within this one layer.
                        layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'fill-color': typeColorExpression('fill') as never,
                            'fill-opacity': draggingHide(0.4) as never,
                        },
                    },
                    {
                        id: 'features-outline',
                        type: 'line',
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': draggingHide(1) as never,
                        },
                    },
                    {
                        id: 'features-selected',
                        type: 'line',
                        filter: selectionFilter(this.selectedIds.peek()),
                        paint: {
                            'line-color': SELECTION_COLOR,
                            'line-width': 2.5,
                            'line-opacity': draggingHide(1) as never,
                        },
                    },
                ]);
                added = true;
            } else {
                map.updateOverlayData(FEATURES_OVERLAY_ID, data);
            }
        });
        const disposeSelection = effect(() => {
            const ids = this.selectedIds.get();
            if (!map.ready.get() || !added) return;
            map.map.get()?.setFilter('features-selected', selectionFilter(ids));
        });
        return () => {
            disposeData();
            disposeSelection();
            this.overlayMap = null;
            if (added) map.removeOverlayLayer(FEATURES_OVERLAY_ID);
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
        for (const id of ids) {
            if (dragging) map.setFeatureState({ source: FEATURES_OVERLAY_ID, id }, { dragging: true });
            else map.removeFeatureState({ source: FEATURES_OVERLAY_ID, id }, 'dragging');
        }
    }
}

/** features-selected layer filter for a selection set. */
function selectionFilter(ids: ReadonlySet<string>): FilterSpecification {
    return ['in', ['get', 'id'], ['literal', [...ids]]] as unknown as FilterSpecification;
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
