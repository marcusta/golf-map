// Map rendering for the terrain-edit tool: dashed violet outlines + faint
// fills for the site's edit polygons, an op-glyph pill per edit (DOM markers
// — the editor style has no glyphs endpoint, so symbol text layers cannot
// render text), and the in-progress draft ring. Violet is deliberately
// outside the course-feature palette (greens/sands/blues) so an edit can
// never be mistaken for a feature; disabled edits render dimmed.
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
import {
    OP_GLYPHS,
    paramsSummary,
    type TerrainEditRenderer,
    type TerrainEditView,
} from './terrain-edit-tool.service';

/** Overlay id (fills + dashed outlines + draft). */
export const TERRAIN_EDIT_OVERLAY_ID = 'terrain-edit';

/** Violet — outside the course-feature palette on purpose. */
const EDIT_COLOR = '#b653e6';
const DRAFT_COLOR = '#e879f9';
const GLYPH_BG = 'rgba(38, 16, 46, 0.82)';

const toLngLat = (p: { x: number; y: number }): Position => {
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return [lon, lat];
};

/** Edit polygons + draft ring as a WGS84 FeatureCollection. */
export function terrainEditGeojson(view: TerrainEditView): FeatureCollection {
    const features: Feature[] = [];

    for (const edit of view.edits) {
        const rings = edit.rings.map(ring => {
            const coords = ring.map(toLngLat);
            if (coords.length > 0) coords.push(coords[0]); // close for Polygon validity
            return coords;
        });
        features.push({
            type: 'Feature',
            properties: { role: 'edit', enabled: edit.enabled },
            geometry: { type: 'Polygon', coordinates: rings },
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

/** Overlay layer specs (ids prefixed with the overlay id). */
function terrainEditLayers(): OverlayLayerSpec[] {
    const role = (value: string): FilterSpecification => ['==', ['get', 'role'], value] as FilterSpecification;
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
            id: 'terrain-edit-draft-close',
            type: 'line',
            filter: role('draft-close'),
            paint: { 'line-color': DRAFT_COLOR, 'line-width': 1.5, 'line-dasharray': [1, 2], 'line-opacity': 0.6 },
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
                // The first vertex is the close target — render it larger.
                'circle-radius': ['case', ['get', 'first'], 7, 4.5] as unknown as number,
                'circle-color': DRAFT_COLOR,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
    ];
}

/** Renders one TerrainEditView onto the editor map. See TerrainEditRenderer. */
export class TerrainEditOverlayRenderer implements TerrainEditRenderer {
    private overlayAdded = false;
    private glyphMarkers: maplibregl.Marker[] = [];

    render(map: MapService, view: TerrainEditView): void {
        const raw = map.map.peek();
        if (!raw) return;

        const data = terrainEditGeojson(view);
        if (!this.overlayAdded) {
            map.addOverlayLayer(TERRAIN_EDIT_OVERLAY_ID, data, terrainEditLayers());
            this.overlayAdded = true;
        } else {
            map.updateOverlayData(TERRAIN_EDIT_OVERLAY_ID, data);
        }

        // Op glyphs: one pill marker per edit at its outer-ring centroid.
        // Rebuilt every render — the list is small and markers are cheap.
        for (const m of this.glyphMarkers) m.remove();
        this.glyphMarkers = [];
        for (const edit of view.edits) {
            const anchor = editLabelAnchor(edit);
            if (!anchor) continue;
            const el = document.createElement('div');
            el.textContent = `${OP_GLYPHS[edit.op]} ${edit.op}`;
            el.title = paramsSummary(edit);
            el.style.cssText =
                `background: ${GLYPH_BG}; color: ${EDIT_COLOR}; font: 600 10px/1.5 system-ui, sans-serif;` +
                `padding: 0 5px; border: 1px dashed ${EDIT_COLOR}; border-radius: 4px;` +
                'pointer-events: none; white-space: nowrap;' +
                (edit.enabled ? '' : 'opacity: 0.45;');
            const { lat, lon } = sweref99tmToWgs84(anchor.x, anchor.y);
            this.glyphMarkers.push(
                new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(raw),
            );
        }
    }

    reset(): void {
        // Map destroyed — the overlay died with it; markers are detached DOM
        // nodes at this point but remove() is safe and drops references.
        for (const m of this.glyphMarkers) m.remove();
        this.glyphMarkers = [];
        this.overlayAdded = false;
    }

    clear(map: MapService): void {
        if (this.overlayAdded) map.removeOverlayLayer(TERRAIN_EDIT_OVERLAY_ID);
        for (const m of this.glyphMarkers) m.remove();
        this.glyphMarkers = [];
        this.overlayAdded = false;
    }
}
