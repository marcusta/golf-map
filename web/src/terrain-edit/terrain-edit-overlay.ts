// Map rendering for the terrain-edit tool: dashed violet outlines + faint
// fills for the site's edit polygons, an op-glyph pill per edit (DOM markers
// — the editor style has no glyphs endpoint, so symbol text layers cannot
// render text), and the in-progress draft ring. Violet is deliberately
// outside the course-feature palette (greens/sands/blues) so an edit can
// never be mistaken for a feature; disabled edits render dimmed.
//
// Speed: a site carries hundreds of edits and ~150k outline vertices (the
// generated creek and pond digs are dense). So the edits live in their own
// source, re-sent only when the edit list changes, each edit's outline
// simplified and projected once (cached by edit object); the hover
// highlight, the shaping selection and the draft go in a small second
// source; and the glyph pills exist only for the edits in view when zoomed
// in, refreshed when the map stops moving (a DOM marker is repositioned on
// every frame of a pan).
//
// This module imports maplibre-gl (Marker) and therefore cannot load under
// bun test — the tool service only knows the TerrainEditRenderer interface;
// terrain-edit-tool.ts wires this implementation in (analysis-overlay
// pattern).

import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { MapService, OverlayLayerSpec } from '../map/map.service';
import type { TerrainEdit } from '../../../shared/api/terrain-edits.gen';
import { sweref99tmToWgs84 } from '../geo/transform';
import { rdpSimplifyClosed } from '../draw/draw-state';
import { SELECTION_COLOR } from '../draw/feature-palette';
import {
    OP_GLYPHS,
    paramsSummary,
    type TerrainEditRenderer,
    type TerrainEditView,
} from './terrain-edit-tool.service';

/** Overlay id of the edits (fills + dashed outlines). */
export const TERRAIN_EDIT_OVERLAY_ID = 'terrain-edit';
/** Overlay id of what changes as you work: hover highlight, shaping selection, draft. */
export const TERRAIN_EDIT_LIVE_OVERLAY_ID = 'terrain-edit-live';

/** Violet — outside the course-feature palette on purpose. */
const EDIT_COLOR = '#b653e6';
const DRAFT_COLOR = '#e879f9';
const GLYPH_BG = 'rgba(38, 16, 46, 0.82)';

/** Outline simplification for display, metres: invisible at any editor zoom, ~20× fewer vertices. */
const DISPLAY_TOLERANCE_M = 0.1;
/** The glyph pills show from this zoom (below it the whole course is in view and they only clutter). */
const LABEL_MIN_ZOOM = 17;

type Ring = ReadonlyArray<{ x: number; y: number }>;

const toLngLat = (p: { x: number; y: number }): Position => {
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return [lon, lat];
};

/** A ring as a closed WGS84 coordinate ring. */
function closedRing(ring: Ring): Position[] {
    const coords = ring.map(toLngLat);
    if (coords.length > 0) coords.push(coords[0]); // close for Polygon validity
    return coords;
}

/** Each edit's display outline, simplified and projected once (edits are replaced, never mutated, on change). */
const outlineCache = new WeakMap<TerrainEdit, Position[][]>();

function editOutline(edit: TerrainEdit): Position[][] {
    let rings = outlineCache.get(edit);
    if (!rings) {
        rings = edit.rings.map(ring => closedRing(rdpSimplifyClosed([...ring], DISPLAY_TOLERANCE_M)));
        outlineCache.set(edit, rings);
    }
    return rings;
}

/** The edit polygons as a WGS84 FeatureCollection. */
export function terrainEditGeojson(edits: readonly TerrainEdit[]): FeatureCollection {
    const features: Feature[] = [];
    for (const edit of edits) {
        if (edit.rings.length === 0) continue; // a recipe edit: its feature is the shape
        features.push({
            type: 'Feature',
            properties: { role: 'edit', enabled: edit.enabled },
            geometry: { type: 'Polygon', coordinates: editOutline(edit) },
        });
    }
    return { type: 'FeatureCollection', features };
}

