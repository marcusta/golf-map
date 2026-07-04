import type { Kysely } from 'kysely';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fromFile, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import type { Database } from '../db/schema';
import { NotFoundError } from '@basics/core/server/auth';
import { flattenRing, type FeatureGeometry } from './geo';

// ─── Green + surrounds DEM sampling (Phase 3 green analysis) ──────────────
//
// Serves the client-side green height/slope analysis tool: given a green
// polygon (EPSG:3006 bezier rings), sample the course's full-precision DEM
// (dem_cog asset, 0.5 m LiDAR GeoTIFF) over the polygon's bbox plus a
// buffer, and return a regular height grid + an inside-the-green mask.
//
// Heights are lightly Gaussian-blurred server-side (radius 3 cells — the
// golf-map-2 reference pipeline's smoothing step) so the client's
// central-difference gradients aren't dominated by LiDAR quantization
// noise. See docs/reference/golf-map-2-measure-and-green-analysis.md §2.6/§4.

// --- Tunables / clamps ---

export const BUFFER_MIN_M = 0;
export const BUFFER_MAX_M = 50;
export const DEFAULT_BUFFER_M = 20;
export const RESOLUTION_MIN_M = 0.25;
export const RESOLUTION_MAX_M = 10;
export const DEFAULT_RESOLUTION_M = 0.5;
/** Cap on grid cells per axis — oversized requests get a coarser resolution instead of failing. */
export const MAX_CELLS_PER_AXIS = 400;
/** Gaussian blur radius in cells (sigma = radius / 2), per the reference doc. */
export const BLUR_RADIUS_CELLS = 3;

/** Flattening tolerance for bezier rings (matches server GeoJSON derivation). */
const FLATTEN_TOLERANCE_M = 0.25;

// --- Output types ---

export interface GridSpec {
    /** EPSG:3006 coordinate of the grid's top-left OUTER corner (not a cell center). */
    origin: { e: number; n: number };
    /** Cell size in meters (may be coarser than requested when capped). */
    resolution: number;
    /** Cells per row (east–west). */
    width: number;
    /** Rows (north–south; row 0 is the northernmost). */
    height: number;
}

export interface SampleGrid extends GridSpec {
    /**
     * Blurred DEM heights (meters, RH2000) sampled at cell centers,
     * row-major from the north-west corner. null = nodata / outside DEM.
     */
    heights: (number | null)[];
    /** 1 when the cell center lies inside the green polygon, else 0. Row-major. */
    insideMask: number[];
}

export class InvalidAnalysisRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidAnalysisRequestError';
    }
}

// ─── Pure grid math (exported for unit tests) ─────────────────────────────

export interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Bbox over every flattened ring of a geometry. Throws when degenerate. */
export function geometryBbox(geometry: FeatureGeometry): Bbox {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of geometry.rings) {
        for (const [x, y] of flattenRing(ring, FLATTEN_TOLERANCE_M)) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
        throw new InvalidAnalysisRequestError('Geometry has a degenerate bounding box');
    }
    return { minX, minY, maxX, maxY };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Grid layout for a polygon bbox + buffer: clamps the buffer to
 * [BUFFER_MIN_M, BUFFER_MAX_M] and the resolution to [RESOLUTION_MIN_M,
 * RESOLUTION_MAX_M], then coarsens the resolution as needed so neither
 * axis exceeds MAX_CELLS_PER_AXIS.
 */
export function computeGridSpec(bbox: Bbox, bufferM: number, resolutionM: number): GridSpec {
    const buffer = clamp(Number.isFinite(bufferM) ? bufferM : DEFAULT_BUFFER_M, BUFFER_MIN_M, BUFFER_MAX_M);
    let resolution = clamp(
        Number.isFinite(resolutionM) && resolutionM > 0 ? resolutionM : DEFAULT_RESOLUTION_M,
        RESOLUTION_MIN_M,
        RESOLUTION_MAX_M,
    );

    const extentX = bbox.maxX - bbox.minX + 2 * buffer;
    const extentY = bbox.maxY - bbox.minY + 2 * buffer;
    resolution = Math.max(resolution, extentX / MAX_CELLS_PER_AXIS, extentY / MAX_CELLS_PER_AXIS);

    return {
        origin: { e: bbox.minX - buffer, n: bbox.maxY + buffer },
        resolution,
        width: Math.max(1, Math.ceil(extentX / resolution)),
        height: Math.max(1, Math.ceil(extentY / resolution)),
    };
}

/** Ray-casting point-in-ring test (ring implicitly closed). */
export function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

/**
 * Per-cell inside-the-polygon mask (cell centers; ring 0 = outer boundary,
 * rings 1.. = holes). Row-major, 1 = inside.
 */
