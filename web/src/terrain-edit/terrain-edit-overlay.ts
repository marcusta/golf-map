// MapLibre wiring for the terrain-edit renderer. The renderer itself
// (terrain-edit-render.ts) has no maplibre-gl runtime import so it runs under
// bun test; this module supplies the DOM Marker factory and cannot load
// there. terrain-edit-tool.ts imports it (analysis-overlay pattern).

import maplibregl from 'maplibre-gl';
import { TerrainEditOverlayRenderer, type GlyphMarkerFactory, type GlyphViewport } from './terrain-edit-render';

export { TERRAIN_EDIT_OVERLAY_ID, TERRAIN_EDIT_DRAFT_OVERLAY_ID } from './terrain-edit-render';

const createMarker: GlyphMarkerFactory = (el, lngLat, map) => {
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat);
    const raw = map.map.peek();
    if (raw) marker.addTo(raw);
    return marker;
};

/** The glyph pills show from this zoom (below it the whole course is in view and they only clutter). */
const LABEL_MIN_ZOOM = 17;

const viewport: GlyphViewport = {
    shows(map, lngLat) {
        const raw = map.map.peek();
        return !!raw && raw.getZoom() >= LABEL_MIN_ZOOM && raw.getBounds().contains(lngLat);
    },
    watch(map, onSettle) {
        const raw = map.map.peek();
        if (!raw) return () => {};
        raw.on('moveend', onSettle);
        return () => { raw.off('moveend', onSettle); };
    },
};

/** The renderer with MapLibre DOM markers for the op glyphs, limited to the edits in view. */
export function createTerrainEditRenderer(): TerrainEditOverlayRenderer {
    return new TerrainEditOverlayRenderer(createMarker, viewport);
}
