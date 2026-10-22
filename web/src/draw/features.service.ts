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
import {
    DRAW_FILL_OPACITY, NICE_FILL_OPACITY, FEATURE_TYPES, typeColorExpression, featureFillColorExpression, SELECTION_COLOR,
    OUTLINE_ONLY_TYPES, OUTLINE_ONLY_LINE_WIDTH, OUTLINE_ONLY_CASING_WIDTH, OUTLINE_ONLY_CASING_COLOR, RULES_TYPES, VEGETATION_TYPES, isVegetationType, isRulesType,
} from './feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { ZoneTypesService, zoneTypeKeyOf, zoneVariantKeyOf } from '../zones/zone-types.service';
import { createWorkerSurfaceStackClient, type SurfaceStackClient } from './surface-stack-client';
import { ROUGHS_LAYER, stackKey, drawScopeRanks, type DrawScopeOrder, type FeatureLayer } from '../../../shared/render/stack-key';
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
export const ROUGHS_SCOPE_KEY = '__roughs';

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
    holes: readonly (DrawScopeOrder & { par: number })[],
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
    const ranks = drawScopeRanks(holes);
    for (const hole of [...holes].sort((a, b) => ranks.get(b.id)! - ranks.get(a.id)!)) add(hole.id, hole.drawingGroupName ? `${hole.drawingGroupName} (SVG only)` : `Hole ${hole.number} (par ${hole.par})`);
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
     * Feature TYPES hidden from the overlay + hit tests (type eye toggles,
     * Shift+digit, solo). Client-side view state, persisted per course in
     * localStorage (`hiddenTypesKey`) and restored by `load()`. Change it
     * through the methods below so the stored copy stays in step.
     */
    readonly hiddenTypes = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Individual feature IDS hidden from the overlay + hit tests (stack
     * panel eye toggles, Inkscape/Photoshop-style; `hideSelected`).
     * Client-side view state, never persisted.
     */
    readonly hiddenIds = new Signal<ReadonlySet<string>>(new Set());
    /** Hole/drawing-group eyes: editor-only, session view state. */
    readonly hiddenHoleIds = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Generated-feature SOURCES hidden from the overlay + hit tests (stack
     * panel group-row eye, e.g. 'lidar-canopy'). Client-side view state.
     */
    readonly hiddenSources = new Signal<ReadonlySet<string>>(new Set());
    /**
     * Feature TYPES the active editor mode keeps off the map and out of hit
     * tests, apart from the user's own `hiddenTypes` (Draw hides the rules
     * lines, which Furniture owns). Set by the tool for its active span;
     * outside it (`resetModeView`) the vegetation zones are hidden, since
     * only Vegetation mode shows them.
     */
    readonly modeHiddenTypes = new Signal<ReadonlySet<string>>(new Set(VEGETATION_TYPES));
    /**
     * Feature TYPES the active editor mode shows only as a backdrop: outline,
     * no fill, read-only, out of hit tests and the stack panel. Vegetation
     * mode puts every course feature here so the zones stand out while the
     * fairway and green edges stay readable; of those it still selects the
     * creeks and water, for their bank vegetation (`scopeSelectsType`). Set
     * by the tool for its active span.
     */
    readonly modeBackdropTypes = new Signal<ReadonlySet<string>>(new Set());
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
    private hiddenIdsMemo: ReadonlySet<string> = new Set();
    /** Individual eyes plus every member of a hidden hole, including newly loaded/created shapes. */
    readonly effectiveHiddenIds = new Computed<ReadonlySet<string>>(() => {
        const individual = this.hiddenIds.get();
        const holes = this.hiddenHoleIds.get();
        if (!this.editorOverlay.get() || holes.size === 0) return individual;
        const next = new Set([...individual, ...this.store.items.get()
            .filter(f => f.holeId !== null && holes.has(f.holeId)).map(f => f.id)]);
        if (!sameSet(this.hiddenIdsMemo, next)) this.hiddenIdsMemo = next;
        return this.hiddenIdsMemo;
    });
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

    /** The view every tool's span ends on: nice rendering, zones hidden, no backdrop. */
    resetModeView(): void {
        this.niceRendering.set(true);
        this.modeHiddenTypes.set(new Set(VEGETATION_TYPES));
        this.modeBackdropTypes.set(new Set());
        this.rulesOutlines.set(false);
    }
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove is in flight (autosave indicator). */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);
    /**
     * Saves not yet landed: per-feature patches waiting out the geometry
     * debounce or queued behind an in-flight request, single updates in
     * flight, and create / updateMany / removeMany / reorder requests in
     * flight. Zero means everything the user did has reached the server
     * (or failed, see `saveError`). Unlike `saving`, it counts the debounce
     * window and overlapping requests.
     */
    readonly pendingSaves = new Signal(0);

    /** Hole numbers for the D24 `stackKey` groupRank — set before `geojson`/`stackTopDown` (both Computed eagerly on construction). */
    private courseDetail = di.get(CourseDetailService);
    /** The course's zone-type legend: colours for the zone fills, defaults for a new zone. */
    private zoneTypes = di.get(ZoneTypesService);

    private loadedCourseId: string | null = null;
    /** The course whose features the store holds (create/createMany write to it), null before a load. */
    get loadedCourse(): string | null {
        return this.loadedCourseId;
    }
    // Memo fields of the identity-stable Computeds below. Declared first:
    // a Computed runs in its field initializer.
    private lastFeatureIds: string[] | null = null;
    private lastSelectedFeatures: CourseFeature[] = [];

    /**
     * Ids of the stored features in store order. Identity-stable: the same
     * array comes back while membership and order are unchanged, so a
     * geometry or type edit does not re-run anything that only cares which
     * rows exist. Per-row data is read through `store.item(id)`.
     */
    readonly featureIds = new Computed<readonly string[]>(() => {
        const items = this.store.items.get();
        const prev = this.lastFeatureIds;
        if (prev && prev.length === items.length && items.every((f, i) => f.id === prev[i])) return prev;
        this.lastFeatureIds = items.map(f => f.id);
        return this.lastFeatureIds;
    });
    /** `featureIds` as a set (membership tests before `store.item`, which throws on a miss). */
    readonly featureIdSet = new Computed<ReadonlySet<string>>(() => new Set(this.featureIds.get()));

    /**
     * The selected feature when EXACTLY ONE is selected, else null.
     * Single-feature affordances (vertex editing, panel detail) key off
     * this; multi-select consumers use `selectedFeatures`.
     */
    readonly selected = new Computed<CourseFeature | null>(() => {
        const ids = this.selectedIds.get();
        if (ids.size !== 1) return null;
        const [id] = ids;
        return this.featureIdSet.get().has(id!) ? this.store.item(id!).get() : null;
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

    /**
     * All currently selected features (store order). Reads only the
     * selected rows' entity signals, so an edit to an unselected feature
     * does not re-run it. Identity-stable: the same array comes back while
     * the selected rows are unchanged.
     */
    readonly selectedFeatures = new Computed<CourseFeature[]>(() => {
        const ids = this.selectedIds.get();
        const prev = this.lastSelectedFeatures;
        if (ids.size === 0) return prev.length === 0 ? prev : (this.lastSelectedFeatures = []);
        const next: CourseFeature[] = [];
        for (const id of this.featureIds.get()) {
            if (ids.has(id)) next.push(this.store.item(id).get());
        }
        if (next.length === prev.length && next.every((f, i) => f === prev[i])) return prev;
        this.lastSelectedFeatures = next;
        return next;
    });

    /**
     * `selected` when it is hand-drawn, null when it is generated (read-only)
     * or a backdrop type of the active mode (Vegetation selects a creek only to
     * set its bank vegetation: its shape is Draw's): every geometry-editing
     * affordance (vertex handles, edge insertion, offset/simplify previews,
     * context-menu vertex delete) keys off THIS.
     */
    readonly editableSelected = new Computed<CourseFeature | null>(() => {
        const f = this.selected.get();
        return f && this.isEditableHere(f, this.modeBackdropTypes.get()) ? f : null;
    });

    /** `selectedFeatures` minus read-only rows (see `editableSelected`) — move/duplicate/retype/rehole/delete targets. */
    readonly editableSelectedFeatures = new Computed<CourseFeature[]>(() => {
        const backdrop = this.modeBackdropTypes.get();
        return this.selectedFeatures.get().filter(f => this.isEditableHere(f, backdrop));
    });

    private isEditableHere(f: CourseFeature, backdrop: ReadonlySet<string>): boolean {
        return !isGeneratedFeature(f) && !backdrop.has(f.type);
    }

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

    /** The sources of the course's generated vegetation (tall rough, creek banks, lidar woodland floor). */
    readonly generatedVegetationSources = new Computed<string[]>(() =>
        [...new Set(this.generatedFeatures.get().filter(f => isVegetationType(f.type)).map(f => f.source!))].sort());

    /** Vegetation mode's "Generated" toggle: false once every generated vegetation source is hidden. */
    readonly generatedVegetationShown = new Computed<boolean>(() => {
        const hidden = this.hiddenSources.get();
        const sources = this.generatedVegetationSources.get();
        return sources.length === 0 || sources.some(source => !hidden.has(source));
    });
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
        const hiddenIds = this.effectiveHiddenIds.get();
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
        const hidden = this.effectiveHiddenTypes.get();
        const hiddenIds = this.effectiveHiddenIds.get();
        const roughsOff = this.roughsLayerOff.get();
        const visible = this.store.items.get()
            .filter(f => !isGeneratedFeature(f) && !hidden.has(f.type) && !hiddenIds.has(f.id)
                && !(roughsOff && f.layer === ROUGHS_LAYER));
        // Kerb fillets ride along after the stored rows; a change to them
        // (a road edit) goes out as a full send, not a diff.
        const junctions = hidden.has('path') ? NO_FEATURES : this.junctionFeatures.get();
        const signature = visible.map(f => this.renderSignature(f));
        const memo = this.geojsonMemo;
        if (memo && memo.junctions === junctions && sameSignatures(memo.signature, signature)) return memo.data;
        const comparable = !!memo && memo.hidden === hidden && memo.hiddenIds === hiddenIds
            && memo.roughsOff === roughsOff && memo.junctions === junctions
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
        const data: FeatureCollection = { type: 'FeatureCollection', features: junctions.length > 0 ? [...features, ...junctions] : features };
        if (comparable) {
            const diff = overlayDiff(memo.featureById, featureById, signature);
            if (diff) this.geojsonDiffs.set(data, { from: memo.data, diff });
        }
        this.geojsonMemo = { signature, data, featureById, hidden, hiddenIds, roughsOff, junctions, loadGeneration: this.loadGeneration };
        return data;
    });
    private geojsonMemo: {
        signature: RenderSignature[];
        data: FeatureCollection;
        featureById: Map<string, { sig: RenderSignature; feature: Feature }>;
        hidden: ReadonlySet<string>;
        hiddenIds: ReadonlySet<string>;
        roughsOff: boolean;
        junctions: Feature[];
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
        const zoneColor = f.type === 'vegetation_zone' ? this.zoneTypes.colorFor(zoneTypeKeyOf(f.attributes)) : '';
        return [f.id, f.geometry, f.type, f.holeId, f.sortOrder, this.stackKeyFor(f), f.source, f.layer ?? null, f.attributes ?? null, zoneColor];
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
        const hidden = this.effectiveHiddenTypes.get();
        const hiddenIds = this.effectiveHiddenIds.get();
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
        const rank = f.holeId === null
            ? null
            : this.courseDetail.drawRanks.get().get(f.holeId) ?? 0;
        return stackKey(f.layer, rank, f.sortOrder, f.type, f.attributes);
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

    /**
     * Load all features for a course. Cached per courseId. Restores the
     * course's stored `hiddenTypes` in the same batch as the rows, so the
     * overlay builds once.
     */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        // Land queued saves for the previous course before its rows go.
        await this.flush();
        this.selectedIds.set(new Set());
        const items = await request(this.loading, this.error, () =>
            this.featuresApi.listByCourse({ courseId }));
        if (!items) return; // failed — error signal set, cache untouched
        this.loadGeneration++;
        this.loadedCourseId = courseId;
        this.soloMemory = null;
        batched(() => {
            this.hiddenTypes.set(readHiddenTypes(courseId));
            // Stored junction fillets are the server's copy for export; the map
            // draws its own live ones (`junctionFeatures`).
            this.store.set(items.filter(f => f.source !== ROAD_JUNCTIONS_SOURCE));
        });
    }

    /**
     * Re-fetch the loaded course and clear `saveError` once the re-fetch
     * worked (the save-pill Retry). Queued patches are dropped.
     */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        await this.resync();
        if (this.loadedCourseId === courseId && !this.error.peek()) this.saveError.set(null);
    }

    /**
     * Re-fetch the loaded course after a failed save. Leaves `saveError`
     * set: the failure stays visible until the user retries or dismisses it.
     */
    private async resync(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.dropQueues();
        this.loadedCourseId = null;
        await this.load(courseId);
    }

    /** Dismiss a save failure without re-fetching (save pill). */
    clearSaveError(): void {
        this.saveError.set(null);
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
        this.setSelection(id ? [id] : []);
    }

    /** Replace the whole selection (marquee result, duplicate clones). */
    setSelection(ids: Iterable<string>): void {
        this.selectedIds.set(new Set([...ids].filter(id => !this.isInHiddenHole(id))));
    }

    /** Toggle one feature's selection membership (Cmd/Ctrl+click). */
    toggleSelected(id: string): void {
        if (this.isInHiddenHole(id)) return;
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
        if (next.has(type)) next.delete(type);
        else next.add(type);
        this.setHiddenTypes(next);
    }

    /** Shift+digit: toggle the type bound to that digit. Same as `toggleTypeVisibility`. */
    toggleTypeHidden(type: string): void {
        this.toggleTypeVisibility(type);
    }

    /**
     * Alt-click on a type's eye: show only `type` and hide every other
     * type. The same call on the soloed type restores the hidden set from
     * before the solo (or shows all types when there is no such set, e.g.
     * after a page reload restored a solo state).
     */
    soloType(type: string): void {
        const current = this.hiddenTypes.peek();
        const others = new Set(this.knownTypes().filter(t => t !== type));
        if (sameSet(current, others)) {
            const memory = this.soloMemory;
            this.soloMemory = null;
            this.setHiddenTypes(memory && memory.type === type ? memory.previous : new Set());
            return;
        }
        this.soloMemory = { type, previous: current };
        this.setHiddenTypes(others);
    }

    /** H: hide the selected features (adds them to `hiddenIds`) and clear the selection. */
    hideSelected(): void {
        const ids = this.selectedIds.peek();
        if (ids.size === 0) return;
        batched(() => {
            this.hiddenIds.set(new Set([...this.hiddenIds.peek(), ...ids]));
            this.selectedIds.set(new Set());
        });
    }

    /** Shift+H: clear visibility toggles (types, single features, holes, generated sources). */
    showAll(): void {
        this.soloMemory = null;
        batched(() => {
            if (this.hiddenTypes.peek().size > 0) this.setHiddenTypes(new Set());
            if (this.hiddenIds.peek().size > 0) this.hiddenIds.set(new Set());
            if (this.hiddenHoleIds.peek().size > 0) this.hiddenHoleIds.set(new Set());
            if (this.hiddenSources.peek().size > 0) this.hiddenSources.set(new Set());
        });
    }

    /** Hidden set before the last `soloType`, for the second Alt-click. */
    private soloMemory: { type: string; previous: ReadonlySet<string> } | null = null;

    /** Palette types plus any other type present in the store. */
    private knownTypes(): string[] {
        const types = new Set<string>(FEATURE_TYPES);
        for (const f of this.store.items.peek()) types.add(f.type);
        return [...types];
    }

    /**
     * Replace `hiddenTypes`, drop newly hidden features from the selection
     * (invisible features must not remain silently editable) and store the
     * set for the loaded course.
     */
    private setHiddenTypes(next: ReadonlySet<string>): void {
        batched(() => {
            const selection = this.selectedIds.peek();
            if (selection.size > 0 && next.size > 0) {
                const ids = this.featureIdSet.peek();
                const keep = new Set([...selection].filter(id => ids.has(id) && !next.has(this.store.item(id).peek().type)));
                if (keep.size !== selection.size) this.selectedIds.set(keep);
            }
            this.hiddenTypes.set(next);
        });
        if (this.loadedCourseId) writeHiddenTypes(this.loadedCourseId, next);
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
     * Show or hide all the generated vegetation at once, leaving the zones
     * drawn by hand (Vegetation mode's "Generated" toggle). The same state as
     * the stack panel's group-row eyes, so either undoes the other.
     */
    setGeneratedVegetationShown(shown: boolean): void {
        const sources = this.generatedVegetationSources.peek();
        const hidden = this.hiddenSources.peek();
        batched(() => {
            for (const source of sources) {
                if (hidden.has(source) === shown) this.toggleSourceVisibility(source);
            }
        });
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

    /** Hide/show a hole without changing its shapes or their individual eye toggles. */
    toggleHoleVisibility(holeId: string): void {
        const next = new Set(this.hiddenHoleIds.peek());
        const hide = !next.has(holeId);
        if (hide) next.add(holeId);
        else next.delete(holeId);
        batched(() => {
            if (hide) {
                const members = new Set(this.store.items.peek().filter(f => f.holeId === holeId).map(f => f.id));
                this.selectedIds.set(new Set([...this.selectedIds.peek()].filter(id => !members.has(id))));
            }
            this.hiddenHoleIds.set(next);
        });
    }

    /** A hidden hole cannot be selected through stack rows, search or a new shape. */
    private isInHiddenHole(id: string): boolean {
        if (!this.editorOverlay.peek() || this.hiddenHoleIds.peek().size === 0 || !this.featureIdSet.peek().has(id)) return false;
        const holeId = this.store.item(id).peek().holeId;
        return holeId !== null && this.hiddenHoleIds.peek().has(holeId);
    }

    /** True when `f` is hidden by any view toggle or the active mode. */
    isHidden(f: CourseFeature): boolean {
        return this.effectiveHiddenTypes.peek().has(f.type)
            || (f.layer === ROUGHS_LAYER && this.roughsLayerOff.peek())
            || this.effectiveHiddenIds.peek().has(f.id)
            || (f.source !== null && this.hiddenSources.peek().has(f.source));
    }

    /**
     * Create a feature (autosave on ring close). Selects it on success
     * unless `select: false` (the caller sets the selection itself).
     *
     * A `vegetation_zone` always reaches the server with its zone
     * attributes: a caller that has them (duplicate, stamp) passes them
     * through, and one that doesn't (a freshly drawn ring) gets the course
     * zone-type table's defaults filled in here — the server rejects a zone
     * with no `zoneType`, and this is the one funnel every create goes down.
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
        const items = inputs.map(input => input.type === 'vegetation_zone' && !zoneTypeKeyOf(input.attributes)
            ? { ...input, attributes: { ...this.zoneTypes.defaultAttributes(), ...(input.attributes ?? {}) } }
            : input);
        const done = this.track(items.length === 1
            ? request(this.saving, this.saveError, () => this.featuresApi.create({ courseId, ...items[0]! }))
                .then(c => c && [c])
            : request(this.saving, this.saveError, () => this.featuresApi.createMany({ courseId, items })));
        const server = await done;
        if (!server) return undefined;
        // The server stores exactly the geometry it was sent: keep the local
        // object so the flatten cache and history snapshots share it. Not for
        // a centerline feature, whose rings the server derives from the line.
        const created = server.map((c, i) => {
            const sent = inputs[i]?.geometry;
            return { ...c, geometry: sent && !sent.centerline ? sent : c.geometry };
        });
        batched(() => {
            // Replay final insertion slots bottom first to mirror the server's
            // shifts, including shifts caused by normal type-based creates.
            for (const inserted of [...created].sort((a, b) => a.sortOrder - b.sortOrder)) {
                for (const row of this.stackFor(scopeOf(inserted))) {
                    if (row.sortOrder >= inserted.sortOrder) this.store.patch({ ...row, sortOrder: row.sortOrder + 1 });
                }
            }
            for (const c of created) this.store.add(c);
            if (opts.select !== false) this.selectedIds.set(new Set(created
                .filter(c => !this.editorOverlay.peek() || c.holeId === null || !this.hiddenHoleIds.peek().has(c.holeId))
                .map(c => c.id)));
        });
        return created;
    }

    /**
     * Local-only geometry patch for per-frame edit feedback (vertex drags).
     * No network; the version is unchanged so a later `update` still uses
     * the correct optimistic-locking version.
     */
    patchLocal(id: string, geometry: FeatureGeometry): void {
        if (!this.featureIdSet.peek().has(id)) return;
        const current = this.store.item(id).peek();
        this.store.patch({ ...current, geometry });
    }

    /**
     * Persist a partial update (geometry / type / holeId / layer / attributes) through the
     * feature's save queue (see `SaveQueue`): one request in flight per
     * feature, later patches coalesce into one pending patch that goes out
     * with the version the reply returned. Geometry-only patches wait
     * `geometryDebounceMs` for more; every other patch goes as soon as the
     * feature is idle. Callers `patchLocal` first for instant feedback.
     *
     * Resolves with the stored row once the request carrying this patch
     * lands. On version conflict or other failure, `saveError` is set, every
     * queued patch is dropped and the store re-syncs from the server.
     * `attributes` replaces the whole object (that is the server's contract),
     * so the zone section in the selection panel sends all four keys.
     */
    update(id: string, patch: FeaturePatch): Promise<CourseFeature | undefined> {
        if (!this.store.items.peek().some(f => f.id === id)) {
            this.saveError.set({ message: `Feature ${id} not found`, code: 'unknown' });
            void this.resync();
            return Promise.resolve(undefined);
        }
        const q = this.queueFor(id);
        return new Promise(resolve => {
            const pending = q.pending ??= { patch: {}, base: null!, waiters: [], timer: null, ready: false };
            Object.assign(pending.patch, definedFields(patch));
            pending.base = this.baseOf(id)!;
            pending.waiters.push(resolve);
            this.recountPending();
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
                    if (row) this.store.patch({ ...row, ...definedFields(patch) } as CourseFeature);
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
                    void this.resync();
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
                    void this.resync();
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

    /** Single `update` requests in flight (sent by `kick`). */
    private sendingUpdates = 0;

    private track<T>(work: Promise<T>): Promise<T> {
        this.inflight.add(work);
        this.recountPending();
        const done = () => {
            this.inflight.delete(work);
            this.recountPending();
        };
        work.then(done, done);
        return work;
    }

    /** Recompute `pendingSaves` from the queues and in-flight sets. */
    private recountPending(): void {
        let n = this.inflight.size + this.sendingUpdates;
        for (const q of this.queues.values()) if (q.pending) n++;
        this.pendingSaves.set(n);
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
        this.sendingUpdates++;
        this.recountPending();
        void this.sendUpdate(id, pending).finally(() => {
            this.sendingUpdates--;
            release();
            this.recountPending();
        });
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
            void this.resync();
            return;
        }
        const merged = this.mergeReply(server, pending.base, pending.patch);
        for (const w of pending.waiters) w(merged ?? server);
    }

    /** The row's patchable fields when a save is requested (see `mergeReply`). */
    private baseOf(id: string): PatchBase | null {
        const row = this.store.items.peek().find(f => f.id === id);
        return row ? { geometry: row.geometry, type: row.type, holeId: row.holeId, layer: row.layer, attributes: row.attributes } : null;
    }

    /**
     * Patch the store with a save reply. Not the raw server row: its geometry
     * is a freshly parsed object that would miss the flatten cache and
     * re-send the whole overlay. A field the store changed locally after the
     * save was requested (`base` → current) keeps the local value; otherwise
     * geometry takes the object the caller passed (or the current one) and
     * the other fields take the server's. Returns undefined when the row left the
     * store meanwhile (its version is kept for `removeMany`).
     */
    private mergeReply(server: CourseFeature, base: PatchBase, patch: FeaturePatch): CourseFeature | undefined {
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
            layer: current.layer !== base.layer ? current.layer : server.layer,
            // Unsent attributes cannot have changed server-side: keep the local
            // object, so a geometry save's reply does not re-send the feature.
            attributes: patch.attributes === undefined || current.attributes !== base.attributes ? current.attributes : server.attributes,
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
        this.recountPending();
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
        // Only the rows whose position changed, in one batch: a course-level
        // group holds over a thousand rows.
        const byId = new Map(this.store.items.peek().map(f => [f.id, f]));
        batched(() => {
            nextOrder.forEach((id, index) => {
                const row = byId.get(id);
                if (row && row.sortOrder !== index) this.store.patch({ ...row, sortOrder: index });
            });
        });
        const result = await this.track(request(this.saving, this.saveError, () =>
            this.featuresApi.reorder({ courseId, ...scope, orderedIds: nextOrder })));
        if (result === undefined) {
            await this.resync();
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
     * features. Nice mode also uses diffs for rules-only edits, reusing the
     * resolved surfaces. Other nice-mode edits, the first send, visibility
     * toggles and loads send the full collection with setData.
     *
     * `editor` marks the editor's attach: only then does the editor's view
     * state (`roughsLayerHidden`) apply, so the planner shows every layer.
     */
    attachOverlay(map: MapService, opts: { editor?: boolean } = {}): () => void {
        let added = false;
        this.editorOverlay.set(opts.editor ?? false);
        let lastGeneratedSent: FeatureCollection | null = null;
        // Last collection handed to the map. The effect re-runs on every
        // store change (selection-independent, but e.g. a generated-row
        // delete or a version bump) and when a background resolve lands;
        // `geojson` is identity-stable, so an unchanged collection means
        // nothing visible moved.
        let lastDataSent: FeatureCollection | null = null;
        let lastNiceStack: { source: FeatureCollection; result: FeatureCollection } | null = null;
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
        const draggingHide = (visible: unknown): unknown =>
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
            const resolved = this.resolvedStack.get();
            const previousNiceStack = lastNiceStack;
            const exactResolved = resolved?.source === rawData ? resolved : null;
            const reusedRules = nice && !exactResolved ? reuseRulesStack(lastNiceStack, rawData) : null;
            if (nice && (exactResolved || reusedRules)) lastNiceStack = exactResolved ?? reusedRules;
            const currentNiceStack = nice && lastNiceStack?.source === rawData ? lastNiceStack : null;
            const data = currentNiceStack ? currentNiceStack.result : rawData;
            // Generated trees overlay the surface stack (no occlusion
            // resolution needed — they are never differenced against it).
            const generated = this.generatedGeojson.get();
            if (!ready) {
                added = false; // overlay died with the map
                lastGeneratedSent = null;
                lastDataSent = null;
                return;
            }
            // Rules never clip the surfaces. Editing OOB in Furniture can
            // keep the resolved course and update just the changed line.
            if (!currentNiceStack) this.scheduleResolve(rawData, nice);
            if (!added) {
                // Set the correct paint at layer creation too. On a cold map
                // load, the tint effect can observe `ready` before this
                // effect finishes adding layers; `added` is deliberately not
                // reactive, so that missed pass cannot be our only initial
                // configuration path.
                const backdrop = this.modeBackdropTypes.peek();
                const ownFill = nice ? NICE_FILL_OPACITY : DRAW_FILL_OPACITY;
                const generatedFill = backdrop.size > 0 ? backdropCase(backdrop, 0, ownFill) : ownFill;
                const generatedBoundary = backdrop.size > 0 ? backdropCase(backdrop, BACKDROP_OUTLINE_OPACITY, nice ? 0 : 1) : nice ? 0 : 1;
                const fillOpacity = draggingHide(generatedFill);
                const boundaryOpacity = draggingHide(generatedBoundary);
                const rulesOpacity = draggingHide(nice ? 0 : 1);
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
                            'line-opacity': rulesOpacity as never,
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
                            'fill-color': featureFillColorExpression('draw') as never,
                            'fill-opacity': generatedFill as never,
                        },
                    },
                    {
                        id: 'features-generated-outline',
                        type: 'line',
                        layout: { 'line-sort-key': ['get', 'stackKey'] as never },
                        paint: {
                            'line-color': typeColorExpression('outline') as never,
                            'line-width': 1.5,
                            'line-opacity': generatedBoundary as never,
                        },
                    },
                    ...exportExcludedLayers('features-generated', this.exportExcludedIds.peek()),
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
                lastDataSent = data;
                added = true;
                // Fresh sources carry no feature-state: re-apply the selection.
                selectionState = new Set();
                applySelection(this.selectedIds.peek());
            } else {
                if (data !== lastDataSent) {
                    // Nice mode can use the raw diff only when it changed
                    // rules alone and the map holds the reused surface stack.
                    const step = this.geojsonDiffs.get(rawData);
                    const matchesBase = !nice ? step?.from === lastDataSent
                        : !!reusedRules && previousNiceStack?.result === lastDataSent
                            && step?.from === previousNiceStack?.source;
                    if (step && matchesBase) map.updateOverlayData(FEATURES_OVERLAY_ID, data, step.diff);
                    else map.updateOverlayData(FEATURES_OVERLAY_ID, data);
                    lastDataSent = data;
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
            const backdrop = this.modeBackdropTypes.get();
            if (!ready || !added) return;
            const rawMap = map.map.get();
            if (!rawMap) return;

            if (backdrop.size > 0) {
                // A mode's backdrop types (Vegetation: the course) keep only
                // a faint outline; its own types keep Draw's palette.
                const fill = backdropCase(backdrop, 0, nice ? NICE_FILL_OPACITY : DRAW_FILL_OPACITY);
                const outline = backdropCase(backdrop, BACKDROP_OUTLINE_OPACITY, nice ? 0 : 1);
                rawMap.setPaintProperty('features-fill', 'fill-opacity', draggingHide(fill) as never);
                rawMap.setPaintProperty('features-outline', 'line-opacity', draggingHide(outline) as never);
                rawMap.setPaintProperty('features-rules-outline', 'line-opacity', draggingHide(nice && !rulesOutlines ? 0 : 1) as never);
                rawMap.setPaintProperty('features-generated-fill', 'fill-opacity', fill as never);
                rawMap.setPaintProperty('features-generated-outline', 'line-opacity', outline as never);
            } else if (nice) {
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

/** Line opacity of a mode's backdrop types (see `FeaturesService.modeBackdropTypes`). */
const BACKDROP_OUTLINE_OPACITY = 0.7;

/** Reuse the clipped surfaces when only passthrough rules changed. */
function reuseRulesStack(
    previous: { source: FeatureCollection; result: FeatureCollection } | null,
    source: FeatureCollection,
): { source: FeatureCollection; result: FeatureCollection } | null {
    if (!previous) return null;
    if (previous.source === source) return previous;
    const isRule = (f: Feature) => isRulesType(f.properties?.type as string);
    const before = previous.source.features.filter(f => !isRule(f));
    const after = source.features.filter(f => !isRule(f));
    // Identity includes geometry, type, order, properties and visibility.
    // A rule retyped to a surface (or vice versa) also fails this check.
    if (before.length !== after.length || before.some((f, i) => f !== after[i])) return null;
    return {
        source,
        result: {
            type: 'FeatureCollection',
            features: [...previous.result.features.filter(f => !isRule(f)), ...source.features.filter(isRule)],
        },
    };
}

/** Paint value: `inBackdrop` for the backdrop types, `own` for every other. */
function backdropCase(backdrop: ReadonlySet<string>, inBackdrop: number, own: number): unknown {
    return ['case', ['in', ['get', 'type'], ['literal', [...backdrop]]], inBackdrop, own];
}

/** Layer filter matching a set of feature ids. */
function selectionFilter(ids: ReadonlySet<string>): FilterSpecification {
    return ['in', ['get', 'id'], ['literal', [...ids]]] as unknown as FilterSpecification;
}

/** Fields `update` / `updateMany` can persist. */
type FeaturePatch = {
    geometry?: FeatureGeometry;
    type?: string;
    holeId?: string | null;
    layer?: FeatureLayer;
    attributes?: FeatureAttributesPatch | null;
};

/** The row's patchable fields when a save was requested (see `mergeReply`). */
type PatchBase = Pick<CourseFeature, 'geometry' | 'type' | 'holeId' | 'layer' | 'attributes'>;

/** Input for `create` / `createMany`. */
type CreateInput = {
    type: string;
    sortOrder?: number;
    holeId?: string | null;
    layer?: FeatureLayer;
    geometry: FeatureGeometry;
    attributes?: FeatureAttributesPatch | null;
    /** Provenance of a shape made from a proposal (course_features.source), e.g. 'surface-model'. */
    source?: string;
};

/** Stable empty list (no kerb fillets). */
const NO_FEATURES: Feature[] = [];

/** Unsent `update` patches for one feature, merged in call order. */
interface PendingPatch {
    patch: FeaturePatch;
    /** Row fields at the latest `update` call merged into `patch`. */
    base: PatchBase;
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
    if (patch.layer !== undefined) out.layer = patch.layer;
    if (patch.attributes !== undefined) out.attributes = patch.attributes;
    return out;
}

/** localStorage key for one course's hidden feature types. */
export function hiddenTypesKey(courseId: string): string {
    return `golf-map.hiddenTypes.${courseId}`;
}

function readHiddenTypes(courseId: string): ReadonlySet<string> {
    try {
        const raw = localStorage.getItem(hiddenTypesKey(courseId));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []);
    } catch {
        return new Set();
    }
}

function writeHiddenTypes(courseId: string, types: ReadonlySet<string>): void {
    try {
        if (types.size === 0) localStorage.removeItem(hiddenTypesKey(courseId));
        else localStorage.setItem(hiddenTypesKey(courseId), JSON.stringify([...types]));
    } catch {
        // Storage blocked or full: visibility still works for this session.
    }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
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

/**
 * Per-feature render inputs: id, geometry (by identity), type, holeId,
 * sortOrder, stackKey, source, layer, attributes (by identity) and the zone
 * type's colour (it follows the course's zone-type table, not the row).
 */
type RenderSignature = readonly [string, object, string, string | null, number, number, string | null, FeatureLayer, unknown, string];

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
