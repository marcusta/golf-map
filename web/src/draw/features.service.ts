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
import {
    DRAW_FILL_OPACITY, NICE_FILL_OPACITY, typeColorExpression, featureFillColorExpression, SELECTION_COLOR,
    OUTLINE_ONLY_TYPES, OUTLINE_ONLY_LINE_WIDTH, OUTLINE_ONLY_CASING_WIDTH, OUTLINE_ONLY_CASING_COLOR, RULES_TYPES,
} from './feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { ZoneTypesService, zoneTypeKeyOf, zoneVariantKeyOf } from '../zones/zone-types.service';
import { createWorkerSurfaceStackClient, type SurfaceStackClient } from './surface-stack-client';
import { ROUGHS_LAYER, stackKey, type FeatureLayer } from '../../../shared/render/stack-key';
import { pathSurfaceOf } from '../../../shared/features/path-surface';
import { ROAD_JUNCTIONS_SOURCE, junctionFillets, kerbFilletsOn } from '../../../shared/features/road-junctions';
import { isGeneratedFeature } from './generated-features';

/**
 * One stack group (D23/D28): a hole, the Roughs layer under every hole
 * (`layer: 'roughs'`, never with a hole), or course-level (both null).
 */
export interface StackScope {
    holeId: string | null;
    layer: FeatureLayer;
}

export const COURSE_SCOPE: StackScope = { holeId: null, layer: null };

export function scopeOf(f: { holeId: string | null; layer?: FeatureLayer }): StackScope {
    return { holeId: f.holeId, layer: f.layer ?? null };
}

export function sameScope(a: StackScope, b: StackScope): boolean {
    return a.holeId === b.holeId && a.layer === b.layer;
}

/** `<select>` value for the Roughs scope (hole ids are UUIDs, '' is course-level). */
const ROUGHS_SCOPE_KEY = '__roughs';

/** A scope as one string — a `<select>` value, or a Signal that compares by value. */
export function scopeKey(scope: StackScope): string {
    return scope.layer === ROUGHS_LAYER ? ROUGHS_SCOPE_KEY : scope.holeId ?? '';
}

export function scopeFromKey(key: string): StackScope {
    if (key === ROUGHS_SCOPE_KEY) return { holeId: null, layer: ROUGHS_LAYER };
    return { holeId: key || null, layer: null };
}

/**
 * Fill a scope `<select>` in stack order, top to bottom: course-level, the
 * holes, then the Roughs layer. `roughsDisabled` greys Roughs out where it
 * isn't a legal target (a selection holding non-rough types).
 */
export function fillScopeOptions(
    select: HTMLSelectElement,
    holes: readonly { id: string; number: number; par: number }[],
    opts: { roughsDisabled?: boolean } = {},
): void {
    const add = (value: string, text: string, disabled = false) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.disabled = disabled;
        select.appendChild(option);
    };
    add(scopeKey(COURSE_SCOPE), 'Course level (top)');
    for (const hole of holes) add(hole.id, `Hole ${hole.number} (par ${hole.par})`);
    add(ROUGHS_SCOPE_KEY, 'Roughs (bottom)', opts.roughsDisabled ?? false);
}

/**
 * Feature attributes as the API takes them on create/update: a flat object of
 * scalars. The generated client types the READ side (`CourseFeature`) as an
 * opaque interface — the codegen cannot express an index signature — so this
 * is the one place that bridges the two.
 */
export type FeatureAttributesPatch = Record<string, number | string | boolean>;

/** A feature's stored attributes as a writable patch (null when it has none). */
export function attributesPatchOf(attributes: unknown): FeatureAttributesPatch | null {
    return (attributes ?? null) as FeatureAttributesPatch | null;
}

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

