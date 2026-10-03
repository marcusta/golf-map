// Projected screen points of a feature's anchors and bezier handles, cached
// per (geometry identity, camera state).
//
// The select-mode hover scan runs on every buttonless mousemove. Before this
// cache it projected every anchor and handle of the selected feature per
// event, so a cursor over empty map paid the full projection cost and found
// nothing. Now the first scan after a camera change projects each point once
// into Float64Arrays and records a screen-space bbox; later scans with the
// same camera and geometry read the arrays, and a cursor outside the bbox
// (grown by the largest hit radius plus 1 px) costs one bbox test.
//
// Geometry objects are immutable in the draw state (edits return new
// objects), so a new geometry identity is a new cache entry. The camera
// state is an epoch counter that the owner bumps on the map's `move` and
// `resize` events, plus the transform's center elevation: with terrain on,
// MapLibre updates that elevation during render as DEM tiles load, with no
// `move` event, and it shifts the flat projection.
//
// The SWEREF 99 TM to WGS84 step is cached per point object (anchor or
// handle) in a WeakMap, with the source x/y recorded so a point mutated in
// place recomputes. Drag ops share untouched point objects with the
// drag-start geometry, so a drag-end rebuild re-runs the inverse projection
// only for the moved points.

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { FeatureGeometry, Point } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';

interface LngLatEntry { x: number; y: number; lng: number; lat: number }
const lngLatCache = new WeakMap<Point, LngLatEntry>();

function lngLatOf(p: Point): LngLatEntry {
    const hit = lngLatCache.get(p);
    if (hit && hit.x === p.x && hit.y === p.y) return hit;
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    const entry = { x: p.x, y: p.y, lng: lon, lat };
    lngLatCache.set(p, entry);
    return entry;
}

export interface ScreenPoints {
    /** Anchor screen xy, all rings back to back: [x0, y0, x1, y1, ...]. */
    readonly anchors: Float64Array;
    /**
     * Handle screen xy per anchor: [inX, inY, outX, outY] per point, same
     * order as `anchors`. NaN where the anchor has no such handle.
     */
    readonly handles: Float64Array;
    /** Point offset of each ring into the arrays; length rings + 1. */
    readonly ringStart: Int32Array;
    /** Bbox of every projected anchor and handle; empty when min > max. */
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
}

export interface ScreenHit {
    kind: 'anchor' | 'handle';
    which?: 'hIn' | 'hOut';
    ringIdx: number;
    idx: number;
}

type Project = (lng: number, lat: number) => { x: number; y: number };

/**
 * Flat per-point projection. map.project raycasts the terrain DEM
 * (~40 us/call); the flat transform ignores draping, which shifts a marker
 * under 1 px at course pitch and exaggeration, far below the hit radii.
 */
function flatProjector(map: MaplibreMap): Project {
    const tr = map.transform as unknown as {
        locationToScreenPoint?: (l: { lng: number; lat: number }) => { x: number; y: number };
    };
    if (tr.locationToScreenPoint) {
        const fn = tr.locationToScreenPoint.bind(tr);
        return (lng, lat) => fn({ lng, lat });
    }
    return (lng, lat) => map.project([lng, lat]);
}

export function projectGeometry(map: MaplibreMap, geometry: FeatureGeometry): ScreenPoints {
    const project = flatProjector(map);
    const rings = geometry.rings;
    const ringStart = new Int32Array(rings.length + 1);
    let n = 0;
    for (let r = 0; r < rings.length; r++) {
        ringStart[r] = n;
        n += rings[r].points.length;
    }
    ringStart[rings.length] = n;
    const anchors = new Float64Array(n * 2);
    const handles = new Float64Array(n * 4).fill(NaN);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const put = (arr: Float64Array, at: number, p: Point): void => {
        const ll = lngLatOf(p);
        const s = project(ll.lng, ll.lat);
        arr[at] = s.x;
        arr[at + 1] = s.y;
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
    };
    let k = 0;
    for (let r = 0; r < rings.length; r++) {
        const pts = rings[r].points;
        for (let i = 0; i < pts.length; i++, k++) {
            const a = pts[i];
            put(anchors, k * 2, a);
            if (a.hIn) put(handles, k * 4, a.hIn);
            if (a.hOut) put(handles, k * 4 + 2, a.hOut);
        }
    }
    return { anchors, handles, ringStart, minX, minY, maxX, maxY };
}

/**
 * Same order and radii as the uncached scan: every handle of every ring
 * first (hIn before hOut per point; handles are smaller and drawn on top),
 * then every anchor. A hit needs distance strictly below the radius.
 */
export function hitScreenPoints(
    sp: ScreenPoints,
    sx: number,
    sy: number,
    handleR: number,
    anchorR: number,
): ScreenHit | null {
    // One extra pixel keeps float rounding at the bbox edge from rejecting
    // a point the distance test would accept.
    const pad = Math.max(handleR, anchorR) + 1;
    if (!(sx > sp.minX - pad && sx < sp.maxX + pad && sy > sp.minY - pad && sy < sp.maxY + pad)) return null;
    const { anchors, handles, ringStart } = sp;
    const rings = ringStart.length - 1;
    for (let r = 0; r < rings; r++) {
        const base = ringStart[r];
        const end = ringStart[r + 1];
        for (let k = base; k < end; k++) {
            const h = k * 4;
            if (Math.hypot(handles[h] - sx, handles[h + 1] - sy) < handleR) {
                return { kind: 'handle', which: 'hIn', ringIdx: r, idx: k - base };
            }
            if (Math.hypot(handles[h + 2] - sx, handles[h + 3] - sy) < handleR) {
                return { kind: 'handle', which: 'hOut', ringIdx: r, idx: k - base };
            }
        }
    }
    for (let r = 0; r < rings; r++) {
        const base = ringStart[r];
        const end = ringStart[r + 1];
        for (let k = base; k < end; k++) {
            if (Math.hypot(anchors[k * 2] - sx, anchors[k * 2 + 1] - sy) < anchorR) {
                return { kind: 'anchor', ringIdx: r, idx: k - base };
            }
        }
    }
    return null;
}

/**
 * Screen points per geometry for one camera state. `invalidate()` on every
 * camera change; entries from an older epoch or another map rebuild on the
 * next `get`.
 */
export class ScreenPointCache {
    private epoch = 0;
    private entries = new WeakMap<
        FeatureGeometry,
        { epoch: number; map: MaplibreMap; elevation: number | undefined; sp: ScreenPoints }
    >();

    invalidate(): void {
        this.epoch++;
    }

    get(map: MaplibreMap, geometry: FeatureGeometry): ScreenPoints {
        const elevation = (map.transform as unknown as { elevation?: number }).elevation;
        const hit = this.entries.get(geometry);
        if (hit && hit.epoch === this.epoch && hit.map === map && hit.elevation === elevation) return hit.sp;
        const sp = projectGeometry(map, geometry);
        this.entries.set(geometry, { epoch: this.epoch, map, elevation, sp });
        return sp;
    }
}
