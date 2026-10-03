// Map rendering for the terrain-edit tool, without a maplibre-gl runtime
// import so it runs under bun test. terrain-edit-overlay.ts supplies the
// MapLibre Marker factory.
//
// Two overlays: the site's edit polygons (dashed violet outlines and faint
// fills) and the in-progress draft (ring, vertices, closing hint and the
// rubber-band segment from the last vertex to the pointer). Each edit also
// gets an op-glyph pill as a DOM marker; the editor style has no glyphs
// endpoint, so symbol text layers cannot render text. Violet sits outside
// the course-feature palette (greens, sands, blues) so an edit is never
// mistaken for a feature; disabled edits render dimmed.
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
//   edit's op, params, enabled flag or ring changed.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { MapService, OverlayLayerSpec } from '../map/map.service';
import type { TerrainEdit } from '../../../shared/api/terrain-edits.gen';
import type { Point } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import {
    OP_GLYPHS,
    paramsSummary,
    type TerrainEditRenderer,
    type TerrainEditView,
} from './terrain-edit-tool.service';

/** Overlay id for the persisted edits (fills and dashed outlines). */
export const TERRAIN_EDIT_OVERLAY_ID = 'terrain-edit';
/** Overlay id for the draft ring, its vertices and the rubber band. */
export const TERRAIN_EDIT_DRAFT_OVERLAY_ID = 'terrain-edit-draft';

/** Violet, outside the course-feature palette on purpose. */
const EDIT_COLOR = '#b653e6';
const DRAFT_COLOR = '#e879f9';
const GLYPH_BG = 'rgba(38, 16, 46, 0.82)';

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

/** One edit ring as a closed WGS84 ring, cached on the ring array. */
function ringLngLat(ring: ReadonlyArray<{ x: number; y: number }>): Position[] {
    const hit = ringCache.get(ring);
    if (hit) return hit;
    const coords = ring.map(project);
    if (coords.length > 0) coords.push(coords[0]); // close for Polygon validity
    ringCache.set(ring, coords);
    return coords;
}

// ── GeoJSON ──────────────────────────────────────────────────────────────

/** The site's edit polygons as a WGS84 FeatureCollection. */
export function terrainEditGeojson(edits: readonly TerrainEdit[]): FeatureCollection {
    const features: Feature[] = edits.map(edit => ({
        type: 'Feature',
        properties: { role: 'edit', enabled: edit.enabled },
        geometry: { type: 'Polygon', coordinates: edit.rings.map(ringLngLat) },
    }));
    return { type: 'FeatureCollection', features };
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

/** Vertex-average centroid of an edit's outer ring (glyph marker anchor). */
export function editLabelAnchor(edit: TerrainEdit): { x: number; y: number } | null {
    const ring = edit.rings[0];
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
    ];
}

function draftLayers(): OverlayLayerSpec[] {
    return [
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

interface GlyphEntry {
    marker: GlyphMarker;
    el: HTMLElement;
    /** Anchor (EPSG:3006) the marker sits at. */
    anchor: { x: number; y: number };
    /** Text, title and dimming the element shows (see glyphLabel). */
    label: string;
}

/** Everything the pill element shows; a change restyles it. */
function glyphLabel(edit: TerrainEdit): string {
    return `${edit.op}|${paramsSummary(edit)}|${edit.enabled}`;
}

function styleGlyph(el: HTMLElement, edit: TerrainEdit): void {
    el.textContent = `${OP_GLYPHS[edit.op]} ${edit.op}`;
    el.title = paramsSummary(edit);
    el.style.cssText =
        `background: ${GLYPH_BG}; color: ${EDIT_COLOR}; font: 600 10px/1.5 system-ui, sans-serif;` +
        `padding: 0 5px; border: 1px dashed ${EDIT_COLOR}; border-radius: 4px;` +
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
    private glyphs = new Map<string, GlyphEntry>();
    /** Markers created over the renderer's lifetime (tests, benchmarks). */
    markersCreated = 0;

    constructor(private readonly createMarker: GlyphMarkerFactory) {}

    render(map: MapService, view: TerrainEditView): void {
        if (!map.map.peek()) return;

        if (!this.editsAdded) {
            map.addOverlayLayer(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits), editLayers());
            this.editsAdded = true;
            this.syncGlyphs(map, view.edits);
        } else if (view.edits !== this.lastEdits) {
            map.updateOverlayData(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits));
            this.syncGlyphs(map, view.edits);
        }
        this.lastEdits = view.edits;

        const cursor = view.draft.length > 0 ? view.cursor : null;
        if (!this.draftAdded) {
            map.addOverlayLayer(
                TERRAIN_EDIT_DRAFT_OVERLAY_ID,
                terrainEditDraftGeojson(view.draft, cursor),
                draftLayers(),
                { keepOnTop: true },
            );
            this.draftAdded = true;
        } else if (view.draft !== this.lastDraft || cursor !== this.lastCursor) {
            map.updateOverlayData(TERRAIN_EDIT_DRAFT_OVERLAY_ID, terrainEditDraftGeojson(view.draft, cursor));
        }
        this.lastDraft = view.draft;
        this.lastCursor = cursor;
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
    }

    private dropGlyphs(): void {
        for (const g of this.glyphs.values()) g.marker.remove();
        this.glyphs.clear();
    }

    /** Diff glyph markers against `edits` by id. */
    private syncGlyphs(map: MapService, edits: readonly TerrainEdit[]): void {
        const seen = new Set<string>();
        for (const edit of edits) {
            const anchor = editLabelAnchor(edit);
            if (!anchor) continue;
            seen.add(edit.id);
            const label = glyphLabel(edit);
            const entry = this.glyphs.get(edit.id);
            if (entry) {
                if (entry.anchor.x !== anchor.x || entry.anchor.y !== anchor.y) {
                    entry.marker.setLngLat(anchorLngLat(anchor));
                    entry.anchor = anchor;
                }
                if (entry.label !== label) {
                    styleGlyph(entry.el, edit);
                    entry.label = label;
                }
                continue;
            }
            const el = document.createElement('div');
            styleGlyph(el, edit);
            const marker = this.createMarker(el, anchorLngLat(anchor), map);
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
