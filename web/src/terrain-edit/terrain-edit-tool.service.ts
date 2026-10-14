// Terrain-edit tool (T55b) — draw smooth/flatten areas onto the DEM.
//
// Edits are VECTOR features replayed onto the DEM at build time (T54/T56),
// never raster mutations: each is a polygon ring (EPSG:3006, plain straight
// segments — no bezier/b-spline anchors) plus op params, persisted site-scoped
// through the T55a terrain-edits API. Two ops (D-TE3): 'plane' (least-squares
// plane fit, optional dead-flat) and 'smooth' (circular median filter); both
// feather over an edge band.
//
// The tool owns its OWN DrawState instance for polygon drafting — terrain
// edits are deliberately NOT course features (no pseudo-type in
// FEATURE_TYPES, no FeaturesService.create): they live in a different table,
// are site- not course-scoped, and never render on players' maps. The commit
// funnel here mirrors DrawToolService.closeDraft but POSTs to the
// terrain-edits API instead.
//
// Map rendering goes through the TerrainEditRenderer seam (the real
// implementation, terrain-edit-overlay.ts, imports maplibre-gl and cannot
// load under bun test — same split as the analysis tool).

import { Signal, Computed, effect, untrack, di } from '@basics/core/client/core';
import { canvasCursor } from '../editor/canvas-cursor';
import { screenDistSweref } from '../editor/screen-point';
import { isTypingTarget } from '../editor/shortcut.service';
import { api } from '../api';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { TerrainEdit, TerrainEditsApi } from '../../../shared/api/terrain-edits.gen';
import type { MapBuildApi, MapBuildJob } from '../../../shared/api/map-build.gen';
import type { TerrainGeneratorsApi } from '../../../shared/api/terrain-generators.gen';

/** The terrain generators the panel offers (server origins of the edits they write). */
export type TerrainGeneratorKind = 'building-pads' | 'road-grades' | 'water-digs' | 'bunker-digs' | 'creek-digs';
export const GENERATOR_LABELS: Record<TerrainGeneratorKind, string> = {
    'building-pads': 'Building pads',
    'road-grades': 'Road grades',
    'water-digs': 'Pond digs',
    'bunker-digs': 'Bunker digs',
    'creek-digs': 'Creek digs',
};
import type { CoursesApi } from '../../../shared/api/courses.gen';
import { STEP_LABELS } from '../map-build/map-build.service';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent, MapService } from '../map/map.service';
import { deriveTileVersion, parseTileManifest, type TileManifest } from '../map/tileset.service';
import { buildEditorStyle, HILLSHADE_SOURCE_ID, TERRAIN_SOURCE_ID } from '../map/map-style';
import type { AnchorPoint, Point } from '../geo/bezier';
import { DrawState, MIN_RING_POINTS } from '../draw/draw-state';
import { lngLatToSweref99tm, sweref99tmToWgs84 } from '../geo/transform';
import { flattenRing } from '../geo/bezier';
import { containingTopDown } from '../draw/draw-tool.service';
import { FEATURE_STYLES, type FeatureType } from '../draw/feature-palette';
import { shapeName } from '../export/svg-exclusions';
import { NO_RECIPE, SEED, ShapingService, surfaceOf } from './shaping.service';
import {
    CREEK_DIG_PRESETS, DIG_ATTRIBUTES, DIG_GENERATOR_KINDS, WATER_DIG_PRESETS, type DigGeneratorKind,
} from '../../../shared/features/dig-presets';

/** Interaction-claim id for the terrain-edit tool (also its registry id). */
export const TERRAIN_EDIT_TOOL_ID = 'terrain-edit';

/** Screen-px radius: clicking within this of the draft's first point closes it. */
const CLOSE_RING_PX = 12;

/** Re-terrain job poll interval (map-build.service pattern). */
const POLL_MS = 1500;

/** Default edge-feather band width, meters (D-TE3; pipeline default). */
export const DEFAULT_FEATHER_M = 2;
/** Default median-filter radius for 'smooth', meters (pipeline default). */
export const DEFAULT_RADIUS_M = 2;

export type TerrainEditOp = TerrainEdit['op'];

/**
 * A feature's Blender shaping recipe (blender/SHAPING-PLAN.md): an edit with
 * `op: 'recipe'`, `params: {recipe, overrides?}`, origin `feature` and
 * originRef `feature:<id>`. It never touches the DEM; the shaping apply job
 * replays it onto the feature's course meshes. No edit = the course default.
 */
export const RECIPE_OP = 'recipe' satisfies TerrainEditOp;

/** Marker glyph per op (DOM markers — the editor style has no glyphs endpoint). */
export const OP_GLYPHS: Record<TerrainEditOp, string> = { plane: '▱', smooth: '∿', corridor: '⫽', dig: '◡', delta: '≈', recipe: '◈' };

/** Whether an edit is a feature's Blender recipe. */
export function isRecipeEdit(edit: TerrainEdit): boolean {
    return edit.op === RECIPE_OP;
}

/** A recipe edit's params (the library id and the per-feature overrides). */
export function recipeParams(edit: TerrainEdit): { recipe: string; overrides?: Record<string, unknown> } {
    const { recipe, overrides } = edit.params;
    return { recipe: recipe ?? '', ...(overrides ? { overrides } : {}) };
}

/** The course feature a recipe edit shapes, or null. */
export function recipeFeatureId(edit: TerrainEdit): string | null {
    if (!isRecipeEdit(edit)) return null;
    return edit.originRef?.startsWith('feature:') ? edit.originRef.slice('feature:'.length) : null;
}

/**
 * Map colours for the features that have a recipe of their own, one per
 * library recipe (in library order, wrapping). Clear of the edit violet, the
 * selection yellow and the highlight white.
 */
export const RECIPE_COLORS = ['#22d3ee', '#fb923c', '#f472b6', '#a3e635', '#60a5fa', '#f87171', '#2dd4bf', '#c4b5fd'] as const;
/** The colour of "no recipe" and of a recipe the library does not have. */
export const RECIPE_COLOR_OTHER = '#cbd5e1';

/** A recipe edit on the map: its feature's outline (EPSG:3006 rings) in its recipe's colour. */
export interface RecipeMark {
    rings: Array<Array<{ x: number; y: number }>>;
    color: string;
}

const NO_RECIPE_MARKS: Record<string, RecipeMark> = {};