export function buildInsideMask(spec: GridSpec, geometry: FeatureGeometry): number[] {
    const rings = geometry.rings.map(r => flattenRing(r, FLATTEN_TOLERANCE_M));
    const outer = rings[0] ?? [];
    const holes = rings.slice(1);
    const mask = new Array<number>(spec.width * spec.height).fill(0);
    if (outer.length < 3) return mask;

    for (let row = 0; row < spec.height; row++) {
        const n = spec.origin.n - (row + 0.5) * spec.resolution;
        for (let col = 0; col < spec.width; col++) {
            const e = spec.origin.e + (col + 0.5) * spec.resolution;
            if (!pointInRing(e, n, outer)) continue;
            let inHole = false;
            for (const hole of holes) {
                if (hole.length >= 3 && pointInRing(e, n, hole)) {
                    inHole = true;
                    break;
                }
            }
            if (!inHole) mask[row * spec.width + col] = 1;
        }
    }
    return mask;
}

/**
 * Separable NaN-aware Gaussian blur (radius in cells, sigma = radius / 2).
 * The kernel is renormalized over valid (non-NaN) neighbors so nodata
 * doesn't bleed into valid cells; NaN cells stay NaN. Returns a new array.
 */
export function gaussianBlurGrid(
    values: Float64Array,
    width: number,
    height: number,
    radius: number = BLUR_RADIUS_CELLS,
): Float64Array {
    if (radius <= 0) return Float64Array.from(values);
    const sigma = radius / 2;
    const kernel = new Float64Array(2 * radius + 1);
    for (let i = -radius; i <= radius; i++) {
        kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    }

    const pass = (src: Float64Array, dx: number, dy: number): Float64Array => {
        const out = new Float64Array(src.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const center = src[y * width + x];
                if (Number.isNaN(center)) {
                    out[y * width + x] = NaN;
                    continue;
                }
                let sum = 0;
                let weight = 0;
                for (let k = -radius; k <= radius; k++) {
                    // Clamped-edge boundary handling (matches the reference impl).
                    const sx = clamp(x + k * dx, 0, width - 1);
                    const sy = clamp(y + k * dy, 0, height - 1);
                    const v = src[sy * width + sx];
                    if (Number.isNaN(v)) continue;
                    sum += v * kernel[k + radius];
                    weight += kernel[k + radius];
                }
                out[y * width + x] = weight > 0 ? sum / weight : NaN;
            }
        }
        return out;
    };

    return pass(pass(values, 1, 0), 0, 1);
}

// ─── DEM raster window (internal) ─────────────────────────────────────────

interface DemWindow {
    /** Raster values (NaN = nodata), row-major within the window. */
    values: Float64Array;
    width: number;
    height: number;
    /** EPSG:3006 easting of the window's left OUTER edge. */
    originE: number;
    /** EPSG:3006 northing of the window's top OUTER edge. */
    originN: number;
    /** DEM pixel size in meters (x positive, y positive — northing decreases per row). */
    pixelX: number;
    pixelY: number;
}

/**
 * Bilinear sample of a DEM window at an EPSG:3006 point (pixel-center
 * convention). NaN corners are skipped with weight renormalization; returns
 * NaN outside the window or when all contributing pixels are nodata.
 */
export function bilinearSample(win: DemWindow, e: number, n: number): number {
    const fx = (e - win.originE) / win.pixelX - 0.5;
    const fy = (win.originN - n) / win.pixelY - 0.5;
    if (fx < -0.5 || fy < -0.5 || fx > win.width - 0.5 || fy > win.height - 0.5) return NaN;

    const x0 = clamp(Math.floor(fx), 0, win.width - 1);
    const y0 = clamp(Math.floor(fy), 0, win.height - 1);
    const x1 = Math.min(x0 + 1, win.width - 1);
    const y1 = Math.min(y0 + 1, win.height - 1);
    const tx = clamp(fx - x0, 0, 1);
    const ty = clamp(fy - y0, 0, 1);

    const corners: Array<[number, number]> = [
        [win.values[y0 * win.width + x0], (1 - tx) * (1 - ty)],
        [win.values[y0 * win.width + x1], tx * (1 - ty)],
        [win.values[y1 * win.width + x0], (1 - tx) * ty],
        [win.values[y1 * win.width + x1], tx * ty],
    ];
    let sum = 0;
    let weight = 0;
    for (const [v, w] of corners) {
        if (Number.isNaN(v) || w === 0) continue;
        sum += v * w;
        weight += w;
    }
    return weight > 0 ? sum / weight : NaN;
}

// ─── Service ──────────────────────────────────────────────────────────────

interface OpenDem {
    tiff: GeoTIFF;
    image: GeoTIFFImage;
    /** [minX, minY, maxX, maxY] in EPSG:3006. */
    bbox: [number, number, number, number];
    pixelX: number;
    pixelY: number;
    nodata: number | null;
    width: number;
    height: number;
}

export class AnalysisService {
    /** Opened GeoTIFF handles per absolute path (a DEM is ~150 MB; opening reads only headers). */
    private demCache = new Map<string, Promise<OpenDem>>();

    constructor(private db: Kysely<Database>, private dataDir: string) {}

