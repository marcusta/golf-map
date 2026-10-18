// Map rendering for the terrain-edit tool, without a maplibre-gl runtime
// import so it runs under bun test. terrain-edit-overlay.ts supplies the
// MapLibre Marker factory.
//
// Two overlays: the site's edit polygons (dashed violet outlines and faint
// fills) and what changes as you work: the highlighted edit, the features
// selected for "Shape in Blender" and the in-progress draft (ring, vertices,
// closing hint and the rubber-band segment from the last vertex to the
// pointer). Each edit also gets an op-glyph pill as a DOM marker; the editor
// style has no glyphs endpoint, so symbol text layers cannot render text.
// Violet sits outside the course-feature palette (greens, sands, blues) so an
// edit is never mistaken for a feature; disabled edits render dimmed.
//
// The live overlay also carries the reviews: "Fit edge to water" (the proposed
// edge and the lidar's water) and "Find falls" (the pieces, ponds green and
// creeks cyan, and the falls red, each with a level or drop pill).
//
// A recipe edit has no ring of its own: it is drawn on its feature (the
// view's `recipes`), filled and outlined solid in its recipe's colour with
// the recipe name in the pill, so the bunkers, ponds and creeks that have a
// recipe stand out from the ones still on the course default.
//
// A site carries hundreds of edits and ~150k outline vertices (the generated
// creek and pond digs are dense), so each outline is simplified for display,
// and with a GlyphViewport the pills exist only for the edits in view when
// zoomed in, refreshed when the map stops moving (a DOM marker is
// repositioned on every frame of a pan).
//
// Render cost per draft click or pointer move:
// - The edits overlay and the glyph markers are touched only when the
//   `edits` array changes identity. A draft click leaves them alone.
// - EPSG:3006 -> WGS84 projection is cached on object identity (the
//   geo/wgs84-cache.ts pattern): per edit ring array and per draft point.
//   DrawState.addPoint keeps earlier point objects, so a click projects one
//   new point.
// - Glyph markers are diffed by edit id: created for new edits, removed for
//   gone ones, and updated in place (text, style, position) only when the
//   edit's op, name, params, enabled flag or ring changed.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { MapService, OverlayLayerSpec } from '../map/map.service';
import type { TerrainEdit } from '../../../shared/api/terrain-edits.gen';
import type { Point } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import { rdpSimplifyClosed } from '../draw/draw-state';
import { SELECTION_COLOR } from '../draw/feature-palette';
import {
    OP_GLYPHS,
    paramsSummary,
    type TerrainEditRenderer,
    type TerrainEditView,
} from './terrain-edit-tool.service';

/** Overlay id for the persisted edits (fills and dashed outlines). */
export const TERRAIN_EDIT_OVERLAY_ID = 'terrain-edit';
/** Overlay id for what changes as you work: hover highlight, shaping selection, draft ring, its vertices and the rubber band. */
export const TERRAIN_EDIT_DRAFT_OVERLAY_ID = 'terrain-edit-draft';

/** Violet, outside the course-feature palette on purpose. */
const EDIT_COLOR = '#b653e6';
const DRAFT_COLOR = '#e879f9';
/** "Fit edge to water": the proposed edge, and the lidar's open water inside the drawn line. */
const POND_EDGE_COLOR = '#ef4444';
const POND_LIDAR_COLOR = '#facc15';
/** "Find falls": pond pieces, creek pieces and the falls (the pipeline's check-picture colours). */
const STEPS_POND_COLOR = '#3ce65a';
const STEPS_CREEK_COLOR = '#00e6e6';
const STEPS_FALL_COLOR = '#ff2828';
const GLYPH_BG = 'rgba(38, 16, 46, 0.82)';

/** Outline simplification for display, metres: invisible at any editor zoom, ~20x fewer vertices. */
const DISPLAY_TOLERANCE_M = 0.1;

// ── Projection cache ─────────────────────────────────────────────────────

/** Closed WGS84 ring per edit ring array (server rows are never mutated). */
const ringCache = new WeakMap<ReadonlyArray<{ x: number; y: number }>, Position[]>();
/** WGS84 position per draft point object (DrawState keeps point identity). */
const pointCache = new WeakMap<object, Position>();

let projections = 0;

