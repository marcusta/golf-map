// HTTP client for the SAM 3 segmentation sidecar (tools/sam-server) — the
// editor's click-to-feature assist (T45). Ported from the golf-map-2
// prototype's contourDetectionSAM3.ts crop→/segment→largest-polygon flow,
// reshaped to the repo's injectable-dependency style: the fetch function is
// a constructor seam so the /segment and /health contracts are testable
// with canned responses (no sidecar, no network).

/** Sidecar base URL (localhost only — see tools/sam-server/README.md). */
export const SAM_BASE_URL = 'http://localhost:8000';

/** Crop size (px) sent to the sidecar — matches its MAX_INFERENCE_SIZE. */
export const SAM_CROP_SIZE = 512;

/** /health timeout — the sidecar answers instantly when it's up at all. */
const HEALTH_TIMEOUT_MS = 5000;
/** /segment timeout — first inference lazy-loads the 3.5 GB model. */
const SEGMENT_TIMEOUT_MS = 30000;

/** The sidecar's /segment response shape. */
export interface SamSegmentResponse {
    /** Pixel polygons (crop coordinates), each a list of [x, y] vertices. */
    polygons: number[][][];
    confidence: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class SamClient {
    constructor(
        private baseUrl: string = SAM_BASE_URL,
        private fetchFn: FetchLike = (url, init) => fetch(url, init),
    ) {}

    /** True when the sidecar answers /health with status "healthy". */
    async health(): Promise<boolean> {
        try {
            const res = await this.fetchFn(`${this.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
            });
            if (!res.ok) return false;
            const data = (await res.json()) as { status?: string };
            return data.status === 'healthy';
        } catch {
            return false;
        }
    }

    /**
     * Segment the object at the CENTER of a base64 JPEG crop (point mode).
     * Returns the sidecar's pixel polygons in crop coordinates. Throws on
     * HTTP/network errors — callers surface a notice and stay armed.
     */
    async segmentPoint(imageBase64: string): Promise<SamSegmentResponse> {
        const res = await this.fetchFn(`${this.baseUrl}/segment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageBase64, offset_x: 0, offset_y: 0 }),
            signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`SAM sidecar error: ${res.status}`);
        const data = (await res.json()) as Partial<SamSegmentResponse>;
        return {
            polygons: Array.isArray(data.polygons) ? data.polygons : [],
            confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        };
    }
}

/**
 * The largest polygon by absolute shoelace AREA (the prototype used point
 * count as a proxy — a long skinny noise contour can out-count the real
 * shape, so measure properly). Null when no polygon has ≥ 3 vertices.
 */
export function largestPolygon(polygons: number[][][]): number[][] | null {
    let best: number[][] | null = null;
    let bestArea = 0;
    for (const poly of polygons) {
        if (poly.length < 3) continue;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const [ax, ay] = poly[i];
            const [bx, by] = poly[(i + 1) % poly.length];
            area += ax * by - bx * ay;
        }
        area = Math.abs(area) / 2;
        if (best === null || area > bestArea) {
            best = poly;
            bestArea = area;
        }
    }
    return best;
}
