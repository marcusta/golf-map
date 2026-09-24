import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import * as path from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import type { Database, SitePhotosTable } from '../db/schema';
import { wgs84ToSweref99tm } from './geo';

/**
 * Reference photos (docs/feature-reference-photos.md §5). The phone creates the
 * row, then uploads the original HEIC and a JPEG preview. The VPS keeps both
 * until the builder pulls them; 14 days after the pull the original is deleted
 * and the row and preview stay.
 */

export const PHOTO_KINDS = ['original', 'preview'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const REFINE_METHODS = ['skyline', 'manual'] as const;
export type RefineMethod = (typeof REFINE_METHODS)[number];

/** File extension per kind. */
export const PHOTO_EXT: Record<PhotoKind, string> = { original: 'heic', preview: 'jpg' };
export const PHOTO_CONTENT_TYPE: Record<PhotoKind, string> = { original: 'image/heic', preview: 'image/jpeg' };

/** Largest accepted upload per file. */
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;

/** Days an original stays on the VPS after the builder acknowledged it. */
export const PHOTO_ORIGINAL_RETENTION_DAYS = 14;

/** Ids become file names, so only these characters are accepted. */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// --- Output types ---

export interface AttitudeQuat {
    w: number;
    x: number;
    y: number;
    z: number;
}

export interface Photo {
    id: string;
    siteId: string;
    courseId: string | null;
    hole: number | null;
    capturedAt: string;
    lat: number;
    lon: number;
    hAccM: number;
    gpsAltM: number | null;
    vAccM: number | null;
    x3006: number;
    y3006: number;
    attitudeQuat: AttitudeQuat | null;
    yawDeg: number;
    pitchDeg: number;
    rollDeg: number;
    headingAccDeg: number | null;
    magCalibration: number | null;
    hfovDeg: number;
    vfovDeg: number;
    width: number;
    height: number;
    eyeHeightM: number;
    deviceModel: string | null;
    lens: string;
    tags: string[];
    note: string | null;
    originalSha256: string | null;
    originalBytes: number | null;
    originalUploadedAt: string | null;
    originalDeletedAt: string | null;
    previewSha256: string | null;
    previewBytes: number | null;
    previewUploadedAt: string | null;
    pulledAt: string | null;
    refinedYawDeg: number | null;
    refinedPitchDeg: number | null;
    refinedRollDeg: number | null;
    refineMethod: RefineMethod | null;
    refineResidualDeg: number | null;
    refinedAt: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

/** A photo in the builder pull list, with its position in the pull order. */
export interface PullPhoto extends Photo {
    cursor: string;
}

export interface PullPage {
    photos: PullPhoto[];
    /** Pass as `since` for the next page. Equal to `since` when the page is empty. */
    nextCursor: string;
    hasMore: boolean;
}

// --- Input types ---

export interface CreatePhotoInput {
    id: string;
    siteId: string;
    courseId?: string | null;
    hole?: number | null;
    capturedAt: string;
    lat: number;
    lon: number;
    hAccM: number;
    gpsAltM?: number | null;
    vAccM?: number | null;
    attitudeQuat?: AttitudeQuat | null;
    yawDeg: number;
    pitchDeg: number;
    rollDeg: number;
    headingAccDeg?: number | null;
    magCalibration?: number | null;
    hfovDeg: number;
    vfovDeg: number;
    width: number;
    height: number;
    eyeHeightM?: number;
    deviceModel?: string | null;
    lens?: string;
    tags?: string[];
    note?: string | null;
}

export interface UpdatePhotoPatch {
    tags?: string[];
    note?: string | null;
    hole?: number | null;
}

export class InvalidPhotoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidPhotoError';
    }
}

/** 400: the body does not hash to the declared `X-Content-SHA256`. */
export class PhotoHashMismatchError extends InvalidPhotoError {
    constructor(expected: string, actual: string) {
        super(`Body sha256 ${actual} does not match X-Content-SHA256 ${expected}`);
        this.name = 'PhotoHashMismatchError';
    }
}

