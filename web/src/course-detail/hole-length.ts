import { wgs84ToSweref99tm } from '../geo/transform';
import type { Tee } from '../../../shared/api/tees.gen';
import type { AimPoint } from '../../../shared/api/aim-points.gen';

/** A WGS84 point (lat/lon) on the playing path. */
export interface LatLon {
    lat: number;
    lon: number;
}

/** Result of a playing-length computation. */
export interface PlayingLength {
    /** Whole-metre length along the path, or null when < 2 points. */
    meters: number | null;
    /**
     * True when the path stops at the last aim point because the hole has no
     * green center — the figure is an underestimate and the panel marks it '~'.
     */
    approximate: boolean;
}

/**
 * Planar distance between two WGS84 points, projected to EPSG:3006 (SWEREF 99
 * TM) metres. Over a single golf-hole leg the grid-scale distortion is
 * negligible, matching how the rest of the editor measures.
 */
function legMeters(a: LatLon, b: LatLon): number {
    const pa = wgs84ToSweref99tm(a.lat, a.lon);
    const pb = wgs84ToSweref99tm(b.lat, b.lon);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Sum the leg lengths of an ordered path (metres). 0 for < 2 points. */
export function pathMeters(path: LatLon[]): number {
    let total = 0;
    for (let i = 1; i < path.length; i++) total += legMeters(path[i - 1], path[i]);
    return total;
}

/**
 * The hole's aim points a tee plays through, in order. An aim point the tee
 * is already past — one no closer to the green than the tee itself — drops
 * out, so a forward tee does not walk backwards to a dogleg marker meant for
 * the back tees; `straight` (a tee of the set GSPro plays as Par3) ignores
 * them all. The same two rules as the .GKD export's `_gkd_tee_distance`
 * (pipeline/gspro.py), so the play line, the panel and GSPro agree. Without
 * a green center there is nothing to be past: every aim point stays.
 */
export function aimsInPlay<A extends LatLon>(tee: LatLon, aims: A[], greenCenter: LatLon | null, straight = false): A[] {
    if (!greenCenter) return aims;
    if (straight) return [];
    const toGreen = legMeters(tee, greenCenter);
    return aims.filter(a => legMeters(a, greenCenter) < toGreen);
}

/**
 * Playing length for a hole from a given tee: tee → the aim points it plays
 * through (`aimsInPlay`) → green center. Each leg is measured in projected
 * EPSG:3006 metres and the total is rounded to whole metres.
 *
 * - `tee` null → length null (no origin).
 * - No `greenCenter` → measure tee → aims only and flag `approximate` (the
 *   panel shows a leading '~'). If there are also no aims, there's a single
 *   point → length null.
 */
export function playingLength(
    tee: Pick<Tee, 'lat' | 'lon'> | null,
    aims: Pick<AimPoint, 'lat' | 'lon'>[],
    greenCenter: LatLon | null,
    straight = false,
): PlayingLength {
    if (!tee) return { meters: null, approximate: false };
    const path: LatLon[] = [{ lat: tee.lat, lon: tee.lon }];
    for (const a of aimsInPlay(tee, aims, greenCenter, straight)) path.push({ lat: a.lat, lon: a.lon });
    const approximate = greenCenter === null;
    if (greenCenter) path.push(greenCenter);
    if (path.length < 2) return { meters: null, approximate };
    return { meters: Math.round(pathMeters(path)), approximate };
}