/** Draw mode: quiet time after the last edit before the nice-mode surfaces are resolved in the background. */
const RESOLVE_IDLE_MS = 1500;

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
     * Feature TYPES the active editor mode keeps off the map and out of hit
     * tests, apart from the user's own `hiddenTypes` (Draw hides the rules
     * lines, which Furniture owns). Set by the tool for its active span.
     */
    readonly modeHiddenTypes = new Signal<ReadonlySet<string>>(new Set());
    /**
     * The Roughs layer (`layer: 'roughs'`) toggled off in the editor (stack
     * panel toggle). Editor-only view state: it takes effect only while the
     * editor's overlay is attached (`attachOverlay(map, { editor: true })`),
     * so the planner still draws the roughs, and it is never persisted (the
     * GSPro SVG export reads the stored features server-side).
     */
    readonly roughsLayerHidden = new Signal(false);
    /**
     * Features the GSPro export panel leaves out of its SVG test variant,
     * marked on the map (red dashed outline over a faint red wash) while the
     * panel is open. View state only; the panel sets and clears it.
     */
    readonly exportExcludedIds = new Signal<ReadonlySet<string>>(new Set());
    /** True while the editor (not the planner) owns the features overlay. */
    private readonly editorOverlay = new Signal(false);
    /** `roughsLayerHidden`, in effect: what the overlay and hit tests skip. */
    readonly roughsLayerOff = new Computed(() => this.roughsLayerHidden.get() && this.editorOverlay.get());
    /** `hiddenTypes` ∪ `modeHiddenTypes`: what the overlay and hit tests skip. */
    readonly effectiveHiddenTypes = new Computed<ReadonlySet<string>>(() => {
        const user = this.hiddenTypes.get();
        const mode = this.modeHiddenTypes.get();
        return mode.size === 0 ? user : user.size === 0 ? mode : new Set([...user, ...mode]);
    });
    /**
     * Nice mode is a photo-blended, stroke-free vector tint. Draw mode uses
     * a high-contrast palette with visible feature boundaries.
     */
    readonly niceRendering = new Signal(true);
    /**
     * Keep the penalty-area boundaries stroked in nice mode (Furniture, where
     * they are drawn and edited); nice mode otherwise hides every stroke but OOB.
     */
    readonly rulesOutlines = new Signal(false);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove is in flight (autosave indicator). */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    /** Hole numbers for the D24 `stackKey` groupRank — set before `geojson`/`stackTopDown` (both Computed eagerly on construction). */
    private courseDetail = di.get(CourseDetailService);
    /** The course's zone-type legend: colours for the zone fills, defaults for a new zone. */
    private zoneTypes = di.get(ZoneTypesService);

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
     * Generated (pipeline bulk-replace) features, identity-stable: the same array
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
    private junctionMemo: { roads: CourseFeature[]; features: Feature[] } | null = null;

    /**
     * Kerb fillets where the centerline roads meet
     * (shared/features/road-junctions.ts), derived HERE so they follow every
     * edit at once; the server's stored copies (ROAD_JUNCTIONS_SOURCE, for the
     * export and iOS) never enter the store. Each renders as a `path` with its
     * roads' surface, stacked with the highest of them; not selectable (hit
     * tests walk the store). Memoized on the roads' geometry identities, so an
     * edit that touches no road reuses the last result.
     */
    private readonly junctionFeatures = new Computed<Feature[]>(() => {
        const hiddenIds = this.hiddenIds.get();
        const roads = this.store.items.get()
            .filter(f => f.type === 'path' && f.geometry.centerline && !isGeneratedFeature(f) && !hiddenIds.has(f.id));
        const memo = this.junctionMemo;
        if (memo && memo.roads.length === roads.length && memo.roads.every((f, i) => f.id === roads[i].id && f.geometry === roads[i].geometry && f.attributes === roads[i].attributes)) {
            return memo.features;
        }
        const byId = new Map(roads.map(f => [f.id, f]));
        const features: Feature[] = junctionFillets(roads.map(f => ({ id: f.id, centerline: f.geometry.centerline!, fillets: kerbFilletsOn(f.attributes) })))
            .map((fillet, i) => {
                const members = fillet.roadIds.map(id => byId.get(id)!);
                const surfaces = new Set(members.map(f => pathSurfaceOf(f.attributes)));
                const surface = surfaces.size === 1 ? [...surfaces][0] : null;
                const id = `junction:${i}`;
                return {
                    type: 'Feature',
                    id,
                    properties: {
                        id,
                        type: 'path',
                        holeId: null,
                        layer: null,
                        sortOrder: 0,
                        stackKey: Math.max(...members.map(f => this.stackKeyFor(f))),
                        source: ROAD_JUNCTIONS_SOURCE,
                        ...(surface ? { surface } : {}),
                    },
                    geometry: { type: 'Polygon', coordinates: geometryToWgs84Rings({ crs: 'EPSG:3006', rings: fillet.rings }) } satisfies Polygon,
                };
            });
        this.junctionMemo = { roads, features };
        return features;
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
        const hidden = this.effectiveHiddenTypes.get();
        const hiddenIds = this.hiddenIds.get();
        const roughsOff = this.roughsLayerOff.get();
        const features: Feature[] = this.store.items.get()
            .filter(f => !isGeneratedFeature(f) && !hidden.has(f.type) && !hiddenIds.has(f.id)
                && !(roughsOff && f.layer === ROUGHS_LAYER))
            .map(f => this.toGeojsonFeature(f));
        if (!hidden.has('path')) features.push(...this.junctionFeatures.get());
        return { type: 'FeatureCollection', features };
    });

    /**
     * GENERATED features as their own WGS84 FeatureCollection (see
     * `GENERATED_OVERLAY_ID`). Memoized on the identity-stable
     * `generatedFeatures` array + the visibility sets, so a hand-drawn edit
     * returns the SAME collection object and `attachOverlay` skips the
     * source re-send entirely.
     */
    readonly generatedGeojson = new Computed<FeatureCollection>(() => {
        const items = this.generatedFeatures.get();
        const hidden = this.effectiveHiddenTypes.get();
        const hiddenIds = this.hiddenIds.get();
        const hiddenSources = this.hiddenSources.get();
        const roughsOff = this.roughsLayerOff.get();
        const memo = this.generatedGeojsonMemo;
        if (memo && memo.items === items && memo.hidden === hidden && memo.hiddenIds === hiddenIds
            && memo.hiddenSources === hiddenSources && memo.roughsOff === roughsOff) {
            return memo.data;
        }
        const features: Feature[] = items
            .filter(f => !hidden.has(f.type) && !hiddenIds.has(f.id) && !hiddenSources.has(f.source!)
                && !(roughsOff && f.layer === ROUGHS_LAYER))
            .map(f => this.toGeojsonFeature(f));
        const data: FeatureCollection = { type: 'FeatureCollection', features };
        this.generatedRebuildCount++;
        this.generatedGeojsonMemo = { items, hidden, hiddenIds, hiddenSources, roughsOff, data };
        return data;
    });
    private generatedGeojsonMemo: {
        items: CourseFeature[];
        hidden: ReadonlySet<string>;
        hiddenIds: ReadonlySet<string>;
        hiddenSources: ReadonlySet<string>;
        roughsOff: boolean;
        data: FeatureCollection;
    } | null = null;

    /** Number of times `generatedGeojson` actually rebuilt (perf tests / diagnostics). */
    get generatedRebuilds(): number {
        return this.generatedRebuildCount;
    }
    private generatedRebuildCount = 0;

    private toGeojsonFeature(f: CourseFeature): Feature {
        // A vegetation zone carries its zone-type key (so the map can style,
        // filter and label by zone), its variant key when it has one, and,
        // when the course's table knows the type, the type's own colour for
        // the fill expression (variants share their type's colour).
        const zoneType = f.type === 'vegetation_zone' ? zoneTypeKeyOf(f.attributes) : '';
        const zoneVariant = zoneType ? zoneVariantKeyOf(f.attributes) : '';
        const zoneColor = zoneType ? this.zoneTypes.colorFor(zoneType) : '';
        // A path carries its surface for the fill colour (featureFillColorExpression).
        const surface = f.type === 'path' ? pathSurfaceOf(f.attributes) : null;
        return {
            type: 'Feature',
            id: f.id,
            properties: {
                id: f.id,
                type: f.type,
                holeId: f.holeId,
                layer: f.layer ?? null,
                sortOrder: f.sortOrder,
                stackKey: this.stackKeyFor(f),
                source: f.source,
                ...(zoneType ? { zoneType } : {}),
                ...(zoneVariant ? { zoneVariant } : {}),
                ...(zoneColor ? { zoneColor } : {}),
                ...(surface ? { surface } : {}),
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

    constructor(
        private featuresApi: CourseFeaturesApi = api.courseFeatures,
        private surfaceStack: SurfaceStackClient = createWorkerSurfaceStackClient(),
    ) {}

    /**
     * Nice mode's occlusion-resolved surfaces (`resolveSurfaceStack`) and the
     * `geojson` collection they were resolved from. Resolved in a worker —
     * seconds of clipping for a full course — so nice mode shows the plain
     * collection until the result for the CURRENT one arrives.
     */
    private readonly resolvedStack = new Signal<{ source: FeatureCollection; result: FeatureCollection } | null>(null);
    /** The newest collection waiting for resolution, and whether one is in the worker. */
    private resolveWanted: FeatureCollection | null = null;
    private resolveInflight = false;
    private resolveTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Ask for `source`'s resolved stack: at once in nice mode, after
     * `RESOLVE_IDLE_MS` without edits in draw mode (so the switch back to
     * nice mode finds it ready without re-clipping on every vertex drag).
     */
    private scheduleResolve(source: FeatureCollection, nice: boolean): void {
        if (this.resolvedStack.peek()?.source === source) return;
        if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
        this.resolveTimer = null;
        this.resolveWanted = source;
        if (nice) this.pumpResolve();
        else this.resolveTimer = setTimeout(() => { this.resolveTimer = null; this.pumpResolve(); }, RESOLVE_IDLE_MS);
    }

    /** One resolve at a time; whatever was asked for meanwhile goes next (only the newest). */
    private pumpResolve(): void {
        const source = this.resolveWanted;
        if (this.resolveInflight || !source) return;
        this.resolveInflight = true;
        this.resolveWanted = null;
        this.surfaceStack.resolve(source)
            .then(
                result => { if (this.geojson.peek() === source) this.resolvedStack.set({ source, result }); },
                () => { /* nice mode keeps the unresolved collection */ },
            )
            .finally(() => {
                this.resolveInflight = false;
                this.pumpResolve();
            });
    }

    /**
     * D28 stack key for one feature — the shared formula the server's
     * `geojsonByCourse` uses, so live-edit GeoJSON and server-materialized
     * GeoJSON agree.
     */
    private stackKeyFor(f: CourseFeature): number {
        const holeNumber = f.holeId === null
            ? null
            : this.courseDetail.holes.get().find(h => h.id === f.holeId)?.number ?? 0;
        return stackKey(f.layer, holeNumber, f.sortOrder, f.type);
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
     * A group's features ordered bottom-to-top by `sortOrder` (D23). Not
     * memoized — cheap filter+sort over one group, called on demand (panel
     * row lists, reorder ops).
     */
    stackFor(scope: StackScope): CourseFeature[] {
        return this.store.items.get()
            .filter(f => sameScope(scopeOf(f), scope))
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    /** Load all features for a course. Cached per courseId. */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        this.selectedIds.set(new Set());
        const items = await request(this.loading, this.error, () =>
            this.featuresApi.listByCourse({ courseId }));
        if (!items) return; // failed — error signal set, cache untouched
        // Stored junction fillets are the server's copy for export; the map
        // draws its own live ones (`junctionFeatures`).
        this.store.set(items.filter(f => f.source !== ROAD_JUNCTIONS_SOURCE));
        this.loadedCourseId = courseId;
        this.hideNewZoneSources(items);
    }

    /**
     * Generated vegetation zones (tall-grass, lidar-woodland, lidar-lowveg)
     * are Unity planting input, not something to draw or place furniture
     * over, and a course's tall grass alone outweighs every drawn surface.
     * Each such source starts hidden the first time it shows up; the stack
     * panel's group eye shows it, and a reload keeps that choice.
     */
    private hideNewZoneSources(items: readonly CourseFeature[]): void {
        const fresh = new Set<string>();
        for (const f of items) {
            if (f.type === 'vegetation_zone' && isGeneratedFeature(f) && f.source && !this.seenZoneSources.has(f.source)) {
                fresh.add(f.source);
            }
        }
        if (fresh.size === 0) return;
        for (const source of fresh) this.seenZoneSources.add(source);
        this.hiddenSources.set(new Set([...this.hiddenSources.peek(), ...fresh]));
    }
    private readonly seenZoneSources = new Set<string>();

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
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

    /**
     * Toggle the Roughs layer's editor visibility (stack panel toggle).
     * Hiding drops the layer's features from the selection, like the
     * type/id/source toggles.
     */
    toggleRoughsLayerVisibility(): void {
        const hide = !this.roughsLayerHidden.peek();
        if (hide) {
            const keep = new Set([...this.selectedIds.peek()].filter(id => {
                const f = this.store.items.peek().find(item => item.id === id);
                return f !== undefined && f.layer !== ROUGHS_LAYER;
            }));
            if (keep.size !== this.selectedIds.peek().size) this.selectedIds.set(keep);
        }
        this.roughsLayerHidden.set(hide);
    }

    /** True when `f` is hidden by any of the view toggles (type, id, source, Roughs layer) or the active mode. */
    isHidden(f: CourseFeature): boolean {
        return this.effectiveHiddenTypes.peek().has(f.type)
            || (f.layer === ROUGHS_LAYER && this.roughsLayerOff.peek())
            || this.hiddenIds.peek().has(f.id)
            || (f.source !== null && this.hiddenSources.peek().has(f.source));
    }

    /**
     * Create a feature (autosave on ring close). Selects it on success.
     *
     * A `vegetation_zone` always reaches the server with its zone
     * attributes: a caller that has them (duplicate, stamp) passes them
     * through, and one that doesn't (a freshly drawn ring) gets the course
     * zone-type table's defaults filled in here — the server rejects a zone
     * with no `zoneType`, and this is the one funnel every create goes down.
     */
    async create(input: {
        type: string;
        holeId?: string | null;
        layer?: FeatureLayer;
        geometry: FeatureGeometry;
        attributes?: FeatureAttributesPatch | null;
    }): Promise<CourseFeature | undefined> {
        const courseId = this.loadedCourseId;
        if (!courseId) return undefined;
        const attributes = input.type === 'vegetation_zone' && !zoneTypeKeyOf(input.attributes)
            ? { ...this.zoneTypes.defaultAttributes(), ...(input.attributes ?? {}) }
            : input.attributes;
        const created = await request(this.saving, this.saveError, () =>
            this.featuresApi.create({ courseId, ...input, attributes }));
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
     * Persist a partial update (geometry / type / holeId / layer / attributes) with
     * optimistic locking. On version conflict or other failure, `saveError`
     * is set and the store re-syncs from the server (dropping local patches).
     * `attributes` replaces the whole object (that is the server's contract),
     * so the zone section in the selection panel sends all four keys.
     */
    async update(
        id: string,
        patch: {
            geometry?: FeatureGeometry;
            type?: string;
            holeId?: string | null;
            layer?: FeatureLayer;
            attributes?: FeatureAttributesPatch | null;
        },
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
     * share one scope — mixed-group calls are a no-op, since D23's stack
     * is scoped per group), compute the new order, patch `sortOrder`
     * optimistically, then persist via the reorder endpoint. Reverts (via
     * `reload()`) on failure, matching `update`'s error handling.
     */
    private async reorderOp(ids: string[], compute: (order: string[]) => string[]): Promise<boolean> {
        const courseId = this.loadedCourseId;
        if (!courseId || ids.length === 0) return false;
        const rows = ids.map(id => this.store.items.peek().find(f => f.id === id));
        const first = rows[0];
        if (!first || rows.some(r => !r || !sameScope(scopeOf(r), scopeOf(first)))) return false;
        if (rows.some(r => r && isGeneratedFeature(r))) return false; // generated rows are read-only
        const scope = scopeOf(first);
        const order = this.stackFor(scope).map(f => f.id);
        const nextOrder = compute(order);
        if (nextOrder.length === order.length && nextOrder.every((id, i) => id === order[i])) return true; // no-op (already at the edge)

        // Optimistic local patch — mirrors furniture.service.ts's applySortOrder.
        nextOrder.forEach((id, index) => {
            const row = this.store.items.peek().find(f => f.id === id);
            if (row) this.store.patch({ ...row, sortOrder: index });
        });
        const result = await request(this.saving, this.saveError, () =>
            this.featuresApi.reorder({ courseId, ...scope, orderedIds: nextOrder }));
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
     *
     * `editor` marks the editor's attach: only then does the editor's view
     * state (`roughsLayerHidden`) apply, so the planner shows every layer.
     */
    attachOverlay(map: MapService, opts: { editor?: boolean } = {}): () => void {
        let added = false;
        this.editorOverlay.set(opts.editor ?? false);
        let lastGeneratedSent: FeatureCollection | null = null;
        let lastDataSent: FeatureCollection | null = null;
        this.overlayMap = map;
        // Per-feature "dragging" state hides originals while the draw
        // tool renders their ghost (paint-only — no source/layout work).
        const draggingHide = (visible: number): unknown =>
            ['case', ['boolean', ['feature-state', 'dragging'], false], 0, visible];
        const disposeData = effect(() => {
            const ready = map.ready.get();
            const nice = this.niceRendering.get();
            const rawData = this.geojson.get();
            const resolved = this.resolvedStack.get();
            const data = nice && resolved?.source === rawData ? resolved.result : rawData;
            // Generated trees overlay the surface stack (no occlusion
            // resolution needed — they are never differenced against it).
            const generated = this.generatedGeojson.get();
            if (!ready) {
                added = false; // overlay died with the map
                lastGeneratedSent = null;
                lastDataSent = null;
                return;
            }
            this.scheduleResolve(rawData, nice);
            if (!added) {
                // Set the correct paint at layer creation too. On a cold map
                // load, the tint effect can observe `ready` before this
                // effect finishes adding layers; `added` is deliberately not
                // reactive, so that missed pass cannot be our only initial
                // configuration path.
                const fillOpacity = draggingHide(nice ? NICE_FILL_OPACITY : DRAW_FILL_OPACITY);
                const boundaryOpacity = draggingHide(nice ? 0 : 1);
                map.addOverlayLayer(FEATURES_OVERLAY_ID, data, [
                    {
                        id: 'features-fill',
                        type: 'fill',
                        // OOB is drawn as a ring around the whole property but
                        // painted as a boundary line only, so it never reaches
                        // this layer (see `features-oob-line` below).
                        filter: filledFilter(),
                        // D23/D24: explicit per-feature stack order, not the
                        // TYPE_Z_ORDER heuristic — sort keys make later-in-
                        // stack features render on top within this one layer.
                        layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'fill-color': featureFillColorExpression('draw') as never,
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
                        // OOB is excluded: it has no fill to outline, so its
                        // boundary is the feature itself and gets its own
                        // always-on pair of layers below.
                        id: 'features-rules-outline',
                        type: 'line',
                        filter: penaltyOutlineFilter(),
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': boundaryOpacity as never,
                        },
                    },
                    {
                        // Dark casing under the white OOB line — the bone
                        // white alone disappears over sand, cart paths and
                        // bright roofs.
                        id: 'features-oob-casing',
                        type: 'line',
                        filter: outlineOnlyFilter(),
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': OUTLINE_ONLY_CASING_COLOR,
                            'line-width': OUTLINE_ONLY_CASING_WIDTH,
                            'line-opacity': draggingHide(0.55) as never,
                        },
                    },
                    {
                        // The OOB boundary itself. Unlike every other stroke
                        // it is NOT hidden in nice mode: with no fill behind
                        // it, hiding the line would delete OOB from the
                        // planning view entirely.
                        id: 'features-oob-line',
                        type: 'line',
                        filter: outlineOnlyFilter(),
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': OUTLINE_ONLY_LINE_WIDTH,
                            'line-opacity': draggingHide(1) as never,
                        },
                    },
                    ...exportExcludedLayers('features', this.exportExcludedIds.peek()),
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
                ], { waterSurface: true });
                // Generated features: own source, slotted just under the
                // hand-drawn selection highlight (above hand-drawn fills, so
                // canopy reads as the topmost surface, like drawn trees).
                map.addOverlayLayer(GENERATED_OVERLAY_ID, generated, [
                    {
                        id: 'features-generated-fill',
                        type: 'fill',
                        layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'fill-color': featureFillColorExpression('draw') as never,
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
                    ...exportExcludedLayers('features-generated', this.exportExcludedIds.peek()),
                    {
                        id: 'features-generated-selected',
                        type: 'line',
                        filter: selectionFilter(this.selectedIds.peek()),
                        paint: {
                            'line-color': SELECTION_COLOR,
                            'line-width': 2.5,
                        },
                    },
                ], { beforeId: 'features-selected' });
                lastGeneratedSent = generated;
                lastDataSent = data;
                added = true;
            } else {
                // Identity check: a resolve landing while draw mode shows
                // the plain collection changes nothing on the map.
                if (data !== lastDataSent) {
                    lastDataSent = data;
                    map.updateOverlayData(FEATURES_OVERLAY_ID, data);
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
            const raw = map.map.get();
            raw?.setFilter('features-selected', selectionFilter(ids));
            raw?.setFilter('features-generated-selected', selectionFilter(ids));
        });
        const disposeExcluded = effect(() => {
            const ids = this.exportExcludedIds.get();
            if (!map.ready.get() || !added) return;
            const raw = map.map.get();
            for (const prefix of ['features', 'features-generated']) {
                raw?.setFilter(`${prefix}-export-excluded-fill`, selectionFilter(ids));
                raw?.setFilter(`${prefix}-export-excluded`, selectionFilter(ids));
            }
        });
        const disposeTint = effect(() => {
            // Nice mode uses the proven MapLibre fill path as a baseline:
            // same data and D24 sort order as Draw, photo-blended opacity,
            // and no strokes.
            // Penalty boundaries keep their stroke while Furniture edits them.
            const ready = map.ready.get();
            const nice = this.niceRendering.get();
            const rulesOutlines = this.rulesOutlines.get();
            if (!ready || !added) return;
            const rawMap = map.map.get();
            if (!rawMap) return;

            if (nice) {
                rawMap.setPaintProperty('features-fill', 'fill-opacity', draggingHide(NICE_FILL_OPACITY) as never);
                rawMap.setPaintProperty('features-outline', 'line-opacity', draggingHide(0) as never);
                rawMap.setPaintProperty('features-rules-outline', 'line-opacity', draggingHide(rulesOutlines ? 1 : 0) as never);
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
            disposeExcluded();
            disposeTint();
            if (opts.editor) this.editorOverlay.set(false);
            if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
            this.resolveTimer = null;
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

/** features-selected layer filter for a selection set. */
function selectionFilter(ids: ReadonlySet<string>): FilterSpecification {
    return ['in', ['get', 'id'], ['literal', [...ids]]] as unknown as FilterSpecification;
}

/** Red of the SVG-export exclusion marks: reads as "left out" over turf, sand and water alike. */
const EXPORT_EXCLUDED_COLOR = '#e03131';

/** The wash + dashed outline marking features left out of the GSPro SVG test variant. */
function exportExcludedLayers(prefix: string, ids: ReadonlySet<string>) {
    return [
        {
            id: `${prefix}-export-excluded-fill`,
            type: 'fill' as const,
            filter: selectionFilter(ids),
            paint: { 'fill-color': EXPORT_EXCLUDED_COLOR, 'fill-opacity': 0.25 },
        },
        {
            id: `${prefix}-export-excluded`,
            type: 'line' as const,
            filter: selectionFilter(ids),
            paint: { 'line-color': EXPORT_EXCLUDED_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
    ];
}

/** Rules overlays: not playing surfaces, so not part of the material tint. */
const RULES_OUTLINE_TYPES: readonly string[] = RULES_TYPES;

/**
 * The rules types that still outline a fill — everything in
 * RULES_OUTLINE_TYPES except OOB, which IS its own boundary and gets the
 * always-on `features-oob-*` pair instead.
 */
const PENALTY_OUTLINE_TYPES = RULES_OUTLINE_TYPES.filter(type => !OUTLINE_ONLY_TYPES.has(type as never));

const typeIn = (types: readonly string[]): FilterSpecification =>
    ['in', ['get', 'type'], ['literal', types]] as unknown as FilterSpecification;

function surfaceOutlineFilter(): FilterSpecification {
    return ['!', typeIn(RULES_OUTLINE_TYPES)] as unknown as FilterSpecification;
}

/** The penalty-area boundaries (rules outlines that still sit on a fill). */
function penaltyOutlineFilter(): FilterSpecification {
    return typeIn(PENALTY_OUTLINE_TYPES);
}

/** Ring-authored, boundary-painted types (`oob`) — see OUTLINE_ONLY_TYPES. */
function outlineOnlyFilter(): FilterSpecification {
    return typeIn([...OUTLINE_ONLY_TYPES]);
}

/** Everything the fill layer still paints: not an outline-only type. */
function filledFilter(): FilterSpecification {
    return ['!', outlineOnlyFilter()] as unknown as FilterSpecification;
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
