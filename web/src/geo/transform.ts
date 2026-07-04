// SWEREF 99 TM (EPSG:3006) <-> WGS84 transform — client-side port of
// server/services/geo.ts. The two implementations MUST stay numerically
// identical: feature geometry is authored in the browser in projected
// meters and the server independently derives WGS84 GeoJSON from the same
// numbers, so both sides are verified against the same Lantmäteriet
// control points (see web/tests/transform.test.ts / server geo.test.ts).
//
// Hand-rolled Transverse Mercator on GRS80 (Redfearn/Snyder truncated
// series — Snyder, USGS Professional Paper 1395, eqs. 8-9..8-11 forward /
// 8-17..8-21 inverse), specialized to SWEREF 99 TM's parameters. Accuracy
// against Lantmäteriet's published control points: < 0.02 m forward,
// < 2e-5 deg inverse across Sweden's full extent.

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

/** Convenience: EPSG:3006 point -> MapLibre-style { lng, lat }. */
export function sweref99tmToLngLat(x: number, y: number): { lng: number; lat: number } {
    const { lat, lon } = sweref99tmToWgs84(x, y);
    return { lng: lon, lat };
}

/** Convenience: MapLibre-style { lng, lat } -> EPSG:3006 point. */
export function lngLatToSweref99tm(lngLat: { lng: number; lat: number }): { x: number; y: number } {
    return wgs84ToSweref99tm(lngLat.lat, lngLat.lng);
}
