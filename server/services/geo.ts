import { Type, type Static } from '@sinclair/typebox';

// ============================================================================
// Feature geometry types (Bezier/B-spline paths in projected CRS)
// ============================================================================

export const PointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
});

export const AnchorPointSchema = Type.Object({
    x: Type.Number(),
    y: Type.Number(),
    hIn: Type.Optional(PointSchema),
    hOut: Type.Optional(PointSchema),
    /**
     * B-spline corner flag (meaningful when the geometry's curveType is
     * 'bspline'): the control point is triplicated during expansion, which
     * forces the curve through it as a sharp corner. Ignored for bezier.
     */
    corner: Type.Optional(Type.Boolean()),
});

export const PathRingSchema = Type.Object({
    points: Type.Array(AnchorPointSchema),
});

/** Curve interpretation of a geometry's rings. Absent = 'bezier' (legacy). */
export const CurveTypeSchema = Type.Union([Type.Literal('bezier'), Type.Literal('bspline')]);

export const FeatureGeometrySchema = Type.Object({
    crs: Type.String(),
    /**
     * 'bezier' (default when absent): ring points are anchors ON the curve
     * with optional cubic handles. 'bspline': ring points are CONTROL
     * points of a closed uniform cubic B-spline — they pull the curve but
     * don't lie on it (except corner points).
     */
    curveType: Type.Optional(CurveTypeSchema),
    rings: Type.Array(PathRingSchema),
});

export type Point = Static<typeof PointSchema>;
export type AnchorPoint = Static<typeof AnchorPointSchema>;
export type PathRing = Static<typeof PathRingSchema>;
export type CurveType = Static<typeof CurveTypeSchema>;
export type FeatureGeometry = Static<typeof FeatureGeometrySchema>;

// ============================================================================
// B-spline → bezier conversion
//
// A 'bspline' ring is a CLOSED uniform cubic B-spline over the ring's
// points (control points). Each window of 4 consecutive controls p0..p3
// yields one cubic bezier segment:
//
//   start = (p0 + 4·p1 + p2) / 6      cp1 = (2·p1 + p2) / 3
//   end   = (p1 + 4·p2 + p3) / 6      cp2 = (p1 + 2·p2) / 3
//
// The loop closes by wrapping the control window modulo n, producing
// exactly n segments for n (expanded) controls. A point marked `corner` is
// triplicated in the control array (knot multiplicity 3), which forces the
// curve through it with a tangent discontinuity — a sharp corner.
// ============================================================================

/** Expand control points: corner points are triplicated (multiplicity 3). */
export function expandBsplineControls(points: AnchorPoint[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        out.push({ x: p.x, y: p.y });
        if (p.corner) out.push({ x: p.x, y: p.y }, { x: p.x, y: p.y });
    }
    return out;
}

/**
 * Convert a closed b-spline control ring into the exactly equivalent
 * bezier PathRing (n anchors with hIn/hOut, one per expanded control).
 * The result flattens/renders with the existing bezier machinery.
 */
export function bsplineRingToBezier(ring: PathRing): PathRing {
    const ctrl = expandBsplineControls(ring.points);
    const n = ctrl.length;
    if (n < 3) return { points: ctrl.map(p => ({ x: p.x, y: p.y })) };

    const anchors: AnchorPoint[] = [];
    for (let i = 0; i < n; i++) {
        const p0 = ctrl[i];
        const p1 = ctrl[(i + 1) % n];
        const p2 = ctrl[(i + 2) % n];
        anchors.push({
            x: (p0.x + 4 * p1.x + p2.x) / 6,
            y: (p0.y + 4 * p1.y + p2.y) / 6,
            hOut: { x: (2 * p1.x + p2.x) / 3, y: (2 * p1.y + p2.y) / 3 },
        });
    }
    // Segment i ends at anchor (i+1): its second control point is that
    // anchor's incoming handle.
    for (let i = 0; i < n; i++) {
        const p1 = ctrl[(i + 1) % n];
        const p2 = ctrl[(i + 2) % n];
        anchors[(i + 1) % n].hIn = { x: (p1.x + 2 * p2.x) / 3, y: (p1.y + 2 * p2.y) / 3 };
    }
    return { points: anchors };
}

// ============================================================================
// Bezier flattening
// ============================================================================

