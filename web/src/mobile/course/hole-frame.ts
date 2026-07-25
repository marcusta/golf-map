/** A WGS84 point in lng/lat order (MapLibre convention). */
export interface LngLatPoint {
    lng: number;
    lat: number;
}

/** WGS84 bounds as MapLibre's `[west, south, east, north]`. */
export type Bbox = [number, number, number, number];

export interface HoleFrame {
    /** Envelope of the supplied points, or null when none were given. */
    bbox: Bbox | null;
    /** Compass bearing tee → green (degrees, 0 = north), or null. */
    bearingDeg: number | null;
}

/**
 * Compass bearing from `a` to `b` (degrees clockwise from north), using an
 * equirectangular longitude scaling by the mid-latitude — accurate to well
 * under a degree at hole scale (a few hundred metres), and pure so it unit
 * tests without a projection dependency.
 */
export function bearingDeg(a: LngLatPoint, b: LngLatPoint): number {
    const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    const dLon = (b.lng - a.lng) * Math.cos(midLat);
    const dLat = b.lat - a.lat;
    const deg = Math.atan2(dLon, dLat) * 180 / Math.PI;
    return (deg + 360) % 360;
}

/** Envelope of the given points as `[w, s, e, n]`, or null when empty. */
export function envelope(points: readonly LngLatPoint[]): Bbox | null {
    if (points.length === 0) return null;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of points) {
        if (p.lng < w) w = p.lng;
        if (p.lng > e) e = p.lng;
        if (p.lat < s) s = p.lat;
        if (p.lat > n) n = p.lat;
    }
    return [w, s, e, n];
}

/**
 * Frame a hole tee → green: the map should orient so the green is "up" (the
 * hole axis is the tee→green bearing, like the iOS on-course view) and the
 * camera should fit both endpoints (plus any extra points — aims, hazards).
 * Missing tee or green degrades gracefully: bearing needs both; the bbox uses
 * whatever points exist.
 */
export function frameHole(
    tee: LngLatPoint | null,
    green: LngLatPoint | null,
    extra: readonly LngLatPoint[] = [],
): HoleFrame {
    const points: LngLatPoint[] = [];
    if (tee) points.push(tee);
    if (green) points.push(green);
    points.push(...extra);
    return {
        bbox: envelope(points),
        bearingDeg: tee && green ? bearingDeg(tee, green) : null,
    };
}