    /**
     * Sample the course DEM over `geometry` (a green's EPSG:3006 bezier
     * polygon) plus `bufferM` meters of surrounds, at `resolutionM` cell
     * size. Returns blurred heights + inside-green mask (see SampleGrid).
     */
    async sampleGrid(
        courseId: string,
        geometry: FeatureGeometry,
        bufferM: number = DEFAULT_BUFFER_M,
        resolutionM: number = DEFAULT_RESOLUTION_M,
    ): Promise<SampleGrid> {
        if (!geometry || !Array.isArray(geometry.rings) || geometry.rings.length === 0) {
            throw new InvalidAnalysisRequestError('Geometry must have at least one ring');
        }
        const spec = computeGridSpec(geometryBbox(geometry), bufferM, resolutionM);
        const dem = await this.openDem(courseId);
        const win = await this.readDemWindow(dem, spec);

        // Sample cell centers, then blur (blur in grid space so the radius
        // tracks the delivered resolution, per the reference smoothing note).
        const raw = new Float64Array(spec.width * spec.height);
        for (let row = 0; row < spec.height; row++) {
            const n = spec.origin.n - (row + 0.5) * spec.resolution;
            for (let col = 0; col < spec.width; col++) {
                const e = spec.origin.e + (col + 0.5) * spec.resolution;
                raw[row * spec.width + col] = bilinearSample(win, e, n);
            }
        }
        const blurred = gaussianBlurGrid(raw, spec.width, spec.height, BLUR_RADIUS_CELLS);

        const heights: (number | null)[] = new Array(blurred.length);
        for (let i = 0; i < blurred.length; i++) {
            const v = blurred[i];
            heights[i] = Number.isNaN(v) ? null : Math.round(v * 1000) / 1000;
        }

        return { ...spec, heights, insideMask: buildInsideMask(spec, geometry) };
    }

    // --- DEM access ---

    private async openDem(courseId: string): Promise<OpenDem> {
        const asset = await this.db
            .selectFrom('course_assets')
            .selectAll()
            .where('course_id', '=', courseId)
            .where('kind', '=', 'dem_cog')
            .executeTakeFirst();
        if (!asset) throw new NotFoundError(`No DEM asset registered for course ${courseId}`);

        const dataRoot = path.resolve(this.dataDir);
        const demPath = path.resolve(dataRoot, asset.filename);
        if (!demPath.startsWith(dataRoot + path.sep)) {
            throw new NotFoundError('DEM path escapes the data directory');
        }
        if (!fs.existsSync(demPath) || !fs.statSync(demPath).isFile()) {
            throw new NotFoundError(`DEM file not available for course ${courseId}`);
        }

        let pending = this.demCache.get(demPath);
        if (!pending) {
            pending = (async (): Promise<OpenDem> => {
                const tiff = await fromFile(demPath);
                const image = await tiff.getImage();
                const [resX, resY] = image.getResolution();
                const bbox = image.getBoundingBox() as [number, number, number, number];
                return {
                    tiff,
                    image,
                    bbox,
                    pixelX: Math.abs(resX),
                    pixelY: Math.abs(resY),
                    nodata: image.getGDALNoData(),
                    width: image.getWidth(),
                    height: image.getHeight(),
                };
            })();
            this.demCache.set(demPath, pending);
            pending.catch(() => this.demCache.delete(demPath));
        }
        return pending;
    }

    /** Read the DEM pixel window covering `spec` (+1 px margin for bilinear edges). */
    private async readDemWindow(dem: OpenDem, spec: GridSpec): Promise<DemWindow> {
        const [demMinX, , , demMaxY] = dem.bbox;
        const gridMinE = spec.origin.e;
        const gridMaxE = spec.origin.e + spec.width * spec.resolution;
        const gridMaxN = spec.origin.n;
        const gridMinN = spec.origin.n - spec.height * spec.resolution;

        const px0 = clamp(Math.floor((gridMinE - demMinX) / dem.pixelX) - 1, 0, dem.width);
        const px1 = clamp(Math.ceil((gridMaxE - demMinX) / dem.pixelX) + 1, 0, dem.width);
        const py0 = clamp(Math.floor((demMaxY - gridMaxN) / dem.pixelY) - 1, 0, dem.height);
        const py1 = clamp(Math.ceil((demMaxY - gridMinN) / dem.pixelY) + 1, 0, dem.height);
        if (px1 <= px0 || py1 <= py0) {
            throw new InvalidAnalysisRequestError('Requested area is outside the course DEM coverage');
        }

        const rasters = await dem.image.readRasters({ window: [px0, py0, px1, py1] });
        const band = rasters[0] as ArrayLike<number>;
        const width = px1 - px0;
        const height = py1 - py0;
        const values = new Float64Array(width * height);
        for (let i = 0; i < values.length; i++) {
            const v = band[i];
            values[i] = dem.nodata !== null && v === dem.nodata ? NaN : v;
        }
        return {
            values,
            width,
            height,
            originE: demMinX + px0 * dem.pixelX,
            originN: demMaxY - py0 * dem.pixelY,
            pixelX: dem.pixelX,
            pixelY: dem.pixelY,
        };
    }
}