/** One-line params summary for the panel rows and the map glyph tooltips. */
export function paramsSummary(edit: TerrainEdit): string {
    const parts: string[] = [];
    if (isRecipeEdit(edit)) {
        // Shaped in Blender, never baked into the DEM.
        const { recipe, overrides } = recipeParams(edit);
        const n = overrides ? Object.keys(overrides).length : 0;
        return [`Blender recipe ${recipe}`, ...(n > 0 ? [`${n} override${n === 1 ? '' : 's'}`] : [])].join(' · ');
    }
    if (edit.op === 'plane' && edit.params.flat) parts.push('flat');
    if (edit.op === 'smooth') parts.push(`r ${edit.params.radiusM ?? DEFAULT_RADIUS_M} m`);
    if (edit.op === 'corridor') {
        // Pipeline-generated road grading: smooth along the road, level across it.
        if (edit.params.widthM !== undefined) parts.push(`w ${edit.params.widthM} m`);
        if (edit.params.smoothM !== undefined) parts.push(`along ${edit.params.smoothM} m`);
    }
    if (edit.op === 'dig') {
        // Generated pond/bunker digs: depth below the water level or the ground around it.
        parts.push(`${edit.params.depthM} m below ${edit.params.reference === 'plane' ? 'ground' : edit.params.reference === 'stream' ? 'the creek surface' : 'water level'}`);
        parts.push(edit.params.faceSlopeDeg !== undefined
            ? `face ${edit.params.faceSlopeDeg}° to ${Math.round(edit.params.faceBearingDeg ?? 0)}°, entry ${edit.params.bankSlopeDeg}°`
            : `banks ${edit.params.bankSlopeDeg}°`);
    }
    if (edit.op === 'delta') {
        // A Unity sculpt layer ("Pull from Unity"): heights changed in Unity, added on top of everything.
        parts.push(`Unity sculpt, ${((edit.params.changedM2 ?? 0) / 10000).toFixed(2)} ha, +${edit.params.maxRaiseM ?? 0} / ${edit.params.maxLowerM ?? 0} m`);
    }
    if (edit.op !== 'dig' && edit.op !== 'delta') parts.push(`feather ${edit.params.featherM} m`);
    return parts.join(' · ');
}

/** What a generated dig was dug from, by origin. */
const DIG_NOUNS: Record<DigGeneratorKind, string> = { 'water-digs': 'Pond', 'bunker-digs': 'Bunker', 'creek-digs': 'Creek' };

/** A group of rows in the panel's edit list. */
export interface EditGroup {
    key: string;
    label: string;
    edits: TerrainEdit[];
}

/** The list's groups, in panel order ('away': digs of features not on this course). */
const GROUPS: Array<{ key: string; label: string }> = [
    { key: 'hand', label: 'Your edits' },
    { key: 'recipes', label: 'Blender recipes' },
    { key: 'water-digs', label: 'Ponds' },
    { key: 'bunker-digs', label: 'Bunkers' },
    { key: 'creek-digs', label: 'Creeks' },
    { key: 'building-pads', label: 'Building pads' },
    { key: 'road-grades', label: 'Road grades' },
    { key: 'sculpt', label: 'Unity sculpt' },
    { key: 'away', label: 'Not on this course' },
    { key: 'other', label: 'Other' },
];

/**
 * Which form an edit opens: 'params' for a hand-drawn plane/smooth edit (its
 * own op and params, saved on the edit), 'dig' for a generated pond, bunker
 * or creek dig (its settings live on the feature it was dug from, so a
 * re-run keeps them), null for the rest (building pads, road grades, Unity
 * sculpt: change their source and regenerate).
 */
export type EditFormKind = 'params' | 'dig';

/** The course feature a generated dig was dug from, or null. */
export function digFeatureId(edit: TerrainEdit): string | null {
    if (!edit.origin || !(DIG_GENERATOR_KINDS as readonly string[]).includes(edit.origin)) return null;
    return edit.originRef?.startsWith('feature:') ? edit.originRef.slice('feature:'.length) : null;
}

/** A dig feature's settings; a missing one is its preset's (or the default preset's). */
export interface DigSettings {
    preset?: string;
    depthM?: number;
    bankSlopeDeg?: number;
    /** Bunkers only: the face towards the green. */
    faceSlopeDeg?: number;
}

/** A hand-drawn edit's form values (radiusM is smooth's, flat is plane's). */
export interface HandEditParams {
    op: 'plane' | 'smooth';
    featherM: number;
    radiusM: number;
    flat: boolean;
}

type Attributes = Record<string, string | number | boolean>;

/** Everything the renderer needs to draw one overlay state. */
export interface TerrainEditView {
    edits: TerrainEdit[];
    /** In-progress draft ring (EPSG:3006), empty when idle. */
    draft: AnchorPoint[];
    /** The edit to draw highlighted: the hovered row, else the open form's. */
    highlightId: string | null;
    /** Each edit's map label: its name (editName), a recipe edit's recipe name. */
    labels: Record<string, string>;
    /** The recipe edits to draw on their features, by edit id. */
    recipes: Record<string, RecipeMark>;
    /** The outlines of the features selected for shaping (EPSG:3006 rings per feature), empty when none. */
    selection: Array<Array<Array<{ x: number; y: number }>>>;
    /**
     * Pointer position (EPSG:3006) for the rubber band from the last draft
     * point. Null while no draft is open or while a mouse button is held.
     */
    cursor: Point | null;
}

/**
 * Map-rendering boundary for the tool (analysis-tool pattern): the real
 * implementation imports maplibre-gl, which cannot load under bun test, so
 * the service only talks to this interface and the descriptor
 * (terrain-edit-tool.ts) injects the real renderer.
 */
export interface TerrainEditRenderer {
    /** Draw/refresh the overlay for `view`. Map is ready. */
    render(map: MapService, view: TerrainEditView): void;
    /** The map was destroyed (ready → false): forget per-map state. */
    reset(): void;
    /** Remove everything from a still-live map (tool deactivation). */
    clear(map: MapService): void;
}

/**
 * The `terrain-edit` EditorTool's headless service. Click-to-place polygon
 * drafting via an OWN DrawState; closing the ring (click near the first
 * point) POSTs the edit with the currently-armed op/params, then chain-draws
 * the next one. TerrainEditPanelComponent shares this DI singleton for the
 * op/params controls and the per-site edit list (enabled toggle / delete).
 *
 * The overlay is activation-scoped — edits are builder-internal and hidden
 * outside this tool.
 */
export class TerrainEditToolService {
    /** Own drafting state machine — NOT DrawToolService's instance. */
    readonly state = new DrawState();

    /** The site's terrain edits (server order: created_at — D-TE4). */
    readonly edits = new Signal<TerrainEdit[]>([]);
    readonly loading = new Signal(false);
    readonly saving = new Signal(false);
    /** One-line panel notice (load/save failures, missing site). */
    readonly notice = new Signal<string | null>(null);

    // Params armed for the NEXT drawn edit (panel controls).
    readonly op = new Signal<TerrainEditOp>('plane');
    readonly featherM = new Signal(DEFAULT_FEATHER_M);
    readonly radiusM = new Signal(DEFAULT_RADIUS_M);
    readonly flat = new Signal(false);

    /** The edit whose form is open in the panel. */
    readonly editingId = new Signal<string | null>(null);
    /** The edit-list row under the pointer (its outline is highlighted). */
    readonly hoveredId = new Signal<string | null>(null);