/**
 * Flattens a closed PathRing (anchor points with optional cubic bezier
 * handles) into a polyline of plain [x, y] points in the ring's own
 * coordinate space. The returned polyline is NOT explicitly closed (the
 * caller decides whether to repeat the first point).
 *
 * Segments where neither endpoint has an outgoing/incoming handle are
 * treated as straight lines (no subdivision needed). Segments with handles
 * are subdivided into N pieces, where N is derived from the control-polygon
 * length divided by the tolerance (a cheap, standard adaptive heuristic —
 * the control polygon length is always >= the curve's true length, so this
 * slightly over-subdivides rather than under-subdivides).
 *
 * When `curveType` is 'bspline' the ring's points are B-spline CONTROL
 * points: the ring is first converted to its exact bezier equivalent
 * (corner triplication + closed wrap), then flattened identically.
 */
export function flattenRing(
    ring: PathRing,
    toleranceMeters: number,
    curveType?: CurveType,
): Array<[number, number]> {
    if (curveType === 'bspline') ring = bsplineRingToBezier(ring);
    const pts = ring.points;
    if (pts.length === 0) return [];
    if (pts.length === 1) return [[pts[0].x, pts[0].y]];

    const out: Array<[number, number]> = [];
    const n = pts.length;

    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];

        out.push([a.x, a.y]);

        const p0: Point = { x: a.x, y: a.y };
        const p1: Point = a.hOut ?? { x: a.x, y: a.y };
        const p2: Point = b.hIn ?? { x: b.x, y: b.y };
        const p3: Point = { x: b.x, y: b.y };

        const isStraight = !a.hOut && !b.hIn;
        if (isStraight) continue;

        const controlLength =
            dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
        const segments = Math.max(1, Math.min(256, Math.ceil(controlLength / toleranceMeters)));

        for (let s = 1; s < segments; s++) {
            const t = s / segments;
            out.push(cubicBezierPoint(p0, p1, p2, p3, t));
        }
    }

    return out;
}

function dist(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): [number, number] {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return [
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    ];
}

// ============================================================================
// SWEREF 99 TM (EPSG:3006) <-> WGS84 transform
//
// Hand-rolled Transverse Mercator on GRS80. No proj4 dependency (framework
// philosophy: build the ~130 lines needed rather than adopt a
// general-purpose projection library).
//
// Formulation: the classic Redfearn/Snyder truncated Transverse Mercator
// series (Snyder, "Map Projections — A Working Manual", USGS Professional
// Paper 1395, 1987, eqs. 8-9 through 8-11 forward / 8-17 through 8-21
// inverse), specialized to GRS80 + SWEREF 99 TM's projection parameters.
// Verified directly against Lantmäteriet's own published control points
// (see geo.test.ts) to < 0.02 m forward error and < 2e-5 deg inverse error
// across Sweden's full extent (worst case at 9 degrees from the central
// meridian; error is far smaller near a course's actual longitude).
// ============================================================================

// GRS80 ellipsoid parameters
const GRS80_A = 6378137.0;
const GRS80_F = 1 / 298.257222101;
const GRS80_E2 = GRS80_F * (2 - GRS80_F); // first eccentricity squared
const GRS80_E_PRIME2 = GRS80_E2 / (1 - GRS80_E2); // second eccentricity squared
const GRS80_E1 = (1 - Math.sqrt(1 - GRS80_E2)) / (1 + Math.sqrt(1 - GRS80_E2));

// SWEREF 99 TM projection parameters
const SWEREF99TM_CENTRAL_MERIDIAN = 15.0; // degrees
const SWEREF99TM_SCALE = 0.9996;
const SWEREF99TM_FALSE_EASTING = 500000.0;
const SWEREF99TM_FALSE_NORTHING = 0.0;

function deg2rad(deg: number): number {
    return (deg * Math.PI) / 180;
}
function rad2deg(rad: number): number {
    return (rad * 180) / Math.PI;
}

/** Meridian arc length from the equator to latitude `phi` (radians), on GRS80. */
function meridianArcLength(phi: number): number {
    const e2 = GRS80_E2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
    const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
    const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
    const A6 = (35 * e6) / 3072;
    return GRS80_A * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
}