/** 409: the kind already has a file with a different hash. */
export class PhotoFileConflictError extends ConflictError {
    constructor(id: string, kind: PhotoKind) {
        super(`Photo ${id} already has a different ${kind} file`);
        this.name = 'PhotoFileConflictError';
    }
}

// --- Row mapping ---

type PhotoRow = Selectable<SitePhotosTable>;

function parseJson<T>(json: string | null, fallback: T): T {
    if (json === null) return fallback;
    try {
        return JSON.parse(json) as T;
    } catch {
        return fallback;
    }
}

function toPhoto(row: PhotoRow): Photo {
    return {
        id: row.id,
        siteId: row.site_id,
        courseId: row.course_id,
        hole: row.hole,
        capturedAt: row.captured_at,
        lat: row.lat,
        lon: row.lon,
        hAccM: row.h_acc_m,
        gpsAltM: row.gps_alt_m,
        vAccM: row.v_acc_m,
        x3006: row.x3006,
        y3006: row.y3006,
        attitudeQuat: parseJson<AttitudeQuat | null>(row.attitude_quat_json, null),
        yawDeg: row.yaw_deg,
        pitchDeg: row.pitch_deg,
        rollDeg: row.roll_deg,
        headingAccDeg: row.heading_acc_deg,
        magCalibration: row.mag_calibration,
        hfovDeg: row.hfov_deg,
        vfovDeg: row.vfov_deg,
        width: row.width,
        height: row.height,
        eyeHeightM: row.eye_height_m,
        deviceModel: row.device_model,
        lens: row.lens,
        tags: parseJson<string[]>(row.tags_json, []),
        note: row.note,
        originalSha256: row.original_sha256,
        originalBytes: row.original_bytes,
        originalUploadedAt: row.original_uploaded_at,
        originalDeletedAt: row.original_deleted_at,
        previewSha256: row.preview_sha256,
        previewBytes: row.preview_bytes,
        previewUploadedAt: row.preview_uploaded_at,
        pulledAt: row.pulled_at,
        refinedYawDeg: row.refined_yaw_deg,
        refinedPitchDeg: row.refined_pitch_deg,
        refinedRollDeg: row.refined_roll_deg,
        refineMethod: row.refine_method as RefineMethod | null,
        refineResidualDeg: row.refine_residual_deg,
        refinedAt: row.refined_at,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// --- Validation ---

function check(ok: boolean, message: string): void {
    if (!ok) throw new InvalidPhotoError(message);
}

const finite = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);

/** Range checks shared with the API schema (which rejects the same input with a 400 first). */
export function validateCreateInput(input: CreatePhotoInput): void {
    check(SAFE_ID_RE.test(input.id), `Invalid photo id: ${input.id}`);
    check(SAFE_ID_RE.test(input.siteId), `Invalid siteId: ${input.siteId}`);
    check(Number.isFinite(Date.parse(input.capturedAt)), `Invalid capturedAt: ${input.capturedAt}`);
    check(finite(input.lat) && input.lat >= -90 && input.lat <= 90, `lat out of range: ${input.lat}`);
    check(finite(input.lon) && input.lon >= -180 && input.lon <= 180, `lon out of range: ${input.lon}`);
    check(finite(input.hAccM) && input.hAccM >= 0, `hAccM out of range: ${input.hAccM}`);
    check(finite(input.yawDeg) && input.yawDeg >= 0 && input.yawDeg < 360, `yawDeg out of range [0, 360): ${input.yawDeg}`);
    check(finite(input.pitchDeg) && input.pitchDeg >= -90 && input.pitchDeg <= 90, `pitchDeg out of range [-90, 90]: ${input.pitchDeg}`);
    check(finite(input.rollDeg) && input.rollDeg > -180 && input.rollDeg <= 180, `rollDeg out of range (-180, 180]: ${input.rollDeg}`);
    check(finite(input.hfovDeg) && input.hfovDeg > 0 && input.hfovDeg < 180, `hfovDeg out of range (0, 180): ${input.hfovDeg}`);
    check(finite(input.vfovDeg) && input.vfovDeg > 0 && input.vfovDeg < 180, `vfovDeg out of range (0, 180): ${input.vfovDeg}`);
    check(Number.isInteger(input.width) && input.width > 0, `width must be a positive integer: ${input.width}`);
    check(Number.isInteger(input.height) && input.height > 0, `height must be a positive integer: ${input.height}`);
    if (input.hole != null) check(Number.isInteger(input.hole) && input.hole >= 1, `hole must be a positive integer: ${input.hole}`);
    if (input.eyeHeightM !== undefined) check(finite(input.eyeHeightM) && input.eyeHeightM >= 0, `eyeHeightM out of range: ${input.eyeHeightM}`);
    if (input.attitudeQuat != null) {
        const q = input.attitudeQuat;
        check([q.w, q.x, q.y, q.z].every(finite), 'attitudeQuat needs finite w, x, y, z');
    }
}

// --- Service ---

export interface PhotosDeps {
    db: Kysely<Database>;
    dataDir: string;
    /** Clock for file arrival, ack and retention timestamps. Tests inject a fixed one. */
    now?: () => Date;
}

export class PhotosService {
    private db: Kysely<Database>;
    readonly dataDir: string;
    private now: () => Date;

    constructor(deps: PhotosDeps) {
        this.db = deps.db;
        this.dataDir = deps.dataDir;
        this.now = deps.now ?? (() => new Date());
    }

    private nowIso(): string {
        return this.now().toISOString();
    }

    private byId(id: string) {
        return this.db.selectFrom('site_photos').selectAll().where('id', '=', id);
    }

    /** `data/photos/<siteId>/<id>.<ext>` for a kind. */
    filePath(photo: { id: string; siteId: string }, kind: PhotoKind): string {
        return path.join(this.dataDir, 'photos', photo.siteId, `${photo.id}.${PHOTO_EXT[kind]}`);
    }

    async get(id: string): Promise<Photo> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Photo ${id} not found`);
        return toPhoto(row);
    }

    /** Photos of a site, newest capture first. */
    async listBySite(siteId: string): Promise<Photo[]> {
        const rows = await this.db
            .selectFrom('site_photos')
            .selectAll()
            .where('site_id', '=', siteId)
            .orderBy('captured_at', 'desc')
            .orderBy('id', 'desc')
            .execute();
        return rows.map(toPhoto);
    }

    /**
     * Creates the row. Idempotent by `id`: a repeat returns the stored row
     * unchanged, whatever the body says, so the phone can retry blindly.
     */
    async create(input: CreatePhotoInput): Promise<Photo> {
        const existing = await this.byId(input.id).executeTakeFirst();
        if (existing) return toPhoto(existing);

        validateCreateInput(input);
        const site = await this.db.selectFrom('sites').select('id').where('id', '=', input.siteId).executeTakeFirst();
        if (!site) throw new NotFoundError(`Site ${input.siteId} not found`);

        const { x, y } = wgs84ToSweref99tm(input.lat, input.lon);
        await this.db
            .insertInto('site_photos')
            .values({
                id: input.id,
                site_id: input.siteId,
                course_id: input.courseId ?? null,
                hole: input.hole ?? null,
                captured_at: input.capturedAt,
                lat: input.lat,
                lon: input.lon,
                h_acc_m: input.hAccM,
                gps_alt_m: input.gpsAltM ?? null,
                v_acc_m: input.vAccM ?? null,
                x3006: x,
                y3006: y,
                attitude_quat_json: input.attitudeQuat ? JSON.stringify(input.attitudeQuat) : null,
                yaw_deg: input.yawDeg,
                pitch_deg: input.pitchDeg,
                roll_deg: input.rollDeg,
                heading_acc_deg: input.headingAccDeg ?? null,
                mag_calibration: input.magCalibration ?? null,
                hfov_deg: input.hfovDeg,
                vfov_deg: input.vfovDeg,
                width: input.width,
                height: input.height,
                eye_height_m: input.eyeHeightM ?? 1.5,
                device_model: input.deviceModel ?? null,
                lens: input.lens ?? 'wide',
                tags_json: JSON.stringify(input.tags ?? []),
                note: input.note ?? null,
                version: 1,
            })
            // A concurrent create of the same id loses the race quietly and
            // returns the winner's row below.
            .onConflict((oc) => oc.column('id').doNothing())
            .execute();
        return this.get(input.id);
    }

    /** Edits tags, note or hole under optimistic locking. File arrivals never bump `version`. */
    async update(id: string, version: number, patch: UpdatePhotoPatch): Promise<Photo> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Photo ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('site_photos', id);
        if (patch.hole != null) check(Number.isInteger(patch.hole) && patch.hole >= 1, `hole must be a positive integer: ${patch.hole}`);

        const set: Record<string, unknown> = {};
        if (patch.tags !== undefined) set.tags_json = JSON.stringify(patch.tags);
        if (patch.note !== undefined) set.note = patch.note;
        if (patch.hole !== undefined) set.hole = patch.hole;

        await this.db
            .updateTable('site_photos')
            .where('id', '=', id)
            .set({
                ...set,
                version: version + 1,
                updated_at: sql`(datetime('now'))`,
                // Re-list the edit for the builder pull once the original has arrived.
                ...(row.original_sha256 !== null ? { upload_seq: this.nextSeq() } : {}),
            })
            .execute();
        return this.get(id);
    }

    /** Deletes the row and both files. */
    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Photo ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('site_photos', id);
        await this.db.deleteFrom('site_photos').where('id', '=', id).execute();
        const photo = toPhoto(row);
        for (const kind of PHOTO_KINDS) rmSync(this.filePath(photo, kind), { force: true });
    }

    /** `MAX(upload_seq) + 1`, evaluated inside the UPDATE that uses it. */
    private nextSeq() {
        return sql<number>`(SELECT COALESCE(MAX(upload_seq), 0) + 1 FROM site_photos)`;
    }

    /**
     * Records an uploaded file already written to `tmpPath` (hashed by the
     * caller while streaming). The temp file is renamed into place or removed.
     *
     * - declared hash != actual hash: `PhotoHashMismatchError` (400)
     * - same hash as the stored file: `'unchanged'` (200)
     * - different hash than the stored file: `PhotoFileConflictError` (409)
     */
    async storeUploadedFile(
        id: string,
        kind: PhotoKind,
        file: { tmpPath: string; sha256: string; bytes: number; declaredSha256: string },
    ): Promise<{ status: 'stored' | 'unchanged'; photo: Photo }> {
        try {
            const declared = file.declaredSha256.toLowerCase();
            if (declared !== file.sha256) throw new PhotoHashMismatchError(declared, file.sha256);
            const photo = await this.get(id);
            const stored = kind === 'original' ? photo.originalSha256 : photo.previewSha256;
            if (stored !== null) {
                if (stored !== file.sha256) throw new PhotoFileConflictError(id, kind);
                return { status: 'unchanged', photo };
            }
            const updated = await this.installFile(photo, kind, file.tmpPath, file.sha256, file.bytes, { bumpSeq: true });
            return { status: 'stored', photo: updated };
        } finally {
            rmSync(file.tmpPath, { force: true });
        }
    }

    /** Atomic rename into `data/photos/<site>/<id>.<ext>` plus the row update. */
    private async installFile(
        photo: Photo,
        kind: PhotoKind,
        tmpPath: string,
        sha256: string,
        bytes: number,
        opts: { bumpSeq: boolean; uploadedAt?: string },
    ): Promise<Photo> {
        const dest = this.filePath(photo, kind);
        mkdirSync(path.dirname(dest), { recursive: true });
        renameSync(tmpPath, dest);
        const at = opts.uploadedAt ?? this.nowIso();
        const set =
            kind === 'original'
                ? { original_sha256: sha256, original_bytes: bytes, original_uploaded_at: at }
                : { preview_sha256: sha256, preview_bytes: bytes, preview_uploaded_at: at };
        await this.db
            .updateTable('site_photos')
            .where('id', '=', photo.id)
            .set({
                ...set,
                // The pull list only shows photos whose original arrived; a
                // later preview re-lists the photo so the builder fetches it.
                ...(opts.bumpSeq && (kind === 'original' || photo.originalSha256 !== null)
                    ? { upload_seq: this.nextSeq() }
                    : {}),
                updated_at: sql`(datetime('now'))`,
            })
            .execute();
        return this.get(photo.id);
    }

    /** Path of a stored file for download, or NotFoundError when absent. */
    async fileFor(id: string, kind: PhotoKind): Promise<{ path: string; sha256: string; photo: Photo }> {
        const photo = await this.get(id);
        const sha = kind === 'original' ? photo.originalSha256 : photo.previewSha256;
        const deleted = kind === 'original' && photo.originalDeletedAt !== null;
        const p = this.filePath(photo, kind);
        if (sha === null || deleted || !existsSync(p)) throw new NotFoundError(`Photo ${id} has no ${kind} file`);
        return { path: p, sha256: sha, photo };
    }

    // --- Builder pull (VPS side) ---

    /**
     * Photos whose original has arrived, in `upload_seq` order after the cursor.
     * The cursor is the decimal `upload_seq` of the last photo seen ("0" or
     * empty = from the start). A photo re-appears with a higher cursor when its
     * preview arrives or its metadata is edited.
     */
    async listForPull(since: string | undefined, limit = 100): Promise<PullPage> {
        const sinceSeq = parseCursor(since);
        const take = Math.max(1, Math.min(500, Math.floor(limit)));
        const rows = await this.db
            .selectFrom('site_photos')
            .selectAll()
            .where('upload_seq', 'is not', null)
            .where('upload_seq', '>', sinceSeq)
            .orderBy('upload_seq')
            .limit(take + 1)
            .execute();
        const page = rows.slice(0, take);
        const photos = page.map((r) => ({ ...toPhoto(r), cursor: String(r.upload_seq) }));
        return {
            photos,
            nextCursor: photos.length > 0 ? photos[photos.length - 1].cursor : String(sinceSeq),
            hasMore: rows.length > take,
        };
    }

    /**
     * The builder's acknowledgement. Sets `pulledAt` for known ids that have
     * none yet; the retention clock runs from the first pull. Unknown ids are
     * ignored.
     */
    async ack(ids: string[]): Promise<{ acked: number }> {
        if (ids.length === 0) return { acked: 0 };
        // The Bun SQLite dialect does not report numUpdatedRows, so select first.
        return this.db.transaction().execute(async (trx) => {
            const rows = await trx
                .selectFrom('site_photos')
                .select('id')
                .where('id', 'in', ids)
                .where('pulled_at', 'is', null)
                .execute();
            if (rows.length === 0) return { acked: 0 };
            await trx
                .updateTable('site_photos')
                .where('id', 'in', rows.map((r) => r.id))
                .set({ pulled_at: this.nowIso(), updated_at: sql`(datetime('now'))` })
                .execute();
            return { acked: rows.length };
        });
    }

    /**
     * Retention (serve mode, daily): deletes originals pulled more than
     * `PHOTO_ORIGINAL_RETENTION_DAYS` ago and sets `originalDeletedAt`. The row,
     * its hashes and the preview stay.
     */
    async purgePulledOriginals(): Promise<{ deleted: string[] }> {
        const now = this.now();
        const cutoff = new Date(now.getTime() - PHOTO_ORIGINAL_RETENTION_DAYS * 86_400_000).toISOString();
        const rows = await this.db
            .selectFrom('site_photos')
            .selectAll()
            .where('pulled_at', 'is not', null)
            .where('pulled_at', '<=', cutoff)
            .where('original_sha256', 'is not', null)
            .where('original_deleted_at', 'is', null)
            .execute();
        const deleted: string[] = [];
        for (const row of rows) {
            rmSync(this.filePath(toPhoto(row), 'original'), { force: true });
            await this.db
                .updateTable('site_photos')
                .where('id', '=', row.id)
                .set({ original_deleted_at: now.toISOString(), updated_at: sql`(datetime('now'))` })
                .execute();
            deleted.push(row.id);
        }
        return { deleted };
    }

    // --- Builder pull (builder side) ---

    /**
     * Inserts or updates a row pulled from the VPS. Sensor and file metadata
     * come from the VPS; the local refined-pose fields are never touched.
     * Returns what happened, or `'no-site'` when the site does not exist here.
     */
    async upsertPulled(remote: Photo): Promise<'inserted' | 'updated' | 'unchanged' | 'no-site'> {
        const site = await this.db.selectFrom('sites').select('id').where('id', '=', remote.siteId).executeTakeFirst();
        if (!site) return 'no-site';

        const fields = {
            site_id: remote.siteId,
            course_id: remote.courseId,
            hole: remote.hole,
            captured_at: remote.capturedAt,
            lat: remote.lat,
            lon: remote.lon,
            h_acc_m: remote.hAccM,
            gps_alt_m: remote.gpsAltM,
            v_acc_m: remote.vAccM,
            x3006: remote.x3006,
            y3006: remote.y3006,
            attitude_quat_json: remote.attitudeQuat ? JSON.stringify(remote.attitudeQuat) : null,
            yaw_deg: remote.yawDeg,
            pitch_deg: remote.pitchDeg,
            roll_deg: remote.rollDeg,
            heading_acc_deg: remote.headingAccDeg,
            mag_calibration: remote.magCalibration,
            hfov_deg: remote.hfovDeg,
            vfov_deg: remote.vfovDeg,
            width: remote.width,
            height: remote.height,
            eye_height_m: remote.eyeHeightM,
            device_model: remote.deviceModel,
            lens: remote.lens,
            tags_json: JSON.stringify(remote.tags),
            note: remote.note,
        };

        const local = await this.byId(remote.id).executeTakeFirst();
        if (!local) {
            await this.db
                .insertInto('site_photos')
                .values({ id: remote.id, ...fields, pulled_at: this.nowIso(), version: 1 })
                .execute();
            return 'inserted';
        }
        const changed = (Object.keys(fields) as Array<keyof typeof fields>).some((k) => local[k] !== fields[k]);
        if (!changed) return 'unchanged';
        await this.db
            .updateTable('site_photos')
            .where('id', '=', remote.id)
            .set({ ...fields, version: local.version + 1, updated_at: sql`(datetime('now'))` })
            .execute();
        return 'updated';
    }

    /**
     * Installs a file downloaded from the VPS (hash already verified) and
     * records it with the VPS arrival time. No-op when the local file has the
     * same hash.
     */
    async installPulledFile(
        remote: Photo,
        kind: PhotoKind,
        file: { tmpPath: string; sha256: string; bytes: number },
    ): Promise<void> {
        try {
            const local = await this.get(remote.id);
            const uploadedAt = kind === 'original' ? remote.originalUploadedAt : remote.previewUploadedAt;
            await this.installFile(local, kind, file.tmpPath, file.sha256, file.bytes, {
                bumpSeq: false,
                uploadedAt: uploadedAt ?? undefined,
            });
        } finally {
            rmSync(file.tmpPath, { force: true });
        }
    }

    /** True when the local row already has this kind's file with this hash on disk. */
    async hasFile(id: string, kind: PhotoKind, sha256: string): Promise<boolean> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) return false;
        const photo = toPhoto(row);
        const stored = kind === 'original' ? photo.originalSha256 : photo.previewSha256;
        return stored === sha256 && existsSync(this.filePath(photo, kind));
    }
}

/** Decimal non-negative integer cursor; empty or absent means 0. */
export function parseCursor(since: string | undefined): number {
    if (since === undefined || since === '') return 0;
    if (!/^\d{1,15}$/.test(since)) throw new InvalidPhotoError(`Invalid cursor: ${since}`);
    return Number(since);
}

export function isPhotoKind(v: string | undefined): v is PhotoKind {
    return v !== undefined && (PHOTO_KINDS as readonly string[]).includes(v);
}

export function isSha256Hex(v: string): boolean {
    return SHA256_RE.test(v.toLowerCase());
}