    /** The tool context while active, as a signal so the list's names follow features and holes. */
    private readonly ctxSignal = new Signal<ToolContext | null>(null);

    /**
     * The course features clicked on the map for "Shape in Blender" (bunkers,
     * ponds, creeks or paths — `surfaceOf` their type), in the order picked;
     * Cmd/Ctrl+click adds more of the same surface. Empty when none.
     */
    readonly selectedFeatureIds = new Signal<readonly string[]>([]);
    /** The first selected feature's id (the only one, unless several are selected). */
    readonly selectedFeatureId = new Computed<string | null>(() => this.selectedFeatureIds.get()[0] ?? null);
    /** The selected features that are loaded on this course. */
    readonly selectedFeatures = new Computed<CourseFeature[]>(() => {
        const ids = this.selectedFeatureIds.get();
        if (ids.length === 0) return [];
        const byId = new Map((this.ctxSignal.get()?.features.store.items.get() ?? []).map(f => [f.id, f]));
        return ids.flatMap(id => byId.get(id) ?? []);
    });
    /** The first selected feature, while it is loaded on this course. */
    readonly selectedFeature = new Computed<CourseFeature | null>(() => this.selectedFeatures.get()[0] ?? null);
    /** The shaping job scope of the selection (ShapingService.jobScope): its ids, null when none. */
    readonly selectionScope = new Computed<string | null>(() => {
        const ids = this.selectedFeatureIds.get();
        return ids.length > 0 ? ids.join(',') : null;
    });

    /** The edit drawn highlighted: the hovered row, else the open form's. */
    readonly highlightId = new Computed<string | null>(() => this.hoveredId.get() ?? this.editingId.get());

    /** Each edit's map label (its own computed: a hover must not rename every edit). */
    private readonly labels = new Computed<Record<string, string>>(() =>
        Object.fromEntries(this.edits.get().map(e => [e.id, isRecipeEdit(e) ? this.recipeName(e) : this.editName(e)])));

    /**
     * The features that have a recipe of their own (bunkers, ponds, creeks,
     * paths), by recipe edit id: drawn filled in the recipe's colour so the
     * ones done stand out from the ones still on the course default.
     */
    private readonly recipeMarks = new Computed<Record<string, RecipeMark>>(() => {
        const edits = this.edits.get().filter(isRecipeEdit);
        if (edits.length === 0) return NO_RECIPE_MARKS;
        const byId = new Map((this.ctxSignal.get()?.features.store.items.get() ?? []).map(f => [f.id, f]));
        const library = this.shaping.recipes.get().map(r => r.id);
        const marks: Record<string, RecipeMark> = {};
        for (const edit of edits) {
            const feature = byId.get(recipeFeatureId(edit) ?? '');
            if (!feature) continue;
            const index = library.indexOf(recipeParams(edit).recipe);
            marks[edit.id] = {
                rings: featureRings(feature),
                color: index < 0 ? RECIPE_COLOR_OTHER : RECIPE_COLORS[index % RECIPE_COLORS.length],
            };
        }
        return marks;
    });

    /** Pointer position for the rubber band (see TerrainEditView.cursor). */
    readonly cursor = new Signal<Point | null>(null);

    /** Renderable overlay state (persisted edits, the live draft, the pointer). */
    readonly view = new Computed<TerrainEditView>(() => {
        return {
            edits: this.edits.get(),
            draft: this.state.draft.get(),
            cursor: this.cursor.get(),
            highlightId: this.highlightId.get(),
            labels: this.labels.get(),
            recipes: this.recipeMarks.get(),
            selection: this.selectedFeatures.get().map(featureRings),
        };
    });

    /** The edit list for the panel, grouped by kind (GROUPS order), empty groups left out. */
    readonly groups = new Computed<EditGroup[]>(() => {
        const byKey = new Map<string, TerrainEdit[]>();
        for (const edit of this.edits.get()) {
            const key = this.groupKey(edit);
            byKey.set(key, [...(byKey.get(key) ?? []), edit]);
        }
        return GROUPS.filter(g => byKey.has(g.key)).map(g => ({
            ...g,
            // Your edits in the order you drew them; generated ones by hole, then name.
            edits: g.key === 'hand' ? byKey.get(g.key)! : [...byKey.get(g.key)!].sort((a, b) =>
                (this.holeNumber(a) ?? Infinity) - (this.holeNumber(b) ?? Infinity)
                || this.editName(a).localeCompare(this.editName(b))),
        }));
    });

    private ctx: ToolContext | null = null;
    private renderer: TerrainEditRenderer | null = null;
    /** True while a render flush is queued (microtask coalescing). */
    private renderScheduled = false;
    /** Monotonic token so a stale list response never clobbers a newer one. */
    private loadSeq = 0;
    /** Aborts the running re-terrain poll (deactivate, canvas unmount). */
    private applyAbort: AbortController | null = null;