/** Footpoint latitude for the inverse projection: approximate inverse of meridianArcLength. */
function footpointLatitude(M: number): number {
    const e2 = GRS80_E2;
    const e1 = GRS80_E1;
    const mu = M / (GRS80_A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
    return (
        mu +
        ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
        ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
        ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
        ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
    );
}

/**
 * Geodetic (WGS84 lat/lon, effectively equivalent to SWEREF99 lat/lon at
 * sub-meter accuracy) -> SWEREF 99 TM grid (EPSG:3006) forward projection.
 */
export function wgs84ToSweref99tm(lat: number, lon: number): { x: number; y: number } {
    const lon0 = deg2rad(SWEREF99TM_CENTRAL_MERIDIAN);
    const k0 = SWEREF99TM_SCALE;
    const e2 = GRS80_E2;
    const ePrime2 = GRS80_E_PRIME2;

    const phi = deg2rad(lat);
    const lambda = deg2rad(lon);

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);

    const N = GRS80_A / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ePrime2 * cosPhi * cosPhi;
    const Aterm = (lambda - lon0) * cosPhi;
    const M = meridianArcLength(phi);

    const x =
        k0 *
        N *
        (Aterm +
            ((1 - T + C) * Aterm ** 3) / 6 +
            ((5 - 18 * T + T * T + 72 * C - 58 * ePrime2) * Aterm ** 5) / 120);

    const y =
        k0 *
        (M +
            N *
                tanPhi *
                (Aterm ** 2 / 2 +
                    ((5 - T + 9 * C + 4 * C * C) * Aterm ** 4) / 24 +
                    ((61 - 58 * T + T * T + 600 * C - 330 * ePrime2) * Aterm ** 6) / 720));

    return { x: x + SWEREF99TM_FALSE_EASTING, y: y + SWEREF99TM_FALSE_NORTHING };
}

/**
 * SWEREF 99 TM grid (EPSG:3006) -> geodetic (lat/lon) inverse projection.
 */
export function sweref99tmToWgs84(x: number, y: number): { lat: number; lon: number } {
    const lon0 = deg2rad(SWEREF99TM_CENTRAL_MERIDIAN);
    const k0 = SWEREF99TM_SCALE;
    const e2 = GRS80_E2;
    const ePrime2 = GRS80_E_PRIME2;

    const xNorm = x - SWEREF99TM_FALSE_EASTING;
    const yNorm = y - SWEREF99TM_FALSE_NORTHING;

    const M = yNorm / k0;
    const phi1 = footpointLatitude(M);

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);

    const N1 = GRS80_A / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const T1 = tanPhi1 * tanPhi1;
    const C1 = ePrime2 * cosPhi1 * cosPhi1;
    const R1 = (GRS80_A * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D = xNorm / (N1 * k0);

    const lat =
        phi1 -
        ((N1 * tanPhi1) / R1) *
            (D ** 2 / 2 -
                ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ePrime2) * D ** 4) / 24 +
                ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ePrime2 - 3 * C1 * C1) * D ** 6) / 720);

    const lon =
        lon0 +
        (D -
            ((1 + 2 * T1 + C1) * D ** 3) / 6 +
            ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ePrime2 + 24 * T1 * T1) * D ** 5) / 120) /
            cosPhi1;

    return { lat: rad2deg(lat), lon: rad2deg(lon) };
}

// ============================================================================
// GeoJSON derivation
// ============================================================================

export interface GeoJsonPolygon {
    type: 'Polygon';
    coordinates: number[][][]; // [ring][point][lon, lat]
}

/**
 * Signed area (shoelace) of a flattened ring in its native (x, y) space.
 * Positive => counter-clockwise, negative => clockwise.
 */
function signedArea(poly: Array<[number, number]>): number {
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}

function ensureWinding(poly: Array<[number, number]>, ccw: boolean): Array<[number, number]> {
    const area = signedArea(poly);
    const isCcw = area > 0;
    if (isCcw === ccw) return poly;
    return [...poly].reverse();
}

function closeRing(poly: Array<[number, number]>): Array<[number, number]> {
    if (poly.length === 0) return poly;
    const [fx, fy] = poly[0];
    const [lx, ly] = poly[poly.length - 1];
    if (fx === lx && fy === ly) return poly;
    return [...poly, [fx, fy]];
}

export type CrsTransform = (x: number, y: number) => { lat: number; lon: number };

/**
 * Flattens all rings (tolerance in meters, projected CRS) and produces a
 * WGS84 GeoJSON Polygon. First ring = outer boundary (forced CCW per RFC
 * 7946 right-hand rule), subsequent rings = holes (forced CW). Rings are
 * explicitly closed (first point repeated at the end).
 */
export function toGeoJson(
    geometry: FeatureGeometry,
    crsTransform: CrsTransform = sweref99tmToWgs84,
    toleranceMeters = 0.25,
): GeoJsonPolygon {
    const coordinates: number[][][] = geometry.rings.map((ring, idx) => {
        const flattened = flattenRing(ring, toleranceMeters, geometry.curveType);
        const wound = ensureWinding(flattened, idx === 0);
        const closed = closeRing(wound);
        return closed.map(([x, y]) => {
            const { lat, lon } = crsTransform(x, y);
            return [lon, lat];
        });
    });

    return { type: 'Polygon', coordinates };
}
