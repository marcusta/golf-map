/**
 * Builder-side photo pull (docs/feature-reference-photos.md §5.3). Used by the
 * `bun run photos-pull` CLI and by the builder's in-process interval.
 *
 * Per page of `GET /api/ingest/photos?since=<cursor>`: download the original
 * (unless retention already deleted it) and the preview when present, check
 * each against its sha256, upsert the row (local refined-pose fields are never
 * overwritten), install the files, then ack the page and save the cursor in
 * `data/photos/pull-state.json`. A photo whose site does not exist here is
 * skipped, reported, and not acked, so the VPS keeps its original; create the
 * site and rerun with `--reset` to pick it up. Reruns are idempotent: files
 * with a matching local hash are not downloaded again.
 */
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
    PHOTO_KINDS,
    PhotosService,
    type PhotoKind,
    type PullPage,
    type PullPhoto,
} from './photos.service';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface PullDeps {
    photos: PhotosService;
    baseUrl: string;
    token: string;
    fetch?: FetchFn;
    /** Page size for the list route. */
    pageSize?: number;
}

export interface PullReport {
    inserted: number;
    updated: number;
    unchanged: number;
    filesDownloaded: number;
    acked: number;
    /** Photos whose site does not exist on this builder. */
    skipped: Array<{ id: string; siteId: string }>;
    cursor: string;
}

interface PullState {
    cursor: string;
    updatedAt: string;
}

export function pullStatePath(dataDir: string): string {
    return path.join(dataDir, 'photos', 'pull-state.json');
}

export function readPullState(dataDir: string): PullState {
    const p = pullStatePath(dataDir);
    if (!existsSync(p)) return { cursor: '0', updatedAt: '' };
    try {
        const s = JSON.parse(readFileSync(p, 'utf8')) as Partial<PullState>;
        return { cursor: typeof s.cursor === 'string' ? s.cursor : '0', updatedAt: s.updatedAt ?? '' };
    } catch {
        return { cursor: '0', updatedAt: '' };
    }
}

function writePullState(dataDir: string, cursor: string): void {
    const p = pullStatePath(dataDir);
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }, null, 2));
    renameSync(tmp, p);
}

/**
 * Pulls every photo after the saved cursor. Throws on the first transport or
 * hash failure after saving progress up to the last fully processed photo.
 */
export async function pullPhotos(deps: PullDeps, opts: { reset?: boolean } = {}): Promise<PullReport> {
    const { photos } = deps;
    const doFetch: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    const base = deps.baseUrl.replace(/\/$/, '');
    const auth = { authorization: `Bearer ${deps.token}` };
    const dataDir = photos.dataDir;

    const report: PullReport = { inserted: 0, updated: 0, unchanged: 0, filesDownloaded: 0, acked: 0, skipped: [], cursor: '0' };
    let cursor = opts.reset ? '0' : readPullState(dataDir).cursor;
    report.cursor = cursor;

    const ack = async (ids: string[]): Promise<void> => {
        if (ids.length === 0) return;
        const res = await doFetch(`${base}/api/ingest/photos/ack`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error(`ack failed: HTTP ${res.status} ${await res.text()}`);
        report.acked += ((await res.json()) as { acked: number }).acked;
    };

    for (;;) {
        const qs = new URLSearchParams({ since: cursor, limit: String(deps.pageSize ?? 100) });
        const res = await doFetch(`${base}/api/ingest/photos?${qs}`, { headers: auth });
        if (!res.ok) throw new Error(`list failed: HTTP ${res.status} ${await res.text()}`);
        const page = (await res.json()) as PullPage;

        const toAck: string[] = [];
        let pageCursor = cursor;
        try {
            for (const photo of page.photos) {
                const outcome = await pullOne(deps, doFetch, base, auth, photo, report);
                if (outcome !== 'no-site') toAck.push(photo.id);
                pageCursor = photo.cursor;
            }
        } catch (err) {
            // Keep what was done: ack it and save the cursor up to the last
            // photo that went through, then surface the error.
            await ack(toAck);
            writePullState(dataDir, pageCursor);
            report.cursor = pageCursor;
            throw err;
        }
        await ack(toAck);
        cursor = page.nextCursor;
        writePullState(dataDir, cursor);
        report.cursor = cursor;
        if (!page.hasMore) break;
    }
    return report;
}

async function pullOne(
    deps: PullDeps,
    doFetch: FetchFn,
    base: string,
    auth: Record<string, string>,
    remote: PullPhoto,
    report: PullReport,
): Promise<'inserted' | 'updated' | 'unchanged' | 'no-site'> {
    const { photos } = deps;
    const outcome = await photos.upsertPulled(remote);
    if (outcome === 'no-site') {
        report.skipped.push({ id: remote.id, siteId: remote.siteId });
        return outcome;
    }
    report[outcome]++;

    for (const kind of PHOTO_KINDS) {
        const sha = kind === 'original' ? remote.originalSha256 : remote.previewSha256;
        if (sha === null) continue; // preview not uploaded yet; it re-lists when it arrives
        if (kind === 'original' && remote.originalDeletedAt !== null) continue; // retention removed it
        if (await photos.hasFile(remote.id, kind, sha)) continue;
        await download(photos, doFetch, base, auth, remote, kind, sha);
        report.filesDownloaded++;
    }
    return outcome;
}

async function download(
    photos: PhotosService,
    doFetch: FetchFn,
    base: string,
    auth: Record<string, string>,
    remote: PullPhoto,
    kind: PhotoKind,
    expectedSha: string,
): Promise<void> {
    const res = await doFetch(`${base}/api/ingest/photos/file/${encodeURIComponent(remote.id)}?kind=${kind}`, { headers: auth });
    if (!res.ok) throw new Error(`download ${remote.id} ${kind} failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (sha !== expectedSha) throw new Error(`download ${remote.id} ${kind}: sha256 ${sha} does not match ${expectedSha}`);

    const incoming = path.join(photos.dataDir, 'photos', '.incoming');
    mkdirSync(incoming, { recursive: true });
    const tmpPath = path.join(incoming, `pull-${remote.id}-${kind}-${process.pid}`);
    writeFileSync(tmpPath, bytes);
    await photos.installPulledFile(remote, kind, { tmpPath, sha256: sha, bytes: bytes.byteLength });
}

/** Env-based pull settings; null when `PUBLISH_URL` or `PUBLISH_TOKEN` is missing. */
export function pullConfigFromEnv(): { baseUrl: string; token: string } | null {
    const baseUrl = process.env.PUBLISH_URL;
    const token = process.env.PUBLISH_TOKEN;
    if (!baseUrl || !token) return null;
    return { baseUrl, token };
}

export function formatReport(r: PullReport): string {
    const lines = [
        `photos: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged; ${r.filesDownloaded} file(s) downloaded; ${r.acked} acked; cursor ${r.cursor}`,
    ];
    for (const s of r.skipped) lines.push(`  skipped ${s.id}: site ${s.siteId} does not exist on this builder`);
    return lines.join('\n');
}