    constructor(
        private editsApi: TerrainEditsApi = api.terrainEdits,
        private mapBuildApi: MapBuildApi = api.mapBuild,
        /** Poll interval override for tests (real timers). */
        private pollMs: number = POLL_MS,
        private generatorsApi: TerrainGeneratorsApi = api.terrainGenerators,
        /** The recipe library and the Blender apply job (shared with the panel). */
        readonly shaping: ShapingService = di.get(ShapingService),
        /** Course GET for the post-apply manifest (new tile version). */
        private coursesApi: Pick<CoursesApi, 'get'> = api.courses,
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    // Generators (T-roads): the server runs the pipeline's building survey +
    // pads, or road fetch + grades, and imports the edits under their origin
    // (replacing that origin's previous generation only). The list reloads;
    // "Apply to terrain" bakes them like any other edit.
    // ─────────────────────────────────────────────────────────────────────────

    /** The generator running now, for the panel's button labels. */
    readonly generating = new Signal<TerrainGeneratorKind | null>(null);

    async generate(kind: TerrainGeneratorKind): Promise<boolean> {
        const result = await this.runGenerator(kind);
        if (!result) return false;
        const skipped = result.skipped.length > 0 ? ` (${result.skipped.length} feature(s) skipped)` : '';
        this.notice.set(`${GENERATOR_LABELS[kind]}: ${result.imported} edit(s) generated${skipped}. Apply to terrain to bake them.`);
        return true;
    }

    /** Runs a generator and reloads the list; null when busy or failed (the notice says why). */
    private async runGenerator(kind: TerrainGeneratorKind): Promise<{ imported: number; skipped: string[] } | null> {
        const ctx = this.ctx;
        if (!ctx || this.generating.peek() || this.applying.peek()) return null;
        this.generating.set(kind);
        this.notice.set(null);
        try {
            const result = await this.generatorsApi.generate({ courseId: ctx.courseId, kind });
            await this.reload();
            return result;
        } catch (e) {
            this.notice.set(`${GENERATOR_LABELS[kind]} failed: ${message(e)}`);
            return null;
        } finally {
            this.generating.set(null);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Changing an edit: the panel's form for one row (`editingId`). A
    // hand-drawn edit saves its params on itself; a generated dig saves on its
    // feature and re-runs its generator, so the next run keeps the change.
    // ─────────────────────────────────────────────────────────────────────────

    formKind(edit: TerrainEdit): EditFormKind | null {
        if (!edit.origin) return edit.op === 'plane' || edit.op === 'smooth' ? 'params' : null;
        return digFeatureId(edit) ? 'dig' : null;
    }

    /** A generated dig's settings from its feature's attributes (null: the feature isn't loaded). */
    digSettings(edit: TerrainEdit): DigSettings | null {
        const attrs = this.featureAttributes(edit);
        if (attrs === undefined) return null;
        const num = (key: string) => (typeof attrs?.[key] === 'number' ? attrs[key] as number : undefined);
        const settings: DigSettings = {};
        if (typeof attrs?.digPreset === 'string') settings.preset = attrs.digPreset;
        if (num('digDepthM') !== undefined) settings.depthM = num('digDepthM');
        if (num('digBankSlopeDeg') !== undefined) settings.bankSlopeDeg = num('digBankSlopeDeg');
        if (num('digFaceSlopeDeg') !== undefined) settings.faceSlopeDeg = num('digFaceSlopeDeg');
        return settings;
    }

    /** Saves a generated dig's settings on its feature and re-digs that kind. */
    async saveDigSettings(id: string, settings: DigSettings): Promise<boolean> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return false;
        const attrs = this.featureAttributes(edit);
        if (attrs === undefined) {
            this.notice.set('The feature this dig was made from is not loaded on this course — regenerate to drop the dig.');
            return false;
        }
        const next: Attributes = { ...(attrs ?? {}) };
        for (const key of DIG_ATTRIBUTES) if (key !== 'dig') delete next[key];
        if (settings.preset) next.digPreset = settings.preset;
        if (settings.depthM !== undefined) next.digDepthM = settings.depthM;
        if (settings.bankSlopeDeg !== undefined) next.digBankSlopeDeg = settings.bankSlopeDeg;
        if (settings.faceSlopeDeg !== undefined) next.digFaceSlopeDeg = settings.faceSlopeDeg;
        return this.redig(edit, next, 'Saved on the feature');
    }

    /** Saves a hand-drawn edit's op and params in place. */
    async saveParams(id: string, form: HandEditParams): Promise<boolean> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return false;
        const params = form.op === 'plane'
            ? { featherM: form.featherM, ...(form.flat ? { flat: true } : {}) }
            : { featherM: form.featherM, radiusM: form.radiusM };
        this.saving.set(true);
        try {
            const updated = await this.editsApi.update({ id, version: edit.version, op: form.op, params });
            this.edits.update(list => list.map(e => (e.id === id ? updated : e)));
            this.notice.set('Saved. Apply to terrain to bake it.');
            return true;
        } catch (e) {
            await this.reload(); // resync (order per setEnabled)
            this.notice.set(`Saving the edit failed: ${message(e)}`);
            return false;
        } finally {
            this.saving.set(false);
        }
    }

    /** The attributes of the feature a dig came from; undefined when that feature isn't loaded. */
    private featureAttributes(edit: TerrainEdit): Attributes | null | undefined {
        const featureId = digFeatureId(edit);
        const feature = featureId ? this.ctx?.features.store.items.peek().find(f => f.id === featureId) : undefined;
        return feature ? (feature.attributes as Attributes | null) : undefined;
    }

    /** Writes a dig's feature attributes, then re-runs its generator. */
    private async redig(edit: TerrainEdit, attributes: Attributes, done: string): Promise<boolean> {
        const features = this.ctx?.features;
        const featureId = digFeatureId(edit);
        if (!features || !featureId) return false;
        this.saving.set(true);
        try {
            if (await features.update(featureId, { attributes }) === undefined) {
                this.notice.set('Saving the feature failed.');
                return false;
            }
        } finally {
            this.saving.set(false);
        }
        const kind = edit.origin as DigGeneratorKind;
        const result = await this.runGenerator(kind);
        if (!result) return false;
        this.notice.set(`${done}; ${GENERATOR_LABELS[kind].toLowerCase()} regenerated (${result.imported}). Apply to terrain to bake it.`);
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shape in Blender (SHAPING-PLAN.md "Terrain editor → Blender"): click a
    // bunker, pond, creek or path, pick its recipe (a `recipe` edit; none =
    // the course default for its surface), then the command bar's "Update
    // meshes (this feature)" runs the shaping job for it (ShapingService).
    // ─────────────────────────────────────────────────────────────────────────

    /** The recipe edit of a feature, if it has one (else it gets the course default). */
    recipeEditOf(featureId: string): TerrainEdit | null {
        return this.edits.get().find(e => recipeFeatureId(e) === featureId) ?? null;
    }

    /** "Bunker · hole 3 · hole_3_1c": what the feature is, and its shape (mesh) name in the SVG. */
    describeFeature(feature: CourseFeature): string {
        const parts = [FEATURE_STYLES[feature.type as FeatureType]?.label ?? feature.type];
        const hole = this.holeNumberOf(feature.holeId);
        if (hole !== null) parts.push(`hole ${hole}`);
        parts.push(shapeName(feature, hole ?? undefined));
        return parts.join(' · ');
    }

    /** "Bunker × 3 · hole_3_1c, hole_3_2c, hole_5_1c" for several features, describeFeature for one. */
    describeSelection(features: readonly CourseFeature[]): string {
        if (features.length <= 1) return features[0] ? this.describeFeature(features[0]) : '';
        const label = FEATURE_STYLES[features[0].type as FeatureType]?.label ?? features[0].type;
        const names = features.map(f => shapeName(f, this.holeNumberOf(f.holeId) ?? undefined));
        return `${label} × ${features.length} · ${names.join(', ')}`;
    }

    /** Selects the feature for shaping, alone (null clears the selection). */
    selectFeature(featureId: string | null): void {
        this.selectedFeatureIds.set(featureId ? [featureId] : []);
    }

    /**
     * Cmd/Ctrl+click: adds the feature to the selection, or takes it out. A
     * feature of another surface than the selection (a pond among bunkers)
     * starts a new selection instead, so one recipe list fits them all.
     */
    toggleFeature(featureId: string): void {
        const ids = this.selectedFeatureIds.peek();
        if (ids.includes(featureId)) {
            this.selectedFeatureIds.set(ids.filter(id => id !== featureId));
            return;
        }
        const items = this.ctx?.features.store.items.peek() ?? [];
        const surface = surfaceOf(items.find(f => f.id === featureId)?.type ?? '');
        const current = this.selectedFeature.peek();
        const same = current !== null && surfaceOf(current.type) === surface;
        this.selectedFeatureIds.set(same ? [...ids, featureId] : [featureId]);
    }

    /**
     * Saves the feature's recipe: a library id creates or updates its recipe
     * edit, null deletes it (the course default). `overrides` (param values
     * and `seed`, SHAPING-PLAN.md "Composite and parameterised recipes")
     * replaces the saved ones, `{}` clears them; left out, they are kept.
     */
    saveRecipe(featureId: string, recipeId: string | null, overrides?: Record<string, number>): Promise<boolean> {
        return this.saveRecipes([featureId], recipeId, overrides);
    }

    /**
     * Saves one recipe on several features at once (saveRecipe for each).
     * `keepSeeds`: each feature keeps its own saved seed instead of taking
     * `overrides`' one, so the same settings still give each its own shape.
     */
    async saveRecipes(
        featureIds: readonly string[], recipeId: string | null, overrides?: Record<string, number>,
        opts: { keepSeeds?: boolean } = {},
    ): Promise<boolean> {
        const siteId = this.siteId();
        if (!siteId) {
            this.notice.set('This course has no site/map yet — set a map area first.');
            return false;
        }
        this.saving.set(true);
        try {
            for (const featureId of featureIds) {
                await this.saveRecipeOf(siteId, featureId, recipeId, overrides, opts.keepSeeds === true);
            }
            const n = featureIds.length;
            const on = n === 1 ? '' : ` on ${n} features`;
            const them = n === 1 ? 'it' : 'them';
            this.notice.set(recipeId
                ? `Recipe saved${on}. Update meshes in the command bar to shape ${them}.`
                : `Back to the course default recipe${on}. Update meshes in the command bar to shape ${them}.`);
            return true;
        } catch (e) {
            await this.reload(); // resync (order per setEnabled)
            this.notice.set(`Saving the recipe failed: ${message(e)}`);
            return false;
        } finally {
            this.saving.set(false);
        }
    }

    /** One feature's recipe edit: created, updated or (null recipe) deleted. Throws on failure. */
    private async saveRecipeOf(
        siteId: string, featureId: string, recipeId: string | null,
        overrides: Record<string, number> | undefined, keepSeed: boolean,
    ): Promise<void> {
        const existing = this.recipeEditOf(featureId);
        if (!recipeId) {
            if (existing) {
                await this.editsApi.remove({ id: existing.id, version: existing.version });
                this.edits.update(list => list.filter(e => e.id !== existing.id));
            }
            return;
        }
        const saved = existing ? recipeParams(existing).overrides : undefined;
        let kept: Record<string, unknown> | undefined = overrides ?? saved;
        if (overrides && keepSeed) {
            const rest: Record<string, unknown> = { ...overrides };
            delete rest[SEED];
            kept = saved?.[SEED] !== undefined ? { ...rest, [SEED]: saved[SEED] } : rest;
        }
        const params = { recipe: recipeId, ...(kept && Object.keys(kept).length > 0 ? { overrides: kept } : {}) };
        if (existing) {
            const updated = await this.editsApi.update({ id: existing.id, version: existing.version, params });
            this.edits.update(list => list.map(e => (e.id === existing.id ? updated : e)));
        } else {
            // No rings: the feature is the shape (the server sets origin `feature`, originRef `feature:<id>`).
            const created = await this.editsApi.create({ siteId, op: RECIPE_OP, params, featureId });
            this.edits.update(list => [...list, created]);
        }
    }

    /**
     * Runs the Blender → Unity shaping job for this tool's course. The server
     * always runs the whole course (the worker re-shapes only meshes whose ops
     * changed, so one saved recipe re-shapes just its feature's meshes);
     * `scope` (a feature id, or the selection's `selectionScope`) says where
     * the panel shows the outcome.
     *
     * The buttons that start it are the command bar's ("Update meshes (this
     * feature)" runs `ShapingService.apply` with the selection as its scope,
     * "Update meshes" the whole target through the status board); this stays as
     * the tool's own way in, for the keyboard and for callers that already
     * hold the tool.
     */
    async applyToMeshes(scope?: string): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx) return false;
        const job = await this.shaping.apply(ctx.courseId, scope ?? null);
        return job?.status === 'succeeded';
    }

