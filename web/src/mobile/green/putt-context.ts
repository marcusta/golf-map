import type { PuttContext } from '../../planner/putt-read.service';
import type { Vec2 } from '../../../../shared/strategy';
import type { CourseFeature } from '../../../../shared/api/course-features.gen';
import { wgs84ToSweref99tm } from '../../geo/transform';

/** The furniture green row fields the context needs (structural — see Green). */
export interface GreenRowLike {
    id: string;
    holeId: string;
    centerLat: number;
    centerLon: number;
}

/** The pin row fields the context needs (structural — see Pin). */
export interface PinRowLike {
    greenId: string;
    lat: number;
    lon: number;
    active: boolean;
}

export interface PuttContextInput {
    /** The hole being read (its green feature keys the DEM sample grid). */
    holeId: string;
    /** Every raw course feature (only greens on this hole are considered). */
    features: readonly CourseFeature[];
    /** Furniture green rows (calibration key + centre fallback). */
    greens: readonly GreenRowLike[];
    /** Every pin on the course; the ACTIVE one on this green wins. */
    pins: readonly PinRowLike[];
}

/**
 * Vertex centroid of a bezier ring's anchor points (EPSG:3006). Only the
 * last-resort default-hole fallback — a green with a drawn polygon but no
 * furniture row at all. Anchor points (not the flattened curve) are enough
 * for a "middle of the green" seed.
 */
export function ringCentroid(points: readonly { x: number; y: number }[]): Vec2 {
    if (points.length === 0) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const p of points) {
        x += p.x;
        y += p.y;
    }
    return { x: x / points.length, y: y / points.length };
}

/**
 * Build the {@link PuttContext} the shared PuttReadService arms on, from data
 * the mobile screens already load (course features + furniture greens/pins).
 * No planner tool is involved — this is the whole S3.2 seam.
 *
 * Default hole position follows the SAME rule as the desktop planner
 * (planner-tool.service attachPuttActivation): the ACTIVE PIN when one exists,
 * else the furniture green centre, else the green polygon's vertex centroid.
 * Returns null when the hole has no green FEATURE drawn — there is no DEM
 * sample-grid key without one, so there is nothing to read.
 */
export function buildPuttContext(input: PuttContextInput): PuttContext | null {
    const greenFeature = input.features.find(
        f => f.type === 'green' && f.holeId === input.holeId,
    );
    if (!greenFeature) return null;

    const row = input.greens.find(g => g.holeId === input.holeId) ?? null;
    const activePin = row
        ? input.pins.find(p => p.greenId === row.id && p.active) ?? null
        : null;

    const defaultHole: Vec2 = activePin
        ? wgs84ToSweref99tm(activePin.lat, activePin.lon)
        : row
            ? wgs84ToSweref99tm(row.centerLat, row.centerLon)
            : ringCentroid(greenFeature.geometry.rings[0]?.points ?? []);

    return {
        courseId: greenFeature.courseId,
        greenFeatureId: greenFeature.id,
        geometry: greenFeature.geometry,
        greenId: row?.id ?? null,
        defaultHole,
    };
}
