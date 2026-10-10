// Getting the cleaned photo out to an image editor and back: the download
// URL, the upload client and the one-line summary of an import. The upload is
// a raw route (`PUT /cleaned-photo/:courseId/import`, no generated client) and
// needs progress, which fetch cannot report: hence XMLHttpRequest behind
// `UploadLike`, so tests need no network.

import { API_BASE } from '../api';
import type { CleanedImportResult } from '../../../shared/cleaned-photo';

/** Where the cleaned photo downloads from, as a PNG. */
export function cleanedPhotoExportUrl(courseId: string, baseUrl: string = API_BASE): string {
    return `${baseUrl}/cleaned-photo/${encodeURIComponent(courseId)}/export.png`;
}

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

/** Real implementation: a raw PUT with progress. No client timeout: the server
 * retiles inside the request and a whole-photo change takes a while. */
export const xhrUpload: UploadLike = req => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', req.url);
    xhr.timeout = 0;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
        if (e.lengthComputable) req.onProgress(e.loaded, e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('upload aborted'));
    xhr.send(req.file);
});

/** A non-200 answer of the import route; `message` is the server's own text. */
export class PhotoImportError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'PhotoImportError';
    }
}

export class PhotoImportClient {
    constructor(
        private baseUrl: string = API_BASE,
        private uploadFn: UploadLike = xhrUpload,
    ) {}

    /** Upload an image to become the cleaned photo. */
    async importPhoto(
        courseId: string,
        file: Blob,
        onProgress: (loaded: number, total: number) => void,
    ): Promise<CleanedImportResult> {
        const url = `${this.baseUrl}/cleaned-photo/${encodeURIComponent(courseId)}/import`;
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
            throw new PhotoImportError(res.status, message);
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new PhotoImportError(res.status, 'The server answered with something unreadable.');
        }
        return parsed as CleanedImportResult;
    }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** What an import did, in one line for the panel. */
export function importSummaryText(r: CleanedImportResult): string {
    if (!r.changed || !r.bounds3006) return 'The image is the cleaned photo as it already was. Nothing changed.';
    const w = r.bounds3006.east - r.bounds3006.west;
    const h = r.bounds3006.north - r.bounds3006.south;
    const share = (r.changedPixels / (r.size * r.size)) * 100;
    const shareText = share >= 1 ? `${Math.round(share)} %` : 'under 1 %';
    return `Imported: ${fmt(r.changedPixels)} pixels changed (${shareText} of the photo), within ${fmt(w)} × ${fmt(h)} m. Undo puts the previous photo back.`;
}