    /** A list row was clicked: a recipe edit selects its feature and shows it; any other row shows its outline. */
    showEdit(id: string): void {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return;
        const featureId = recipeFeatureId(edit);
        if (!featureId) {
            this.zoomTo(id);
            return;
        }
        this.selectFeature(featureId);
        const feature = this.ctx?.features.store.items.peek().find(f => f.id === featureId) ?? null;
        this.fitRings(featureRings(feature));
    }

    /** The topmost shapeable feature (bunker, pond, creek, path) at an EPSG:3006 point: draw mode's hit rule. */
    private hitShapeable(p: { x: number; y: number }): CourseFeature | null {
        const features = this.ctx?.features;
        if (!features) return null;
        const stack = features.stackTopDown.peek().filter(f => surfaceOf(f.type) !== null);
        return containingTopDown(stack, features.effectiveHiddenTypes.peek(), p,
            features.hiddenIds.peek(), features.hiddenSources.peek())[0] ?? null;
    }

    // ── EditorTool lifecycle (called via terrain-edit-tool.ts) ─────────────

    activate(ctx: ToolContext, renderer: TerrainEditRenderer): void {
        this.ctx = ctx;
        this.ctxSignal.set(ctx);
        this.renderer = renderer;
        this.notice.set(null);

        ctx.track(ctx.map.onClick(e => this.onClick(e)));
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // Draft keys (draw-tool key map). A bubbling window listener: the
        // ShortcutService dispatcher sees keys first and stops propagation
        // for the ones its layers consume (Esc chain, editor-wide keys).
        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Overlay rendering, coalesced onto a microtask: closing a draft
        // writes draft AND edits back-to-back, and @basics/core signals are
        // push-based eager — without coalescing the effect would render the
        // mixed intermediate state too (reactive-cascade gotcha).
        ctx.track(effect(() => {
            const ready = ctx.map.ready.get();
            this.view.get(); // subscribe to the overlay-driving state
            if (!ready) {
                renderer.reset();
                return;
            }
            untrack(() => this.scheduleRender());
        }));
        ctx.track(() => {
            if (ctx.map.ready.peek()) renderer.clear(ctx.map);
            else renderer.reset();
        });

        // Crosshair while placing points.
        ctx.track(canvasCursor(ctx.map, () => 'crosshair'));

        // The tool is always drawing — there is no select sub-mode here
        // (a click on a bunker/pond/creek/path selects it for shaping instead).
        this.state.arm();
        void this.reload();
        void this.shaping.loadRecipes();
        // A shaping job still running (the page reloaded, or the editor was closed meanwhile): follow it again.
        void this.shaping.resume(ctx.courseId);
    }

    deactivate(): void {
        this.abortApply();
        this.state.disarm();
        this.cursor.set(null);
        this.saving.set(false);
        this.hoveredId.set(null);
        this.selectedFeatureIds.set([]);
        this.ctx = null;
        this.ctxSignal.set(null);
        this.renderer = null;
    }

