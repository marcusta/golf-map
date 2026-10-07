// External-edit support for the Clean tool (plan: docs/feature-ortho-export-import.md
// section 6): the raw-body import upload behind an injectable seam, and the pure
// arithmetic behind the import summary. The export call itself goes through the
// generated `api.orthoPatches` client; only `PUT /ortho-patches/import/:courseId`
// is a raw route (no generated client), and it needs upload progress, which
// fetch cannot report — hence XMLHttpRequest behind `UploadLike`, so tests need
// no network.

import { API_BASE } from '../api';
import type { SimFrame } from '../../../shared/api/ortho-patches.gen';
import type { OrthoImportResult, OrthoImportNoChangeReason } from '../../../shared/ortho-import';

/** What the upload seam needs to send one raw file. */
export interface UploadRequest {
    url: string;
    file: Blob;
    /** Bytes sent so far / total; called as the browser reports progress. */
    onProgress: (loaded: number, total: number) => void;
}

/** The server's answer, body still unparsed. */
export interface UploadResponse {
    status: number;
    body: string;
}

/** Upload seam: resolves with any HTTP answer, rejects only on a transport failure. */
export type UploadLike = (req: UploadRequest) => Promise<UploadResponse>;

/** Real implementation: a raw PUT with progress. No client timeout — the server
 * retiles inside the request and a large change takes minutes. */
export const xhrUpload: UploadLike = req => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', req.url);
    xhr.timeout = 0;
    xhr.setRequestHeader('Content-Type', 'image/png');
    xhr.upload.onprogress = e => {
        if (e.lengthComputable) req.onProgress(e.loaded, e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('upload aborted'));
    xhr.send(req.file);
});

/** A non-200 answer of the import route; `message` is the server's own text. */
export class OrthoImportError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'OrthoImportError';
    }
}

export class OrthoImportClient {
    constructor(
        private baseUrl: string = API_BASE,
        private uploadFn: UploadLike = xhrUpload,
    ) {}

    /**
     * Upload an edited export. `tolerance` is sent only when given: an explicit
     * value changes server behaviour (a JPEG import needs one).
     */
    async importPhoto(
        courseId: string,
        file: Blob,
        exportSeq: number,
        tolerance: number | null,
        onProgress: (loaded: number, total: number) => void,
    ): Promise<OrthoImportResult> {
        const params = [`exportSeq=${exportSeq}`];
        if (tolerance !== null) params.push(`tolerance=${tolerance}`);
        const url = `${this.baseUrl}/ortho-patches/import/${encodeURIComponent(courseId)}?${params.join('&')}`;
        const res = await this.uploadFn({ url, file, onProgress });
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(res.body);
        } catch {
            // A proxy's HTML error page: the status alone will have to do.
        }
        if (res.status !== 200) {
            const message = parsed && typeof (parsed as { error?: unknown }).error === 'string'
                ? (parsed as { error: string }).error
                : `HTTP ${res.status}`;
            throw new OrthoImportError(res.status, message);
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new OrthoImportError(res.status, 'The server answered with something unreadable.');
        }
        return parsed as OrthoImportResult;
    }
}

/** apiFetch's own client timeout rejects with this exact message. */
export function isRequestTimeout(err: unknown): boolean {
    return err instanceof Error && err.message === 'Request timeout';
}

// ── Import summary ────────────────────────────────────────────────────────────

/** Share of the frame above which the summary carries the strong warning. */
export const LARGE_CHANGE_FRACTION = 0.3;
/** Share of the frame above which the one-bounding-box note appears. */
export const WIDE_BOX_FRACTION = 0.1;

const MERC_HALF = 20037508.342789244;

export interface ImportSummary {
    changed: boolean;
    /** One line: what happened. */
    headline: string;
    /** Figures, one per line. */
    details: string[];
    /** Strong warning (more than 30 % of the frame changed); null otherwise. */
    warning: string | null;
    /** Short note that the stored patch is one bounding box; null for small boxes. */
    boxNote: string | null;
    /** Bounding box area over frame area; null without a frame or a change. */
    coverage: number | null;
    /** Approximate sim tiles rewritten across the zoom range; null without a change. */
    tiles: number | null;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

const NO_CHANGE: Record<OrthoImportNoChangeReason, (r: OrthoImportResult) => string> = {
    identical: r => `The image is identical to export ${r.exportSeq}.`,
    'below-min-area': r => `The differences were all smaller than ${fmt(r.minAreaPx)} pixels, so they were treated as noise.`,
    'outside-ortho': () => 'The changed pixels lie outside the ortho photo.',
};

/**
 * Count the web-mercator tiles that cover `b` at each zoom of `minzoom..maxzoom`
 * and sum them — the sim tiles an import rewrites (the server retiles the whole
 * subtree under the bounding box).
 */
export function countTiles(
    b: { west: number; south: number; east: number; north: number },
    minzoom: number,
    maxzoom: number,
): number {
    const span = MERC_HALF * 2;
    let total = 0;
    for (let z = minzoom; z <= maxzoom; z++) {
        const n = 2 ** z;
        const clamp = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
        const x0 = clamp(((b.west + MERC_HALF) / span) * n);
        const x1 = clamp(((b.east + MERC_HALF) / span) * n);
        const y0 = clamp(((MERC_HALF - b.north) / span) * n);
        const y1 = clamp(((MERC_HALF - b.south) / span) * n);
        total += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
    return total;
}

/** Turn the server's import answer into the panel's change summary. */
export function summarizeImport(
    r: OrthoImportResult,
    frame: SimFrame | null,
    zooms: { minzoom: number; maxzoom: number } = { minzoom: 14, maxzoom: 20 },
): ImportSummary {
    if (!r.changed || !r.bounds3006) {
        return {
            changed: false,
            headline: 'No changes found',
            details: [NO_CHANGE[r.reason ?? 'identical'](r)],
            warning: null,
            boxNote: null,
            coverage: null,
            tiles: null,
        };
    }
    const w = r.bounds3006.east - r.bounds3006.west;
    const h = r.bounds3006.north - r.bounds3006.south;
    let coverage: number | null = null;
    if (frame && frame.extent3006.length === 4) {
        const [e0, n0, e1, n1] = frame.extent3006;
        const area = (e1 - e0) * (n1 - n0);
        if (area > 0) coverage = (w * h) / area;
    }
    const tiles = r.bounds3857 ? countTiles(r.bounds3857, zooms.minzoom, zooms.maxzoom) : null;

    const details = [
        `${fmt(r.changedPixels)} changed pixels${r.regions ? ` in ${fmt(r.regions)} region${r.regions === 1 ? '' : 's'}` : ''}`,
        `Box ${fmt(w)} × ${fmt(h)} m${coverage !== null ? ` (${Math.round(coverage * 100)} % of the frame)` : ''}`,
    ];
    if (tiles !== null) details.push(`About ${fmt(tiles)} tiles rewritten (zoom ${zooms.minzoom} to ${zooms.maxzoom})`);

    const warning = coverage !== null && coverage > LARGE_CHANGE_FRACTION
        ? `The change covers ${Math.round(coverage * 100)} % of the frame. Check it is what you meant (a colour-profile change or a flattened layer marks the whole image). Revert last patch undoes it.`
        : null;
    const boxNote = coverage !== null && coverage >= WIDE_BOX_FRACTION
        ? 'The patch is stored as one box, so edits far apart rewrite everything between them.'
        : null;

    return {
        changed: true,
        headline: r.seq !== null ? `Imported as patch ${r.seq}` : 'Imported',
        details,
        warning,
        boxNote,
        coverage,
        tiles,
    };
}