/** The highlighted edit, the shaping selection and the draft ring as a WGS84 FeatureCollection. */
export function terrainEditLiveGeojson(view: TerrainEditView): FeatureCollection {
    const features: Feature[] = [];

    const highlight = view.highlightId ? view.edits.find(e => e.id === view.highlightId) : undefined;
    if (highlight && highlight.rings.length > 0) {
        features.push({
            type: 'Feature',
            properties: { role: 'highlight' },
            geometry: { type: 'Polygon', coordinates: editOutline(highlight) },
        });
    }

    // The features selected for "Shape in Blender", one polygon each.
    for (const rings of view.selection) {
        if (rings.length === 0) continue;
        features.push({
            type: 'Feature',
            properties: { role: 'selection' },
            geometry: { type: 'Polygon', coordinates: rings.map(closedRing) },
        });
    }

    const draft = view.draft;
    if (draft.length >= 2) {
        features.push({
            type: 'Feature',
            properties: { role: 'draft-line' },
            geometry: { type: 'LineString', coordinates: draft.map(toLngLat) },
        });
    }
    if (draft.length >= 3) {
        // Faint closing hint back to the first point (click it to save).
        features.push({
            type: 'Feature',
            properties: { role: 'draft-close' },
            geometry: {
                type: 'LineString',
                coordinates: [toLngLat(draft[draft.length - 1]), toLngLat(draft[0])],
            },
        });
    }
    draft.forEach((p, i) => {
        features.push({
            type: 'Feature',
            properties: { role: 'draft-point', first: i === 0 },
            geometry: { type: 'Point', coordinates: toLngLat(p) },
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

const role = (value: string): FilterSpecification => ['==', ['get', 'role'], value] as FilterSpecification;

/** The edits overlay's layer specs (ids prefixed with the overlay id). */
function terrainEditLayers(): OverlayLayerSpec[] {
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

/** The live overlay's layer specs. */
function terrainEditLiveLayers(): OverlayLayerSpec[] {
    return [
        {
            // The edit under the pointer in the panel's list, or whose form is open.
            id: 'terrain-edit-live-highlight',
            type: 'line',
            filter: role('highlight'),
            paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.95 },
        },
        {
            // The features selected for "Shape in Blender" (draw mode's selection yellow).
            id: 'terrain-edit-live-selection',
            type: 'line',
            filter: role('selection'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 3, 'line-opacity': 0.95 },
        },
        {
            id: 'terrain-edit-live-draft-close',
            type: 'line',
            filter: role('draft-close'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 1.5, 'line-dasharray': [1, 2], 'line-opacity': 0.6 },
        },
        {
            id: 'terrain-edit-live-draft-line',
            type: 'line',
            filter: role('draft-line'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        },
        {
            id: 'terrain-edit-live-draft-points',
            type: 'circle',
            filter: role('draft-point'),
            paint: {
                // The first vertex is the close target — render it larger.
                'circle-radius': ['case', ['get', 'first'], 7, 4.5] as unknown as number,
                'circle-color': DRAFT_COLOR,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
    ];
}

/** One glyph pill on the map, kept while its edit stays in view. */
interface GlyphMarker {
    marker: maplibregl.Marker;
    el: HTMLElement;
}

/** Renders one TerrainEditView onto the editor map. See TerrainEditRenderer. */
export class TerrainEditOverlayRenderer implements TerrainEditRenderer {
    private overlayAdded = false;
    /** The edit list last sent to the edits source (same array = nothing to send). */
    private sentEdits: readonly TerrainEdit[] | null = null;
    private glyphMarkers = new Map<string, GlyphMarker>();
    /** The last view drawn, for the glyph refresh after a camera move. */
    private lastView: TerrainEditView | null = null;
    /** The map the moveend listener is on, and the listener. */
    private listening: { map: maplibregl.Map; onMoveEnd: () => void } | null = null;

    render(map: MapService, view: TerrainEditView): void {
        const raw = map.map.peek();
        if (!raw) return;
        this.lastView = view;

        const live = terrainEditLiveGeojson(view);
        if (!this.overlayAdded) {
            map.addOverlayLayer(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits), terrainEditLayers());
            map.addOverlayLayer(TERRAIN_EDIT_LIVE_OVERLAY_ID, live, terrainEditLiveLayers());
            this.overlayAdded = true;
            this.sentEdits = view.edits;
        } else {
            if (view.edits !== this.sentEdits) {
                map.updateOverlayData(TERRAIN_EDIT_OVERLAY_ID, terrainEditGeojson(view.edits));
                this.sentEdits = view.edits;
            }
            map.updateOverlayData(TERRAIN_EDIT_LIVE_OVERLAY_ID, live);
        }

        if (this.listening?.map !== raw) {
            this.unlisten();
            const onMoveEnd = () => { if (this.lastView) this.syncGlyphs(raw, this.lastView); };
            raw.on('moveend', onMoveEnd);
            this.listening = { map: raw, onMoveEnd };
        }
        this.syncGlyphs(raw, view);
    }

    /**
     * Op glyphs: one pill marker per edit whose anchor is in view (zoomed in
     * to LABEL_MIN_ZOOM), plus the highlighted edit's at any zoom. Markers
     * are kept across refreshes and only their text and dimming updated.
     */
    private syncGlyphs(raw: maplibregl.Map, view: TerrainEditView): void {
        const wanted = new Map<string, { edit: TerrainEdit; lngLat: [number, number] }>();
        const zoomedIn = raw.getZoom() >= LABEL_MIN_ZOOM;
        const bounds = raw.getBounds();
        for (const edit of view.edits) {
            if (!zoomedIn && edit.id !== view.highlightId) continue;
            const anchor = editLabelAnchor(edit);
            if (!anchor) continue;
            const { lat, lon } = sweref99tmToWgs84(anchor.x, anchor.y);
            if (edit.id !== view.highlightId && !bounds.contains([lon, lat])) continue;
            wanted.set(edit.id, { edit, lngLat: [lon, lat] });
        }

        for (const [id, glyph] of this.glyphMarkers) {
            if (wanted.has(id)) continue;
            glyph.marker.remove();
            this.glyphMarkers.delete(id);
        }
        for (const [id, { edit, lngLat }] of wanted) {
            let glyph = this.glyphMarkers.get(id);
            if (!glyph) {
                const el = document.createElement('div');
                el.style.cssText =
                    `background: ${GLYPH_BG}; color: ${EDIT_COLOR}; font: 600 10px/1.5 system-ui, sans-serif;` +
                    `padding: 0 5px; border: 1px dashed ${EDIT_COLOR}; border-radius: 4px;` +
                    'pointer-events: none; white-space: nowrap;';
                glyph = { el, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(raw) };
                this.glyphMarkers.set(id, glyph);
            } else {
                glyph.marker.setLngLat(lngLat);
            }
            const text = `${OP_GLYPHS[edit.op]} ${view.labels[edit.id] ?? edit.op}`;
            if (glyph.el.textContent !== text) glyph.el.textContent = text;
            glyph.el.title = paramsSummary(edit);
            glyph.el.style.opacity = edit.enabled ? '' : '0.45';
        }
    }

    private removeGlyphs(): void {
        for (const { marker } of this.glyphMarkers.values()) marker.remove();
        this.glyphMarkers.clear();
    }

    private unlisten(): void {
        if (!this.listening) return;
        this.listening.map.off('moveend', this.listening.onMoveEnd);
        this.listening = null;
    }

    reset(): void {
        // Map destroyed — the overlays died with it; markers are detached DOM
        // nodes at this point but remove() is safe and drops references.
        this.removeGlyphs();
        this.unlisten();
        this.overlayAdded = false;
        this.sentEdits = null;
        this.lastView = null;
    }

    clear(map: MapService): void {
        if (this.overlayAdded) {
            map.removeOverlayLayer(TERRAIN_EDIT_LIVE_OVERLAY_ID);
            map.removeOverlayLayer(TERRAIN_EDIT_OVERLAY_ID);
        }
        this.removeGlyphs();
        this.unlisten();
        this.overlayAdded = false;
        this.sentEdits = null;
        this.lastView = null;
    }
}