    /**
     * Stop polling a running re-terrain job. The server job keeps running;
     * only this client stops waiting for it and skips the tile refresh.
     */
    abortApply(): void {
        this.applyAbort?.abort();
        this.applyAbort = null;
    }

    /**
     * True while a draft ring has points: the editor-wide sub-mode letters
     * fall through instead of switching tools and discarding the outline.
     */
    isBusy(): boolean {
        return this.state.draft.peek().length > 0;
    }

    /** ESC: cancel an in-progress draft (stay active) → deactivate. */
    onEscape(): boolean {
        if (this.state.draft.peek().length > 0) {
            this.state.disarm();
            this.state.arm(); // stay in draw mode for the next outline
            this.cursor.set(null);
            return true;
        }
        if (this.selectedFeatureIds.peek().length > 0) {
            this.selectedFeatureIds.set([]);
            return true;
        }
        return false;
    }

    // ── Naming and finding edits ────────────────────────────────────────────

    /**
     * What an edit is, for its row and map label: a dig by its feature
     * ("Bunker · hole 3", "Pond · hole 5 · Deep Water"), the rest by kind.
     */
    editName(edit: TerrainEdit): string {
        if (isRecipeEdit(edit)) {
            const feature = this.featureOf(edit);
            const name = this.recipeName(edit);
            if (!feature) return `Recipe · not on this course · ${name}`;
            const parts = [FEATURE_STYLES[feature.type as FeatureType]?.label ?? feature.type];
            const hole = this.holeNumber(edit);
            if (hole !== null) parts.push(`hole ${hole}`);
            parts.push(name);
            return parts.join(' · ');
        }
        if (!edit.origin) return `${capitalize(edit.op)} (drawn)`;
        if (edit.origin in DIG_NOUNS) {
            const noun = DIG_NOUNS[edit.origin as DigGeneratorKind];
            const feature = this.featureOf(edit);
            if (!feature) return `${noun} · not on this course`;
            const parts = [noun];
            const hole = this.holeNumber(edit);
            if (hole !== null) parts.push(`hole ${hole}`);
            const preset = feature.attributes?.digPreset;
            const table: Record<string, { label: string }> | null =
                edit.origin === 'water-digs' ? WATER_DIG_PRESETS : edit.origin === 'creek-digs' ? CREEK_DIG_PRESETS : null;
            if (table && typeof preset === 'string' && preset in table) parts.push(table[preset].label);
            return parts.join(' · ');
        }
        if (edit.origin === 'building-pads') return 'Building pad';
        if (edit.origin === 'road-grades') return edit.params.widthM !== undefined ? `Road grade · ${edit.params.widthM} m wide` : 'Road grade';
        if (edit.origin.startsWith('unity-sculpt')) {
            const terrain = edit.origin.slice('unity-sculpt'.length).replace(/^-/, '');
            return terrain ? `Unity sculpt (${terrain})` : 'Unity sculpt';
        }
        return `${capitalize(edit.op)} · ${edit.origin}`;
    }

    /** A recipe edit's recipe by its library name ("no recipe" for the opt-out, the id when not in the library). */
    private recipeName(edit: TerrainEdit): string {
        const { recipe } = recipeParams(edit);
        return recipe === NO_RECIPE ? 'no recipe' : this.shaping.recipe(recipe)?.name ?? recipe;
    }

    /** Fits the map to an edit's outline. */
    zoomTo(id: string): void {
        const edit = this.edits.peek().find(e => e.id === id);
        if (edit) this.fitRings(edit.rings);
    }