/** EPSG:3006 -> WGS84 conversions done by this module (tests, benchmarks). */
export function terrainEditProjectionCount(): number {
    return projections;
}

/** Reset the conversion counter. The caches are WeakMaps and never cleared. */
export function resetTerrainEditProjectionCount(): void {
    projections = 0;
}

function project(p: { x: number; y: number }): Position {
    projections++;
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return [lon, lat];
}

/** One draft point as WGS84, cached on the point object. */
function pointLngLat(p: Point): Position {
    const hit = pointCache.get(p);
    if (hit) return hit;
    const out = project(p);
    pointCache.set(p, out);
    return out;
}

/** One edit ring as a closed WGS84 ring, simplified for display, cached on the ring array. */
function ringLngLat(ring: ReadonlyArray<{ x: number; y: number }>): Position[] {
    const hit = ringCache.get(ring);
    if (hit) return hit;
    const coords = rdpSimplifyClosed([...ring], DISPLAY_TOLERANCE_M).map(project);
    if (coords.length > 0) coords.push(coords[0]); // close for Polygon validity
    ringCache.set(ring, coords);
    return coords;
}

// ── GeoJSON ──────────────────────────────────────────────────────────────

/** The site's edit polygons as a WGS84 FeatureCollection. */
export function terrainEditGeojson(edits: readonly TerrainEdit[], recipes: TerrainEditView['recipes'] = {}): FeatureCollection {
    const features: Feature[] = [];
    for (const edit of edits) {
        // A recipe edit: its feature is the shape.
        const mark = edit.rings.length === 0 ? recipes[edit.id] : undefined;
        const rings = mark ? mark.rings : edit.rings;
        if (rings.length === 0) continue;
        features.push({
            type: 'Feature',
            properties: mark
                ? { role: 'recipe', enabled: edit.enabled, color: mark.color }
                : { role: 'edit', enabled: edit.enabled },
            geometry: { type: 'Polygon', coordinates: rings.map(ringLngLat) },
        });
    }
    return { type: 'FeatureCollection', features };
}

/** The rings an edit is drawn with: its own, or its feature's for a recipe edit. */
function shownRings(edit: TerrainEdit, recipes: TerrainEditView['recipes']): ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> {
    return edit.rings.length > 0 ? edit.rings : recipes[edit.id]?.rings ?? [];
}

/** The highlighted edit and the features selected for "Shape in Blender", one polygon each. */
function terrainEditMarkGeojson(view: TerrainEditView): Feature[] {
    const features: Feature[] = [];
    const highlight = view.highlightId ? view.edits.find(e => e.id === view.highlightId) : undefined;
    const highlightRings = highlight ? shownRings(highlight, view.recipes) : [];
    if (highlightRings.length > 0) {
        features.push({
            type: 'Feature',
            properties: { role: 'highlight' },
            geometry: { type: 'Polygon', coordinates: highlightRings.map(ringLngLat) },
        });
    }
    for (const rings of view.selection) {
        if (rings.length === 0) continue;
        features.push({
            type: 'Feature',
            properties: { role: 'selection' },
            geometry: { type: 'Polygon', coordinates: rings.map(ringLngLat) },
        });
    }
    if (view.pondEdge) {
        for (const [role, ring] of [['pond-lidar', view.pondEdge.lidar], ['pond-proposed', view.pondEdge.proposed]] as const) {
            if (ring.length < 3) continue;
            features.push({ type: 'Feature', properties: { role }, geometry: { type: 'LineString', coordinates: ringLngLat(ring) } });
        }
    }
    if (view.waterSteps) {
        for (const piece of view.waterSteps.pieces) {
            if (piece.ring.length < 3) continue;
            features.push({ type: 'Feature', properties: { role: `steps-${piece.kind}` }, geometry: { type: 'LineString', coordinates: ringLngLat(piece.ring) } });
        }
        for (const fall of view.waterSteps.falls) {
            if (fall.line.length < 2) continue;
            features.push({ type: 'Feature', properties: { role: 'steps-fall' }, geometry: { type: 'LineString', coordinates: fall.line.map(project) } });
        }
    }
    return features;
}

