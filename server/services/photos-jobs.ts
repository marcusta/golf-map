import { log } from '@basics/core/server/logger';
import type { PhotosService } from './photos.service';
import { formatReport, pullPhotos, type FetchFn } from './photos-pull';

/**
 * Wraps an async job so overlapping calls are skipped while one runs, and
 * errors are logged instead of thrown. Returns false when the call was skipped.
 */
export function singleFlight(name: string, job: () => Promise<void>): () => Promise<boolean> {
    let running = false;
    return async () => {
        if (running) return false;
        running = true;
        try {
            await job();
        } catch (err) {
            log.error({
                msg: `${name} failed`,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
        } finally {
            running = false;
        }
        return true;
    };
}

/**
 * Builder mode: runs the photo pull every `minutes` minutes, one run at a time
 * (§5.3). The first run starts one interval after boot. Returns a stop function.
 */
export function startPhotosPullInterval(opts: {
    photos: PhotosService;
    minutes: number;
    baseUrl: string;
    token: string;
    fetch?: FetchFn;
}): () => void {
    const run = singleFlight('photos pull', async () => {
        const report = await pullPhotos({ photos: opts.photos, baseUrl: opts.baseUrl, token: opts.token, fetch: opts.fetch });
        if (report.inserted + report.updated + report.filesDownloaded + report.skipped.length > 0) {
            log.info({ msg: 'photos pull', report: formatReport(report) });
        }
    });
    const timer = setInterval(() => void run(), opts.minutes * 60_000);
    return () => clearInterval(timer);
}

/**
 * Serve mode: deletes pulled originals past retention once at boot and then
 * daily (§5.4). Returns a stop function.
 */
export function startPhotoRetention(photos: PhotosService, intervalMs = 24 * 3_600_000): () => void {
    const run = singleFlight('photo retention', async () => {
        const { deleted } = await photos.purgePulledOriginals();
        if (deleted.length > 0) log.info({ msg: 'photo retention', deletedOriginals: deleted.length });
    });
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
}
