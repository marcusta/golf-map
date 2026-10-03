import type { Map as MaplibreMap } from 'maplibre-gl';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { FeatureGeometry, Point } from '../geo/bezier';
import { flatGeometry } from '../geo/flat-cache';
import { sweref99tmToWgs84 } from '../geo/transform';
import { flatProjector, type ScreenXY } from '../editor/screen-point';
import type { FeaturesService } from './features.service';
import type { ScreenPointCache } from './screen-cache';

// Snapping for the draw tool (review item 25). A draft click, the draft's
// rubber band and a vertex or handle drag snap the pointer to a visible
// neighbour's anchor within SNAP_PX, else to the nearest point on its
// outline within SNAP_PX. Cmd or Ctrl held on the pointer event turns
// snapping off for that event.
//
// Rules:
// - An anchor within the radius beats any edge within the radius. Among
//   anchors the nearest wins; among edges the nearest wins.
// - Anchors are the on-curve points: every anchor of a bezier feature, and
//   only the corner controls of a b-spline feature. A smooth b-spline
//   control lies off the curve, so snapping to it would not align outlines.
// - Edges are the flattened outline the hit-test uses (geo/flat-cache.ts at
//   HIT_FLATTEN_TOL_M, every ring including holes). For a b-spline that is
//   the chord-error flattening of the true curve, which stays within
//   0.25 m of it; at SNAP_PX on screen that difference is not visible, so
//   the true curve is not solved for.
// - The caller excludes the feature being edited (`excludeId`), and passes
//   `skip` for hidden features.
//
// Cost per pointer event: one world-space bbox test per feature against
// the flat-cache bbox (camera independent, cached per geometry), then the
// screen work for the few features whose bbox, grown by the snap radius in
// meters, contains the pointer. Those read anchors from ScreenPointCache
// and outlines from its polyline cache, both projected with the flat
// transform once per camera state. Nothing here calls map.project.

/** Snap radius in screen pixels. */
export const SNAP_PX = 8;

/** Flatten tolerance of the hit-test outline (pointInGeometry's default). */
export const HIT_FLATTEN_TOL_M = 0.25;

/**
 * Extra pixels on the world-space cull radius. The pointer's world point
 * comes from MapLibre's terrain-aware unproject while anchors use the flat
 * projection; the two differ by a few pixels with terrain on.
 */
const CULL_SLACK_PX = 4;
/** Factor on the world-space cull radius for perspective change across it. */
const CULL_FACTOR = 1.25;

export type SnapKind = 'anchor' | 'edge';

export interface SnapFeature {
    readonly id: string;
    readonly geometry: FeatureGeometry;
}

export interface SnapQuery {
    /** Pointer position in screen pixels. */
    screen: ScreenXY;
    /** Pointer position in EPSG:3006 (the event's lngLat). */
    world: Point;
    /** Cmd or Ctrl held: no snapping for this event. */
    bypass: boolean;
    /** The feature being edited; never a snap target. */
    excludeId: string | null;
    radiusPx?: number;
}

export interface SnapResult {
    kind: SnapKind;
    /** Snapped position in EPSG:3006. An anchor snap is the anchor's own x/y. */
    point: Point;
    /** Snapped position on screen (flat projection). */
    screen: ScreenXY;
    featureId: string;
    /** Screen distance from the pointer, px. */
    dist: number;
}

/**
 * Smallest screen stretch of one EPSG:3006 meter around `p`: the smaller
 * singular value of the flat projection's Jacobian there. 1 / this is the
 * largest ground distance one pixel can cover in any direction.
 */
function minPxPerMeter(project: (lng: number, lat: number) => ScreenXY, p: Point): number {
    const at = (x: number, y: number): ScreenXY => {
        const { lat, lon } = sweref99tmToWgs84(x, y);
        return project(lon, lat);
    };
    const o = at(p.x, p.y);
    const e = at(p.x + 1, p.y);
    const n = at(p.x, p.y + 1);
    const a = e.x - o.x, b = n.x - o.x, c = e.y - o.y, d = n.y - o.y;
    const s = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    const disc = Math.sqrt(Math.max(0, s * s - 4 * det * det));
    return Math.sqrt(Math.max(0, (s - disc) / 2));
}

/**
 * Nearest anchor within the radius, else the nearest outline point within
 * it, over `features` minus `excludeId` and anything `skip` rejects. Null
 * when `bypass` is set or nothing is in range. A distance equal to the
 * radius snaps.
 */
