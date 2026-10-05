import { Computed, effect, untrack, type Signal } from '@basics/core/client/core';
import type { Hole } from '../../../shared/api/holes.gen';
import type { MapService } from '../map/map.service';
import { finiteWgs84Point, type FurnitureService } from '../furniture/furniture.service';

// Create-mode hole framing (review item 22). Lifted from the furniture
// tool, which used to frame holes privately. The editor canvas attaches it
// once per mount; `followHole` (EditorModeService) gates it.
//
// Holes carry no coordinates, so the box comes from the hole's furniture:
// tees, aim points, green center/front/back and pins. No DefaultAim or
// anchored camera solve exists on web outside the planner, so this is a
// plain fitBounds on that box.

/** WGS84 `[west, south, east, north]`. */
type HoleBounds = [number, number, number, number];

/**
 * Bbox enclosing all of a hole's placed furniture, or null when the hole
 * has none yet.
 */
export function holeFurnitureBounds(furniture: FurnitureService, holeId: string): HoleBounds | null {
    const pts: Array<{ lat: number; lon: number }> = [];
    for (const tee of furniture.tees.items.peek()) {
        const pos = tee.holeId === holeId ? finiteWgs84Point(tee.lat, tee.lon) : null;
        if (pos) pts.push(pos);
    }
    for (const aim of furniture.aims.items.peek()) {
        const pos = aim.holeId === holeId ? finiteWgs84Point(aim.lat, aim.lon) : null;
        if (pos) pts.push(pos);
    }
    const green = furniture.greenForHole(holeId);
    if (green) {
        for (const point of ['center', 'front', 'back'] as const) {
            const pos = furniture.greenPointPos(green, point);
            if (pos) pts.push(pos);
        }
        for (const pin of furniture.pins.items.peek()) {
            const pos = pin.greenId === green.id ? finiteWgs84Point(pin.lat, pin.lon) : null;
            if (pos) pts.push(pos);
        }
    }
    if (pts.length === 0) return null;
    let w = pts[0]!.lon, e = pts[0]!.lon, s = pts[0]!.lat, n = pts[0]!.lat;
    for (const p of pts) {
        if (p.lon < w) w = p.lon;
        if (p.lon > e) e = p.lon;
        if (p.lat < s) s = p.lat;
        if (p.lat > n) n = p.lat;
    }
    return [w, s, e, n];
}

interface HoleFramingDeps {
    map: Pick<MapService, 'ready' | 'fitBounds'>;
    furniture: FurnitureService;
    selectedHole: Computed<Hole | null> | Signal<Hole | null>;
    followHole: Signal<boolean>;
}

/**
 * Fit the camera to the selected hole whenever the selection changes, while
 * `followHole` is on. Returns the disposer.
 *
 * The frame key is the hole id once that hole has framable furniture. It
 * reads the furniture signals so it recomputes when a late load lands (the
 * `loading` flag flips a microtask before the tee/aim/green signals fill,
 * so keying on it left the camera at course bounds). Marker edits keep the
 * key equal to the hole id, so moving a tee does not re-frame. Turning
 * follow on re-runs the effect and frames the current hole.
 */
export function attachHoleFraming(deps: HoleFramingDeps): () => void {
    const { map, furniture, selectedHole, followHole } = deps;
    const frameKey = new Computed<string | null>(() => {
        const hole = selectedHole.get();
        if (!hole) return null;
        furniture.tees.items.get();
        furniture.aims.items.get();
        furniture.greens.get();
        furniture.pins.items.get();
        return holeFurnitureBounds(furniture, hole.id) ? hole.id : null;
    });
    return effect(() => {
        const holeId = frameKey.get();
        if (holeId === null || !followHole.get() || !map.ready.get()) return;
        untrack(() => {
            const bounds = holeFurnitureBounds(furniture, holeId);
            if (bounds) map.fitBounds(bounds);
        });
    });
}
