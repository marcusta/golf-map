// Pure mask + Web-Mercator math for the "Clean photo" tool (T55). No DOM,
// no canvas, no network — everything here runs under bun test. Masks are
// flat Uint8Array bitmaps over the 512 px ortho crop (1 = inpaint), built
// either from a SAM contour polygon (click mode) or a drag-ellipse
// (SAM-free fallback), then dilated a little so the blemish's soft edge
// goes with it.

import type { CropPlan } from '../sam/sam-crop';

/** WGS84/Web-Mercator sphere radius (meters). */
export const EARTH_RADIUS_M = 6378137;
/** Half the EPSG:3857 world extent (meters): x/y run [-THIS, +THIS]. */
export const MERCATOR_ORIGIN_SHIFT = Math.PI * EARTH_RADIUS_M;

/** EPSG:3857 meters per crop pixel at `zoom` (NOT ground meters — divide by
 * cos(lat) is already baked into Mercator; see groundMetersPerPixel). */
export function mercatorMetersPerPixel(zoom: number, tileSize = 256): number {
    return (2 * MERCATOR_ORIGIN_SHIFT) / (tileSize * Math.pow(2, zoom));
}

/** True ground meters per crop pixel at `zoom` for a given latitude. */
export function groundMetersPerPixel(zoom: number, lat: number, tileSize = 256): number {
    return mercatorMetersPerPixel(zoom, tileSize) * Math.cos((lat * Math.PI) / 180);
}

/** WGS84 → EPSG:3857 meters. */
export function lngLatToMercator(p: { lng: number; lat: number }): { x: number; y: number } {
    const x = (p.lng * Math.PI * EARTH_RADIUS_M) / 180;
    const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360));
    return { x, y };
}

/** EPSG:3857 meters → WGS84. */
export function mercatorToLngLat(x: number, y: number): { lng: number; lat: number } {
    const lng = (x * 180) / (Math.PI * EARTH_RADIUS_M);
    const lat = ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * 180) / Math.PI;
    return { lng, lat };
}

/**
 * The exact EPSG:3857 rectangle of a planned crop — the patch's native
 * frame, sent to the server on accept and stored in the patch log. Exact
 * because the crop origin is integer global pixels at `plan.zoom` (see
 * planCrop's snapping).
 */
export function planBounds3857(plan: CropPlan): { west: number; south: number; east: number; north: number } {
    const mpp = mercatorMetersPerPixel(plan.zoom, plan.tileSize);
    const west = -MERCATOR_ORIGIN_SHIFT + plan.originX * mpp;
    const north = MERCATOR_ORIGIN_SHIFT - plan.originY * mpp;
    return { west, south: north - plan.size * mpp, east: west + plan.size * mpp, north };
}

/** An EPSG:3857 position → crop pixel coordinates within `plan`. */
export function mercatorToCropPixel(plan: CropPlan, x: number, y: number): { px: number; py: number } {
    const mpp = mercatorMetersPerPixel(plan.zoom, plan.tileSize);
    const b = planBounds3857(plan);
    return { px: (x - b.west) / mpp, py: (b.north - y) / mpp };
}

/**
 * Rasterize a polygon (crop-pixel vertices, e.g. a SAM contour) into a
 * size×size bitmap via even-odd scanline fill sampled at pixel centers.
 */
export function fillPolygonMask(size: number, polygon: number[][]): Uint8Array {
    const mask = new Uint8Array(size * size);
    const n = polygon.length;
    if (n < 3) return mask;
    for (let row = 0; row < size; row++) {
        const y = row + 0.5;
        const xs: number[] = [];
        for (let i = 0; i < n; i++) {
            const [x1, y1] = polygon[i];
            const [x2, y2] = polygon[(i + 1) % n];
            if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
                xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
            }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const from = Math.max(0, Math.ceil(xs[k] - 0.5));
            const to = Math.min(size - 1, Math.floor(xs[k + 1] - 0.5));
            for (let col = from; col <= to; col++) mask[row * size + col] = 1;
        }
    }
    return mask;
}

/** Rasterize an axis-aligned ellipse (crop pixels) into a size×size bitmap. */
export function fillEllipseMask(size: number, cx: number, cy: number, rx: number, ry: number): Uint8Array {
    const mask = new Uint8Array(size * size);
    if (rx <= 0 || ry <= 0) return mask;
    const r0 = Math.max(0, Math.floor(cy - ry));
    const r1 = Math.min(size - 1, Math.ceil(cy + ry));
    for (let row = r0; row <= r1; row++) {
        const dy = (row + 0.5 - cy) / ry;
        const span = 1 - dy * dy;
        if (span <= 0) continue;
        const half = rx * Math.sqrt(span);
        const from = Math.max(0, Math.ceil(cx - half - 0.5));
        const to = Math.min(size - 1, Math.floor(cx + half - 0.5));
        for (let col = from; col <= to; col++) mask[row * size + col] = 1;
    }
    return mask;
}

/** Binary dilation with a Euclidean disc of `radiusPx` (0 → unchanged). */
export function dilateMask(mask: Uint8Array, size: number, radiusPx: number): Uint8Array {
    const r = Math.floor(radiusPx);
    if (r <= 0) return mask.slice();
    const offsets: number[][] = [];
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= radiusPx * radiusPx) offsets.push([dx, dy]);
        }
    }
    const out = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (!mask[row * size + col]) continue;
            for (const [dx, dy] of offsets) {
                const rr = row + dy;
                const cc = col + dx;
                if (rr >= 0 && rr < size && cc >= 0 && cc < size) out[rr * size + cc] = 1;
            }
        }
    }
    return out;
}

/** Number of set pixels. */
export function maskArea(mask: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
}

/**
 * WGS84 ring approximating the ellipse whose EPSG:3857 bounding box spans
 * `a`..`b` — the live outline shown while dragging in ellipse mode.
 */
export function ellipseRingLngLat(
    a: { lng: number; lat: number },
    b: { lng: number; lat: number },
    segments = 48,
): Array<[number, number]> {
    const ma = lngLatToMercator(a);
    const mb = lngLatToMercator(b);
    const cx = (ma.x + mb.x) / 2;
    const cy = (ma.y + mb.y) / 2;
    const rx = Math.abs(mb.x - ma.x) / 2;
    const ry = Math.abs(mb.y - ma.y) / 2;
    const ring: Array<[number, number]> = [];
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * 2 * Math.PI;
        const p = mercatorToLngLat(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
        ring.push([p.lng, p.lat]);
    }
    return ring;
}