export function resolveSnap(
    features: readonly SnapFeature[],
    q: SnapQuery,
    map: MaplibreMap,
    screenPoints: ScreenPointCache,
    skip?: (f: SnapFeature) => boolean,
): SnapResult | null {
    if (q.bypass) return null;
    const r = q.radiusPx ?? SNAP_PX;
    const sx = q.screen.x, sy = q.screen.y;
    const pxPerM = minPxPerMeter(flatProjector(map), q.world);
    const cullM = pxPerM > 0 && Number.isFinite(pxPerM) ? ((r + CULL_SLACK_PX) / pxPerM) * CULL_FACTOR : Infinity;
    const wx = q.world.x, wy = q.world.y;
    const pad = r + 1;

    let anchor: SnapResult | null = null;
    let edge: SnapResult | null = null;

    for (let f = 0; f < features.length; f++) {
        const feature = features[f];
        if (feature.id === q.excludeId) continue;
        const geometry = feature.geometry;
        if (geometry.rings.length === 0) continue;
        const flat = flatGeometry(geometry, HIT_FLATTEN_TOL_M);
        const bb = flat.bbox;
        if (!bb || wx < bb.minX - cullM || wx > bb.maxX + cullM || wy < bb.minY - cullM || wy > bb.maxY + cullM) continue;
        if (skip?.(feature)) continue;

        // Screen bbox of anchors and handles contains the curve (convex
        // hull property of bezier segments and of b-spline controls).
        const sp = screenPoints.get(map, geometry);
        if (!(sx >= sp.minX - pad && sx <= sp.maxX + pad && sy >= sp.minY - pad && sy <= sp.maxY + pad)) continue;

        const spline = geometry.curveType === 'bspline';
        const { anchors, ringStart } = sp;
        for (let ri = 0; ri < geometry.rings.length; ri++) {
            const pts = geometry.rings[ri].points;
            const base = ringStart[ri];
            for (let i = 0; i < pts.length; i++) {
                if (spline && !pts[i].corner) continue;
                const k = (base + i) * 2;
                const d = Math.hypot(anchors[k] - sx, anchors[k + 1] - sy);
                if (d <= r && (!anchor || d < anchor.dist)) {
                    anchor = {
                        kind: 'anchor',
                        point: { x: pts[i].x, y: pts[i].y },
                        screen: { x: anchors[k], y: anchors[k + 1] },
                        featureId: feature.id,
                        dist: d,
                    };
                }
            }
        }
        // Edges matter only while no anchor is in range.
        if (anchor) continue;

        for (let ri = 0; ri < flat.rings.length; ri++) {
            const ring = flat.rings[ri];
            const n = ring.pts.length;
            if (n < 2) continue;
            const xy = screenPoints.polyline(map, ring.pts);
            for (let i = 0; i < n; i++) {
                const j = i + 1 === n ? 0 : i + 1;
                const ax = xy[i * 2], ay = xy[i * 2 + 1];
                const bx = xy[j * 2], by = xy[j * 2 + 1];
                // Segment bbox test before the projection math.
                if ((ax < sx - r && bx < sx - r) || (ax > sx + r && bx > sx + r)
                    || (ay < sy - r && by < sy - r) || (ay > sy + r && by > sy + r)) continue;
                const dx = bx - ax, dy = by - ay;
                const len2 = dx * dx + dy * dy;
                let t = len2 > 0 ? ((sx - ax) * dx + (sy - ay) * dy) / len2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const px = ax + t * dx, py = ay + t * dy;
                const d = Math.hypot(px - sx, py - sy);
                if (d <= r && (!edge || d < edge.dist)) {
                    const p0 = ring.pts[i], p1 = ring.pts[j];
                    edge = {
                        kind: 'edge',
                        // Screen t on the world segment: the flat projection
                        // is near-affine across one flattened segment.
                        point: { x: p0[0] + t * (p1[0] - p0[0]), y: p0[1] + t * (p1[1] - p0[1]) },
                        screen: { x: px, y: py },
                        featureId: feature.id,
                        dist: d,
                    };
                }
            }
        }
    }
    return anchor ?? edge;
}

/** What `snapPointer` reads from the draw tool. */
export interface DrawSnapHost {
    readonly features: FeaturesService | null;
    readonly map: MaplibreMap | null;
    readonly screenPoints: ScreenPointCache;
}

/** The pointer fields snapping reads (MapPointerEvent and MapMouseEvent both fit). */
export interface SnapPointerEvent {
    point: ScreenXY;
    originalEvent: { metaKey: boolean; ctrlKey: boolean };
}

/** True when the event carries the snap bypass modifier (Cmd or Ctrl). */
export function snapBypassed(e: SnapPointerEvent): boolean {
    return e.originalEvent.metaKey || e.originalEvent.ctrlKey;
}

/**
 * Snap `world` (the event's EPSG:3006 position) against the visible
 * features of the draw tool's store, excluding `excludeId`. Null when the
 * tool has no map or store, the modifier is held, or nothing is in range.
 */
export function snapPointer(
    host: DrawSnapHost,
    e: SnapPointerEvent,
    world: Point,
    excludeId: string | null,
): SnapResult | null {
    const map = host.map;
    const features = host.features;
    if (!map || !features) return null;
    const bypass = snapBypassed(e);
    if (bypass) return null;
    const hiddenTypes = features.hiddenTypes.peek();
    const hiddenIds = features.hiddenIds.peek();
    const hiddenSources = features.hiddenSources.peek();
    const skip = (f: SnapFeature): boolean => {
        const cf = f as CourseFeature;
        return hiddenTypes.has(cf.type) || hiddenIds.has(cf.id)
            || (cf.source !== null && hiddenSources.has(cf.source));
    };
    return resolveSnap(
        features.stackTopDown.peek(),
        { screen: e.point, world, bypass, excludeId },
        map,
        host.screenPoints,
        skip,
    );
}

/** The marker the preview overlay draws at a snapped point. */
export interface SnapMarker {
    kind: SnapKind;
    point: Point;
    /** 'draft': drawn while armed. 'drag': drawn during a vertex or handle drag. */
    scope: 'draft' | 'drag';
}

/** Marker for a snap result, or null; equal inputs give an equal marker. */
export function snapMarkerOf(snap: SnapResult | null, scope: SnapMarker['scope']): SnapMarker | null {
    return snap ? { kind: snap.kind, point: snap.point, scope } : null;
}

/** True when two markers draw the same thing. */
export function sameSnapMarker(a: SnapMarker | null, b: SnapMarker | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.kind === b.kind && a.scope === b.scope && a.point.x === b.point.x && a.point.y === b.point.y;
}
