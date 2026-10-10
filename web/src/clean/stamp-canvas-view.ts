// Map view of one block of changed pixels of the cleaned photo (clean-tool.service.ts).
//
// The block's pixels live in a persistent 2D canvas that the map reads
// through a MapLibre CanvasSource (animate: false). The canvas starts
// transparent and only stamped pixels are ever opaque, so the photo's own
// tiles show everywhere else. A put copies one changed rectangle into the
// canvas and asks the source for one texture upload. The source and its
// raster layer are added once and stay until remove(); a style reload or a
// recreated map gets them back on the next put.
//
// With terrain on, raster layers are draped through render-to-texture tiles
// that MapLibre caches by source revision. A canvas texture update does not
// bump the revision, so each draw frees the RTT tiles under the surface.
//
// MapService has no canvas-overlay method, so this module talks to the raw
// map (`MapService.map`) and keeps its own bookkeeping. The layer goes below
// `features-fill` like the inpaint preview image overlay.

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { MapService } from '../map/map.service';

export type SurfaceCorners = [[number, number], [number, number], [number, number], [number, number]];

/** One preview block on the map. */
export interface StampSurfaceView {
    /** Replace the `w` x `h` rectangle at (`x`, `y`) with `patch` (RGBA;
     * alpha 0 lets the photo show through). */
    put(patch: Uint8ClampedArray, x: number, y: number, w: number, h: number): void;
    /** Take the source and layer off the map. Idempotent. */
    remove(): void;
}

export type StampViewFactory = (
    map: Pick<MapService, 'map' | 'ready'>,
    id: string,
    size: number,
    corners: SurfaceCorners,
) => StampSurfaceView;

/** Layer the surfaces sit under, so feature tints stay visible across them. */
export const STAMP_VIEW_BEFORE_ID = 'features-fill';

interface PlayableCanvasSource {
    play?: () => void;
    pause?: () => void;
}

interface TerrainTiles {
    _tiles?: Record<string, { tileID: { canonical: { z: number; x: number; y: number } }; rtt: unknown[] }>;
    freeRtt: () => void;
}

/** The real view: a canvas element behind a CanvasSource. */
export const canvasStampView: StampViewFactory = (mapService, id, size, corners) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    // The map instance the source was added to; a different (recreated) map
    // or a style that lost the source gets a fresh add of the same canvas.
    let addedTo: MaplibreMap | null = null;
    let removed = false;

    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    const bbox = { west: Math.min(...lngs), east: Math.max(...lngs), south: Math.min(...lats), north: Math.max(...lats) };

    const ensureOnMap = (map: MaplibreMap): void => {
        if (addedTo === map && map.getSource(id)) return;
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        map.addSource(id, { type: 'canvas', canvas, coordinates: corners, animate: false });
        map.addLayer(
            { id, type: 'raster', source: id, paint: { 'raster-fade-duration': 0 } },
            map.getLayer(STAMP_VIEW_BEFORE_ID) ? STAMP_VIEW_BEFORE_ID : undefined,
        );
        addedTo = map;
    };

    const freeDrapeUnderSurface = (map: MaplibreMap): void => {
        const tm = map.terrain?.tileManager as unknown as TerrainTiles | undefined;
        if (!tm) return;
        const tiles = tm._tiles;
        if (!tiles) {
            tm.freeRtt();
            return;
        }
        for (const key in tiles) {
            const tile = tiles[key];
            const { z, x, y } = tile.tileID.canonical;
            const n = 2 ** z;
            const tx0 = ((bbox.west + 180) / 360) * n;
            const tx1 = ((bbox.east + 180) / 360) * n;
            const ty = (lat: number) => {
                const r = (lat * Math.PI) / 180;
                return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
            };
            const ty0 = ty(bbox.north);
            const ty1 = ty(bbox.south);
            if (tx1 >= x && tx0 <= x + 1 && ty1 >= y && ty0 <= y + 1) tile.rtt = [];
        }
    };

    return {
        put(patch, x, y, w, h) {
            if (removed) return;
            // The canvas is the block's picture: keep it current even while
            // the map is away, so a re-add shows everything.
            if (g && w > 0 && h > 0) {
                g.putImageData(new ImageData(patch as Uint8ClampedArray<ArrayBuffer>, w, h), x, y);
            }
            const map = mapService.map.peek();
            if (!map || !mapService.ready.peek()) return;
            try {
                ensureOnMap(map);
                // play() + pause() is CanvasSource's one-shot upload: pause
                // runs prepare() while playing, which re-uploads the canvas.
                const source = map.getSource(id) as PlayableCanvasSource | undefined;
                source?.play?.();
                source?.pause?.();
                freeDrapeUnderSurface(map);
                map.triggerRepaint();
            } catch {
                // Map mid-teardown: the preview is decorative until bake.
            }
        },
        remove() {
            if (removed) return;
            removed = true;
            const map = addedTo;
            addedTo = null;
            if (!map) return;
            try {
                if (map.getLayer(id)) map.removeLayer(id);
                if (map.getSource(id)) map.removeSource(id);
            } catch {
                // Map already destroyed.
            }
        },
    };
};