/** The live overlay's data: highlight and selection under the draft. */
export function terrainEditLiveGeojson(view: TerrainEditView, cursor: Point | null): FeatureCollection {
    const draft = terrainEditDraftGeojson(view.draft, cursor);
    const marks = terrainEditMarkGeojson(view);
    return marks.length > 0 ? { type: 'FeatureCollection', features: [...marks, ...draft.features] } : draft;
}

/**
 * Draft ring, vertices, the closing hint back to the first vertex and the
 * rubber band from the last vertex to `cursor`. Empty when there is no
 * draft: a lone cursor draws nothing.
 */
export function terrainEditDraftGeojson(draft: readonly Point[], cursor: Point | null): FeatureCollection {
    const features: Feature[] = [];
    if (draft.length === 0) return { type: 'FeatureCollection', features };
    const coords = draft.map(pointLngLat);
    if (coords.length >= 2) {
        features.push({
            type: 'Feature',
            properties: { role: 'draft-line' },
            geometry: { type: 'LineString', coordinates: coords },
        });
    }
    if (coords.length >= 3) {
        // Faint closing hint back to the first point (click it to save).
        features.push({
            type: 'Feature',
            properties: { role: 'draft-close' },
            geometry: { type: 'LineString', coordinates: [coords[coords.length - 1], coords[0]] },
        });
    }
    if (cursor) {
        features.push({
            type: 'Feature',
            properties: { role: 'draft-cursor' },
            geometry: { type: 'LineString', coordinates: [coords[coords.length - 1], project(cursor)] },
        });
    }
    coords.forEach((c, i) => {
        features.push({
            type: 'Feature',
            properties: { role: 'draft-point', first: i === 0 },
            geometry: { type: 'Point', coordinates: c },
        });
    });
    return { type: 'FeatureCollection', features };
}

/** Vertex-average centroid of an edit's outer ring (glyph marker anchor); `rings` replaces the edit's own (a recipe edit's feature). */
export function editLabelAnchor(
    edit: TerrainEdit, rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>> = edit.rings,
): { x: number; y: number } | null {
    const ring = rings[0];
    if (!ring || ring.length === 0) return null;
    let x = 0;
    let y = 0;
    for (const p of ring) {
        x += p.x;
        y += p.y;
    }
    return { x: x / ring.length, y: y / ring.length };
}

// ── Layers ───────────────────────────────────────────────────────────────

const role = (value: string): FilterSpecification => ['==', ['get', 'role'], value] as FilterSpecification;

function editLayers(): OverlayLayerSpec[] {
    const dim = (on: number, off: number) =>
        ['case', ['get', 'enabled'], on, off] as unknown as number;
    return [
        {
            id: 'terrain-edit-fill',
            type: 'fill',
            filter: role('edit'),
            paint: { 'fill-color': EDIT_COLOR, 'fill-opacity': dim(0.10, 0.04) },
        },
        {
            id: 'terrain-edit-outline',
            type: 'line',
            filter: role('edit'),
            paint: {
                'line-color': EDIT_COLOR,
                'line-width': 2.5,
                'line-dasharray': [2, 1.5],
                'line-opacity': dim(0.95, 0.4),
            },
        },
        {
            // A feature with a recipe of its own, in the recipe's colour.
            id: 'terrain-edit-recipe-fill',
            type: 'fill',
            filter: role('recipe'),
            paint: { 'fill-color': ['get', 'color'] as unknown as string, 'fill-opacity': dim(0.4, 0.12) },
        },
        {
            id: 'terrain-edit-recipe-outline',
            type: 'line',
            filter: role('recipe'),
            paint: {
                'line-color': ['get', 'color'] as unknown as string,
                'line-width': 2.5,
                'line-opacity': dim(0.95, 0.4),
            },
        },
    ];
}