    /** Fits the map to EPSG:3006 rings. */
    private fitRings(rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): void {
        const ctx = this.ctx;
        if (!ctx) return;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const ring of rings) {
            for (const p of ring) {
                const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
                w = Math.min(w, lon); e = Math.max(e, lon);
                s = Math.min(s, lat); n = Math.max(n, lat);
            }
        }
        if (Number.isFinite(w)) ctx.map.fitBounds([w, s, e, n], { maxZoom: 19 });
    }

    private groupKey(edit: TerrainEdit): string {
        if (isRecipeEdit(edit)) return this.featureOf(edit) ? 'recipes' : 'away';
        if (!edit.origin) return 'hand';
        if (edit.origin in DIG_NOUNS) return this.featureOf(edit) ? edit.origin : 'away';
        if (edit.origin === 'building-pads' || edit.origin === 'road-grades') return edit.origin;
        if (edit.origin.startsWith('unity-sculpt')) return 'sculpt';
        return 'other';
    }

    /** The (loaded) course feature a generated dig came from, or a recipe shapes. */
    private featureOf(edit: TerrainEdit): { type: string; holeId?: string | null; attributes: Attributes | null } | undefined {
        const featureId = digFeatureId(edit) ?? recipeFeatureId(edit);
        if (!featureId) return undefined;
        return this.ctxSignal.get()?.features.store.items.get().find(f => f.id === featureId) as
            { type: string; holeId?: string | null; attributes: Attributes | null } | undefined;
    }

    private holeNumber(edit: TerrainEdit): number | null {
        return this.holeNumberOf(this.featureOf(edit)?.holeId);
    }

    private holeNumberOf(holeId: string | null | undefined): number | null {
        if (!holeId) return null;
        return this.ctxSignal.get()?.courseDetail.holes.get().find(h => h.id === holeId)?.number ?? null;
    }

    // ── Site scoping ────────────────────────────────────────────────────────

    /**
     * Edits are site-scoped (D-TE1: the site owns the map). Resolve like the
     * map-build UI does: the loaded course's `siteId` (set-map-area /
     * tileset.service pattern), falling back to the tileset's mapKey — which
     * IS the site id (map-style.ts contract) — when the course record hasn't
     * landed yet. Null = the course has no site (no map area picked).
     */
    siteId(): string | null {
        const ctx = this.ctx;
        if (!ctx) return null;
        return ctx.courseDetail.course.peek()?.siteId ?? ctx.tileset.mapKey.peek() ?? null;
    }

    // ── Actions (clicks, the panel, and tests) ──────────────────────────────

    /** (Re)load the site's edits. */
    async reload(): Promise<void> {
        const siteId = this.siteId();
        if (!siteId) {
            this.notice.set('This course has no site/map yet — set a map area first.');
            return;
        }
        const seq = ++this.loadSeq;
        this.loading.set(true);
        try {
            const edits = await this.editsApi.list({ siteId });
            if (seq !== this.loadSeq) return; // superseded
            this.edits.set(edits);
            this.notice.set(null);
        } catch (e) {
            if (seq !== this.loadSeq) return;
            this.notice.set(`Loading terrain edits failed: ${message(e)}`);
        } finally {
            if (seq === this.loadSeq) this.loading.set(false);
        }
    }

    /**
     * Close the draft ring and persist it as a terrain edit with the armed
     * op/params — the tool's OWN commit funnel (DrawToolService.closeDraft
     * precedent; deliberately not FeaturesService.create). Corner flags are
     * dropped: rings are plain straight-segment `{x,y}[][]` (T55a storage).
     * Chain-draw: on success drawing stays armed for the next outline.
     */
    async closeDraft(): Promise<TerrainEdit | undefined> {
        const ring = this.state.closeDraft();
        if (!ring) return undefined;
        this.cursor.set(null);
        const siteId = this.siteId();
        if (!siteId) {
            this.notice.set('This course has no site/map yet — set a map area first.');
            return undefined;
        }
        const op = this.op.peek();
        const params = op === 'plane'
            ? { featherM: this.featherM.peek(), ...(this.flat.peek() ? { flat: true } : {}) }
            : { featherM: this.featherM.peek(), radiusM: this.radiusM.peek() };
        this.saving.set(true);
        try {
            const created = await this.editsApi.create({
                siteId,
                op,
                params,
                rings: [ring.points.map(p => ({ x: p.x, y: p.y }))],
            });
            this.edits.update(list => [...list, created]);
            this.notice.set(null);
            return created;
        } catch (e) {
            this.notice.set(`Saving the terrain edit failed: ${message(e)}`);
            return undefined;
        } finally {
            this.saving.set(false);
        }
    }

    /** Toggle an edit's enabled flag (disabled edits are skipped at build time). */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return;
        try {
            const updated = await this.editsApi.update({ id, version: edit.version, enabled });
            this.edits.update(list => list.map(e => (e.id === id ? updated : e)));
        } catch (e) {
            // Version conflict (edited elsewhere) or transient failure:
            // resync from the server so the list shows current versions,
            // THEN set the notice (reload clears it on success).
            await this.reload();
            this.notice.set(`Updating the edit failed: ${message(e)}`);
        }
    }

    /**
     * Delete an edit permanently. A generated dig is marked `dig: false` on
     * its feature instead and re-dug, so the next run leaves it out too.
     */
    async remove(id: string): Promise<void> {
        const edit = this.edits.peek().find(e => e.id === id);
        if (!edit) return;
        if (this.editingId.peek() === id) this.editingId.set(null);
        const attrs = this.featureAttributes(edit);
        if (attrs !== undefined) {
            await this.redig(edit, { ...(attrs ?? {}), dig: false }, 'Marked dig: false on the feature, so it stays out');
            return;
        }
        try {
            await this.editsApi.remove({ id, version: edit.version });
            this.edits.update(list => list.filter(e => e.id !== id));
        } catch (e) {
            await this.reload(); // resync (order per setEnabled)
            this.notice.set(`Deleting the edit failed: ${message(e)}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // "Apply to terrain" (T56) — the fast re-terrain job: the server exports
    // the site's enabled edits (D-TE5 GeoJSON) → `apply-dem-edits` →
    // tile-terrain/tile-hillshade → partial install + manifest refresh,
    // reusing the map-build job plumbing (job row + progress polling).
    // ─────────────────────────────────────────────────────────────────────────

    /** True while the re-terrain job is starting/running. */
    readonly applying = new Signal(false);
    /** Human label of the running re-terrain step (panel progress line). */
    readonly applyStep = new Signal<string | null>(null);
    /** Whether "Apply to terrain" can start (no job already in flight). */
    readonly canApply = new Computed(() => !this.applying.get());

    /**
     * Start the fast re-terrain job and poll it to completion (map-build
     * polling contract). Applying with zero ENABLED edits is deliberate: it
     * re-tiles from the raw DEM, i.e. reverts previous applies. On success
     * the tile manifest has a new `generatedAt`, so new `?v=` URLs; tiles
     * carry year-long immutable cache headers, so the same URL would serve
     * stale bytes. See refreshTerrain for how the map picks them up.
     *
     * Deactivating the tool or unmounting the canvas aborts the poll
     * (abortApply): no further status requests, no tile refresh, no notice.
     */
    async applyToTerrain(): Promise<boolean> {
        const ctx = this.ctx;
        if (!ctx || this.applying.peek()) return false;
        const abort = new AbortController();
        this.applyAbort = abort;
        const signal = abort.signal;
        this.applying.set(true);
        this.notice.set(null);
        try {
            let job: MapBuildJob = await abortable(this.mapBuildApi.reTerrain({ courseId: ctx.courseId }), signal);
            this.applyStep.set(stepLabel(job));
            while (job.status === 'pending' || job.status === 'running') {
                await sleep(this.pollMs, signal);
                try {
                    job = await abortable(this.mapBuildApi.status({ jobId: job.id }), signal);
                    this.applyStep.set(stepLabel(job));
                } catch (e) {
                    if (signal.aborted) throw e;
                    // Transient poll failure: keep polling; a persistent one
                    // surfaces via the job row (or the reTerrain error path).
                }
            }
            if (job.status !== 'succeeded') {
                this.notice.set(`Applying to terrain failed: ${job.error ?? 'unknown error'}`);
                return false;
            }
            await this.refreshTerrain(ctx, signal);
            if (signal.aborted) return false;
            this.notice.set('Terrain re-tiled with the current edits.');
            return true;
        } catch (e) {
            if (signal.aborted) return false;
            this.notice.set(`Applying to terrain failed: ${message(e)}`);
            return false;
        } finally {
            if (this.applyAbort === abort) this.applyAbort = null;
            this.applying.set(false);
            this.applyStep.set(null);
        }
    }

    /**
     * Show the re-tiled terrain. A re-terrain job changes only the terrain
     * and hillshade tiles, so when the live map's layer set still matches the
     * new manifest, the terrain and hillshade sources are pointed at the new
     * `?v=` in place: no map re-init, no camera move, ortho and overlays
     * untouched. `displayedVersion` is set before the tileset reloads so the
     * editor canvas sees the live map already showing that version and skips
     * its re-init (the Clean-tool refreshOrthoTiles contract). The elevation
     * sampler is re-pointed at the new tiles, since the canvas only does that
     * on re-init.
     *
     * Falls back to the full re-init (tileset reload, camera restored) when
     * there is no live map or the manifest's layer set or zoom ranges changed.
     */
    private async refreshTerrain(ctx: ToolContext, signal: AbortSignal): Promise<void> {
        const course = await abortable(this.coursesApi.get({ id: ctx.courseId }), signal);
        const manifest = parseTileManifest(course.tileManifestJson);
        const mapKey = course.siteId ?? null;
        const prev = ctx.tileset.manifest.peek();
        const live = ctx.map.ready.peek() && ctx.map.map.peek() !== null;
        if (!manifest || !mapKey || !prev || !live
            || mapKey !== ctx.tileset.mapKey.peek()
            || !sameTerrainLayout(prev, manifest)) {
            await this.reloadTiles(ctx);
            return;
        }
        const version = deriveTileVersion(manifest.generatedAt);
        const { sources } = buildEditorStyle(mapKey, manifest, version);
        for (const id of [TERRAIN_SOURCE_ID, HILLSHADE_SOURCE_ID]) {
            const tiles = (sources[id] as { tiles?: string[] } | undefined)?.tiles;
            if (tiles?.[0]) ctx.map.setRasterTileUrl(id, tiles[0]);
        }
        ctx.map.displayedVersion.set(version);
        ctx.elevation?.configure({ mapKey, zoom: manifest.layers.terrain.maxzoom, version });
        await ctx.tileset.reload(ctx.courseId);
    }

    /**
     * Full re-init fallback: reload the tile manifest so the editor canvas
     * re-inits the map against the new `?v=`, keeping the camera where the
     * user was working (clean-tool reloadTiles pattern).
     */
    private async reloadTiles(ctx: ToolContext): Promise<void> {
        const map = ctx.map.map.peek();
        const camera = map
            ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
            : null;
        await ctx.tileset.reload(ctx.courseId);
        if (!camera) return;
        let restored = false;
        const stop = effect(() => {
            if (restored || !ctx.map.ready.get()) return;
            restored = true;
            ctx.map.map.peek()?.jumpTo(camera);
            queueMicrotask(() => stop());
        });
        // Don't leak the effect if the new map never becomes ready.
        setTimeout(() => { if (!restored) stop(); }, 15_000);
    }

    // ── Map event handling ──────────────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        // Interaction contract (map/interaction.ts): bail unless we hold the claim.
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        const draft = this.state.draft.peek();
        if (draft.length >= MIN_RING_POINTS && this.screenDistTo(draft[0], e.point) < CLOSE_RING_PX) {
            void this.closeDraft();
            return;
        }
        const p = lngLatToSweref99tm(e.lngLat);
        if (draft.length === 0) {
            // Not outlining: a click on a bunker/pond/creek/path selects it for
            // "Shape in Blender" (Shift+click starts an outline there anyway,
            // Cmd/Ctrl+click adds it to the selection or takes it out); a
            // click on open ground clears that and starts an outline.
            if (e.originalEvent?.metaKey || e.originalEvent?.ctrlKey) {
                const hit = this.hitShapeable(p);
                if (hit) this.toggleFeature(hit.id);
                return;
            }
            const hit = e.originalEvent?.shiftKey ? null : this.hitShapeable(p);
            this.selectFeature(hit?.id ?? null);
            if (hit) return;
        }
        this.state.addPoint(p);
    }

    /**
     * Rubber band: track the pointer while a draft is open. Off while any
     * mouse button is held (a pan drag), and untracked with an empty draft so
     * plain hovering never re-renders the overlay.
     */
    private onMouseMove(e: MapPointerEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        if (this.state.draft.peek().length === 0 || e.originalEvent.buttons !== 0) {
            if (this.cursor.peek() !== null) this.cursor.set(null);
            return;
        }
        const p = lngLatToSweref99tm(e.lngLat);
        const prev = this.cursor.peek();
        if (prev && prev.x === p.x && prev.y === p.y) return;
        this.cursor.set({ x: p.x, y: p.y });
    }

    /**
     * Draft keys, matching the draw tool while a ring is open: Backspace and
     * Cmd/Ctrl+Z remove the last point, Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y put it
     * back, Enter closes and saves the ring. Esc stays with onEscape. With no
     * open draft nothing is consumed.
     */
    onKeyDown(e: KeyboardEvent): void {
        if (this.ctx?.map.interactionMode.peek() !== TERRAIN_EDIT_TOOL_ID) return;
        if (isTypingTarget(e.target)) return;
        if (this.state.draft.peek().length === 0) return;
        const meta = e.metaKey || e.ctrlKey;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

        if (meta && !e.altKey && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) this.state.redoPoint();
            else this.undoPoint();
        } else if (meta && !e.altKey && key === 'y') {
            e.preventDefault();
            this.state.redoPoint();
        } else if (!meta && !e.altKey && key === 'Backspace') {
            e.preventDefault();
            this.undoPoint();
        } else if (!meta && !e.altKey && key === 'Enter') {
            if (!this.state.canClose.peek()) return;
            e.preventDefault();
            void this.closeDraft();
        }
    }

    /**
     * Drop the last draft point. Undoing the only point clears the draft but
     * keeps the tool armed (DrawState.undoPoint would disarm it; this tool is
     * always drawing).
     */
    private undoPoint(): void {
        if (this.state.undoPoint() === 'cancelled') {
            this.state.arm();
            this.cursor.set(null);
        }
    }

    /** Flat screen-pixel distance from an EPSG:3006 point to a screen position. */
    private screenDistTo(p: AnchorPoint, screen: { x: number; y: number }): number {
        const map = this.ctx?.map.map.peek();
        return map ? screenDistSweref(map, p, screen) : Infinity;
    }

    // ── Overlay flush (microtask-coalesced) ────────────────────────────────

    private scheduleRender(): void {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        queueMicrotask(() => {
            this.renderScheduled = false;
            const ctx = this.ctx;
            const renderer = this.renderer;
            if (!ctx || !renderer) return; // deactivated before the flush
            if (!ctx.map.ready.peek()) return; // map died before the flush
            renderer.render(ctx.map, this.view.peek());
        });
    }
}

/** A feature's outline as plain straight-segment EPSG:3006 rings (curves flattened). */
function featureRings(feature: CourseFeature | null): Array<Array<{ x: number; y: number }>> {
    if (!feature) return [];
    return feature.geometry.rings.map(ring =>
        flattenRing(ring, 0.25, feature.geometry.curveType).map(([x, y]) => ({ x, y })));
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function abortError(): Error {
    return new DOMException('The re-terrain poll was aborted', 'AbortError');
}

/** setTimeout as a promise; rejects (and clears the timer) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Settle with `p`, or reject as soon as `signal` aborts. The generated API
 * clients take no AbortSignal, so an in-flight request still completes on
 * the wire; the caller just stops waiting for it.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            v => { signal.removeEventListener('abort', onAbort); resolve(v); },
            e => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

/**
 * True when `next` builds the same terrain and hillshade sources as `prev`
 * apart from the tile URL version: same bounds, same zoom ranges, and the
 * same hillshade kind (baked raster vs client-side raster-dem). setTiles can
 * only swap URLs, not change any of these.
 */
function sameTerrainLayout(prev: TileManifest, next: TileManifest): boolean {
    const zooms = (l: { minzoom: number; maxzoom: number } | undefined) => (l ? `${l.minzoom}-${l.maxzoom}` : '');
    const b = (m: TileManifest) => `${m.bounds.west},${m.bounds.south},${m.bounds.east},${m.bounds.north}`;
    return b(prev) === b(next)
        && zooms(prev.layers.terrain) === zooms(next.layers.terrain)
        && zooms(prev.layers.hillshade) === zooms(next.layers.hillshade);
}

/** Progress-line label for a job's current step ("Tile terrain…"). */
function stepLabel(job: MapBuildJob): string | null {
    return job.step ? STEP_LABELS[job.step] ?? job.step : null;
}
