// HTTP client for the assist sidecar's /inpaint capability (T55 photo
// cleaning). Same process as the SAM sidecar (tools/sam-server) — /health
// now reports per-capability readiness, and the Clean tool gates on
// `inpaint.available` specifically (SAM weights and LaMa weights are
// independent). Fetch is a constructor seam so the contracts are testable
// with canned responses.

import { SAM_BASE_URL, type FetchLike } from '../sam/sam-client';

const HEALTH_TIMEOUT_MS = 5000;
/** /inpaint timeout — LaMa on a 512 px crop is ~8 s on CPU, and the first
 * call lazily loads the model on top of that. */
const INPAINT_TIMEOUT_MS = 180_000;

/** Per-capability sidecar readiness as the Clean tool sees it. */
export interface SidecarInpaintHealth {
    /** The sidecar process answered /health at all. */
    online: boolean;
    /** LaMa weights + torch present — /inpaint will work. */
    inpaintAvailable: boolean;
    /** Human-readable reason when unavailable (from the sidecar). */
    detail: string | null;
}

export class CleanClient {
    constructor(
        private baseUrl: string = SAM_BASE_URL,
        private fetchFn: FetchLike = (url, init) => fetch(url, init),
    ) {}

    async health(): Promise<SidecarInpaintHealth> {
        try {
            const res = await this.fetchFn(`${this.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
            });
            if (!res.ok) return { online: false, inpaintAvailable: false, detail: null };
            const data = (await res.json()) as {
                status?: string;
                inpaint?: { available?: boolean; detail?: string };
            };
            const online = data.status === 'healthy';
            return {
                online,
                inpaintAvailable: online && data.inpaint?.available === true,
                detail: typeof data.inpaint?.detail === 'string' ? data.inpaint.detail : null,
            };
        } catch {
            return { online: false, inpaintAvailable: false, detail: null };
        }
    }

    /**
     * Inpaint the masked pixels of a crop. Both arguments are base64 PNGs
     * (mask same size, >127 = inpaint); returns the base64 PNG result —
     * pixels outside the mask come back byte-identical (golfpipe's
     * inpaint_tiled invariant, so the whole result can overlay the map).
     */
    async inpaint(imageBase64: string, maskBase64: string): Promise<string> {
        const res = await this.fetchFn(`${this.baseUrl}/inpaint`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageBase64, mask: maskBase64 }),
            signal: AbortSignal.timeout(INPAINT_TIMEOUT_MS),
        });
        if (!res.ok) {
            let detail = '';
            try {
                detail = ((await res.json()) as { detail?: string }).detail ?? '';
            } catch {
                // Non-JSON error body — the status alone will have to do.
            }
            throw new Error(`inpaint sidecar error ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const data = (await res.json()) as { image?: string };
        if (typeof data.image !== 'string' || data.image.length === 0) {
            throw new Error('inpaint sidecar returned no image');
        }
        return data.image;
    }
}