function draftLayers(): OverlayLayerSpec[] {
    return [
        {
            // The edit under the pointer in the panel's list, or whose form is open.
            id: 'terrain-edit-draft-highlight',
            type: 'line',
            filter: role('highlight'),
            paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.95 },
        },
        {
            // "Fit edge to water": the lidar's open water (the inner bound) ...
            id: 'terrain-edit-pond-lidar',
            type: 'line',
            filter: role('pond-lidar'),
            paint: { 'line-color': POND_LIDAR_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 },
        },
        {
            // ... and the proposed edge (the drawn line is the pond itself, under it).
            id: 'terrain-edit-pond-proposed',
            type: 'line',
            filter: role('pond-proposed'),
            paint: { 'line-color': POND_EDGE_COLOR, 'line-width': 3, 'line-opacity': 0.95 },
        },
        {
            // "Find falls": the pieces, ponds green and creeks cyan, and the falls red over them.
            id: 'terrain-edit-steps-pond',
            type: 'line',
            filter: role('steps-pond'),
            paint: { 'line-color': STEPS_POND_COLOR, 'line-width': 2.5, 'line-opacity': 0.95 },
        },
        {
            id: 'terrain-edit-steps-creek',
            type: 'line',
            filter: role('steps-creek'),
            paint: { 'line-color': STEPS_CREEK_COLOR, 'line-width': 2.5, 'line-opacity': 0.95 },
        },
        {
            id: 'terrain-edit-steps-fall',
            type: 'line',
            filter: role('steps-fall'),
            paint: { 'line-color': STEPS_FALL_COLOR, 'line-width': 5, 'line-opacity': 0.95 },
        },
        {
            // The features selected for "Shape in Blender" (draw mode's selection yellow).
            id: 'terrain-edit-draft-selection',
            type: 'line',
            filter: role('selection'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 3, 'line-opacity': 0.95 },
        },
        {
            id: 'terrain-edit-draft-close',
            type: 'line',
            filter: role('draft-close'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 1.5, 'line-dasharray': [1, 2], 'line-opacity': 0.6 },
        },
        {
            id: 'terrain-edit-draft-cursor',
            type: 'line',
            filter: role('draft-cursor'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 2, 'line-opacity': 0.8 },
        },
        {
            id: 'terrain-edit-draft-line',
            type: 'line',
            filter: role('draft-line'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        },
        {
            id: 'terrain-edit-draft-points',
            type: 'circle',
            filter: role('draft-point'),
            paint: {
                // The first vertex is the close target, so it renders larger.
                'circle-radius': ['case', ['get', 'first'], 7, 4.5] as unknown as number,
                'circle-color': DRAFT_COLOR,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
    ];
}

// ── Glyph markers ────────────────────────────────────────────────────────

/** The subset of a MapLibre Marker the renderer uses. */
export interface GlyphMarker {
    setLngLat(lngLat: [number, number]): unknown;
    remove(): unknown;
}

/** Creates a marker for `el` at `lngLat` and adds it to the live map. */
export type GlyphMarkerFactory = (el: HTMLElement, lngLat: [number, number], map: MapService) => GlyphMarker;

/**
 * Limits the glyph pills to the camera's view. Without one, every edit gets a
 * pill (tests; a map with few edits).
 */
export interface GlyphViewport {
    /** True when a pill at `lngLat` should exist: zoomed in far enough and in view. */
    shows(map: MapService, lngLat: [number, number]): boolean;
    /** Calls `onSettle` whenever the camera stops moving; returns the unsubscribe. */
    watch(map: MapService, onSettle: () => void): () => void;
}

interface GlyphEntry {
    marker: GlyphMarker;
    el: HTMLElement;
    /** Anchor (EPSG:3006) the marker sits at. */
    anchor: { x: number; y: number };
    /** Text, title and dimming the element shows (see glyphLabel). */
    label: string;
}

/** Everything the pill element shows; a change restyles it. */
function glyphLabel(edit: TerrainEdit, name: string, color: string): string {
    return `${edit.op}|${name}|${paramsSummary(edit)}|${edit.enabled}|${color}`;
}

/** `recipeColor`: the pill of a recipe edit, solid in its recipe's colour. */
function styleGlyph(el: HTMLElement, edit: TerrainEdit, name: string, recipeColor?: string): void {
    const color = recipeColor ?? EDIT_COLOR;
    el.textContent = `${OP_GLYPHS[edit.op]} ${name}`;
    el.title = paramsSummary(edit);
    el.style.cssText =
        `background: ${GLYPH_BG}; color: ${color}; font: 600 10px/1.5 system-ui, sans-serif;` +
        `padding: 0 5px; border: 1px ${recipeColor ? 'solid' : 'dashed'} ${color}; border-radius: 4px;` +
        'pointer-events: none; white-space: nowrap;' +
        (edit.enabled ? '' : 'opacity: 0.45;');
}

function anchorLngLat(anchor: { x: number; y: number }): [number, number] {
    const [lon, lat] = project(anchor);
    return [lon, lat];
}

// ── Renderer ─────────────────────────────────────────────────────────────

/** Renders one TerrainEditView onto the editor map. See TerrainEditRenderer. */
export class TerrainEditOverlayRenderer implements TerrainEditRenderer {
    private editsAdded = false;
    private draftAdded = false;
    /** Inputs of the last flush; unchanged inputs skip their overlay. */
    private lastEdits: readonly TerrainEdit[] | null = null;
    private lastDraft: readonly Point[] | null = null;
    private lastCursor: Point | null = null;
    private lastHighlightId: string | null = null;
    private lastLabels: TerrainEditView['labels'] | null = null;
    private lastSelection: TerrainEditView['selection'] | null = null;
    private lastPondEdge: TerrainEditView['pondEdge'] = null;
    private lastWaterSteps: TerrainEditView['waterSteps'] = null;
    /** Find falls' level and drop pills (few: always shown while the proposal is). */
    private stepLabels: GlyphMarker[] = [];
    private lastRecipes: TerrainEditView['recipes'] | null = null;
    private glyphs = new Map<string, GlyphEntry>();
    /** The last view drawn, for the glyph refresh after a camera move. */
    private lastView: TerrainEditView | null = null;
    /** The map the viewport watch is on, and its unsubscribe. */
    private watching: { map: MapService; raw: unknown; stop: () => void } | null = null;
    /** Markers created over the renderer's lifetime (tests, benchmarks). */
    markersCreated = 0;

    constructor(
        private readonly createMarker: GlyphMarkerFactory,
        private readonly viewport: GlyphViewport | null = null,
    ) {}

    render(map: MapService, view: TerrainEditView): void {
        const raw = map.map.peek();
        if (!raw) return;
        this.lastView = view;

        if (this.viewport && this.watching?.raw !== raw) {
            this.watching?.stop();
            const stop = this.viewport.watch(map, () => {
                if (this.lastView) this.syncGlyphs(map, this.lastView);
            });
            this.watching = { map, raw, stop };
        }

        // Which pills exist depends on the highlight only with a viewport
        // (the highlighted edit keeps its pill at any zoom).
        const glyphsStale = view.labels !== this.lastLabels
            || (this.viewport !== null && view.highlightId !== this.lastHighlightId);
        if (!this.editsAdded) {
            map.addOverlayLayer(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits, view.recipes), editLayers());
            this.editsAdded = true;
            this.syncGlyphs(map, view);
        } else if (view.edits !== this.lastEdits || view.recipes !== this.lastRecipes) {
            map.updateOverlayData(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits, view.recipes));
            this.syncGlyphs(map, view);
        } else if (glyphsStale) {
            this.syncGlyphs(map, view);
        }

        const cursor = view.draft.length > 0 ? view.cursor : null;
        if (!this.draftAdded) {
            map.addOverlayLayer(
                TERRAIN_EDIT_DRAFT_OVERLAY_ID,
                terrainEditLiveGeojson(view, cursor),
                draftLayers(),
                { keepOnTop: true },
            );
            this.draftAdded = true;
        } else if (view.draft !== this.lastDraft || cursor !== this.lastCursor
            || view.highlightId !== this.lastHighlightId || view.selection !== this.lastSelection
            || (view.pondEdge ?? null) !== this.lastPondEdge
            || (view.waterSteps ?? null) !== this.lastWaterSteps
            || (view.highlightId !== null && (view.edits !== this.lastEdits || view.recipes !== this.lastRecipes))) {
            map.updateOverlayData(TERRAIN_EDIT_DRAFT_OVERLAY_ID, terrainEditLiveGeojson(view, cursor));
        }
        this.lastEdits = view.edits;
        this.lastDraft = view.draft;
        this.lastCursor = cursor;
        this.lastHighlightId = view.highlightId;
        this.lastLabels = view.labels;
        this.lastSelection = view.selection;
        if ((view.waterSteps ?? null) !== this.lastWaterSteps) this.syncStepLabels(map, view.waterSteps ?? null);
        this.lastPondEdge = view.pondEdge ?? null;
        this.lastWaterSteps = view.waterSteps ?? null;
        this.lastRecipes = view.recipes;
    }

    /** Find falls' pills: each piece's level (creeks top›bottom) and each fall's drop. */
    private syncStepLabels(map: MapService, mark: TerrainEditView['waterSteps']): void {
        for (const m of this.stepLabels) m.remove();
        this.stepLabels = [];
        if (!mark) return;
        const pills = [
            ...mark.pieces.map(p => ({ at: p.at, text: p.label, color: p.kind === 'pond' ? STEPS_POND_COLOR : STEPS_CREEK_COLOR })),
            ...mark.falls.map(f => ({ at: f.at, text: f.label, color: STEPS_FALL_COLOR })),
        ];
        for (const pill of pills) {
            const el = document.createElement('div');
            el.textContent = pill.text;
            el.style.cssText = `background: ${GLYPH_BG}; color: ${pill.color}; font: 600 10px/1.5 system-ui, sans-serif;`
                + `padding: 0 5px; border: 1px solid ${pill.color}; border-radius: 4px; pointer-events: none; white-space: nowrap;`;
            this.stepLabels.push(this.createMarker(el, anchorLngLat(pill.at), map));
        }
    }

    reset(): void {
        // Map destroyed: the overlays died with it. The markers are detached
        // DOM nodes now; remove() is safe and drops the references.
        this.dropGlyphs();
        this.forget();
    }

    clear(map: MapService): void {
        if (this.editsAdded) map.removeOverlayLayer(TERRAIN_EDIT_OVERLAY_ID);
        if (this.draftAdded) map.removeOverlayLayer(TERRAIN_EDIT_DRAFT_OVERLAY_ID);
        this.dropGlyphs();
        this.forget();
    }

    private forget(): void {
        this.editsAdded = false;
        this.draftAdded = false;
        this.lastEdits = null;
        this.lastDraft = null;
        this.lastCursor = null;
        this.lastHighlightId = null;
        this.lastLabels = null;
        this.lastSelection = null;
        this.lastPondEdge = null;
        this.lastWaterSteps = null;
        this.lastRecipes = null;
        this.lastView = null;
        this.watching?.stop();
        this.watching = null;
    }

    private dropGlyphs(): void {
        for (const g of this.glyphs.values()) g.marker.remove();
        this.glyphs.clear();
        for (const m of this.stepLabels) m.remove();
        this.stepLabels = [];
    }

    /**
     * Diff glyph markers against the view's edits by id. With a viewport, an
     * edit has a pill only while its anchor is in view (zoomed in), plus the
     * highlighted edit at any zoom.
     */
    private syncGlyphs(map: MapService, view: TerrainEditView): void {
        const seen = new Set<string>();
        for (const edit of view.edits) {
            const mark = edit.rings.length === 0 ? view.recipes[edit.id] : undefined;
            const anchor = editLabelAnchor(edit, mark?.rings);
            if (!anchor) continue;
            const existing = this.glyphs.get(edit.id);
            const moved = !existing || existing.anchor.x !== anchor.x || existing.anchor.y !== anchor.y;
            // Project only when the position is needed: a new pill, a moved
            // one, or the viewport test.
            const lngLat = moved || this.viewport ? anchorLngLat(anchor) : null;
            if (this.viewport && edit.id !== view.highlightId && !this.viewport.shows(map, lngLat!)) continue;
            seen.add(edit.id);
            const name = view.labels[edit.id] ?? edit.op;
            const label = glyphLabel(edit, name, mark?.color ?? '');
            const entry = existing;
            if (entry) {
                if (moved) {
                    entry.marker.setLngLat(lngLat!);
                    entry.anchor = anchor;
                }
                if (entry.label !== label) {
                    styleGlyph(entry.el, edit, name, mark?.color);
                    entry.label = label;
                }
                continue;
            }
            const el = document.createElement('div');
            styleGlyph(el, edit, name, mark?.color);
            const marker = this.createMarker(el, lngLat!, map);
            this.glyphs.set(edit.id, { marker, el, anchor, label });
            this.markersCreated++;
        }
        for (const [id, entry] of this.glyphs) {
            if (seen.has(id)) continue;
            entry.marker.remove();
            this.glyphs.delete(id);
        }
    }
}
