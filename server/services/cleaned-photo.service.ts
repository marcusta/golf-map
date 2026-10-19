import type { Kysely } from 'kysely';
import * as path from 'node:path';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Database } from '../db/schema';
import type { AssetsService, CourseAsset } from './assets.service';
import type { CoursesService } from './courses.service';
import { NotFoundError } from '@basics/core/server/auth';
import type { PipelineRunner } from './map-build.service';
import { courseSlug, venvPython } from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { resolveCourseMapBbox, type Bbox3006 } from './course-bbox';
import { innerSquareFrom3006 } from './terrain-square';
import {
    CLEANED_IMPORT_MAX_BYTES, CLEANED_PHOTO_SIZE,
    type CleanedImportResult,
} from '../../shared/cleaned-photo';

// --- Public types ---

/** Axis-aligned bounds; the CRS is named by the field carrying them. */
export interface PhotoBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** A rectangle of finished pixels for the photo, as the Clean tool sends it. */
export interface PixelPatch {
    /** Top-left corner in photo pixels. */
    x: number;
    y: number;
    w: number;
    h: number;
    /** `w * h * 4` raw RGBA bytes, row by row. Alpha is ignored. */
    rgba: Uint8Array;
}

export interface CleanedPhotoInfo {
    /** Whether the cleaned photo file exists yet (it is made on first use). */
    exists: boolean;
    /** Changes that can be undone, newest first out (at most `MAX_UNDO`). */
    undoDepth: number;
    /** Pixels per side of the cleaned photo. */
    size: number;
    /** The photo's square in EPSG:3006 metres: pixel (0, 0) is its north-west
     * corner. Null when the course has no built map. */
    bounds3006: PhotoBounds | null;
    /** Why the photo cannot be cleaned (a course without a built map). */
    reason?: string;
    /** The cleaned map layer's version stamp (null before the first change). */
    patchesGeneratedAt: string | null;
}

export interface CleanedPhotoResult {
    undoDepth: number;
    /** The bumped version stamp of the cleaned map layer (drives the
     * ortho-sim ?v=). The pristine tree's generatedAt is never touched. */
    patchesGeneratedAt: string;
}

/** The cleaned photo as an image file, for the download route. */
export interface CleanedExportFile {
    path: string;
    /** Download name, `<course>-cleaned-8192.png`. */
    file: string;
    bytes: number;
}

/** The cleaned photo's pixels as a file of raw RGB bytes (3 per pixel, row by row). */
export interface CleanedPixelsFile {
    path: string;
    bytes: number;
    /** Pixels per side. */
    size: number;
}

/** A pixel patch that does not fit the photo: a 400. */
export class InvalidPixelPatchError extends Error {}

/** The uploaded image is unusable: a 400. */
export class InvalidPhotoImportError extends Error {}

/** golfpipe exited non-zero. The message carries its stderr, which for the
 * cleaned-photo commands is written for the builder to read. */
export class PhotoPipelineError extends Error {}

export interface CleanedPhotoDeps {
    db: Kysely<Database>;
    assets: AssetsService;
    courses: CoursesService;
    /** Server data dir (sources/ + tiles/ live under it). */
    dataDir: string;
    /** golfpipe checkout dir; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to MAP_PIPELINE_PYTHON, then the pipeline venv's. */
    python?: string;
    /** Injected in tests to avoid spawning Python. */
    runner?: PipelineRunner;
}

/** How many earlier versions of the cleaned photo are kept for undo. */
export const MAX_UNDO = 5;

// Ortho tiles are built z14..z20 (map-build.service.ts): retile the same range.
const ORTHO_MINZOOM = 14;
const ORTHO_MAXZOOM = 20;

/** Image kinds the import takes, by the file's first bytes. */
const IMPORT_SIGNATURES: Array<{ ext: string; bytes: number[] }> = [
    { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { ext: 'tif', bytes: [0x49, 0x49, 0x2a, 0x00] },
    { ext: 'tif', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

/** `png` / `jpg` / `tif` for the start of an image file, null for anything else. */
export function importImageKind(head: Uint8Array): string | null {
    for (const sig of IMPORT_SIGNATURES) {
        if (head.length >= sig.bytes.length && sig.bytes.every((b, i) => head[i] === b)) return sig.ext;
    }
    return null;
}

function defaultRunner(python: string): PipelineRunner {
    return async (args, opts) => {
        const proc = Bun.spawn([python, ...args], {
            cwd: opts.cwd,
            env: opts.env,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { code, stdout, stderr };
    };
}

/** Filename for a persisted ortho vintage source GeoTIFF (mirrors map-build). */
function orthoSourceName(collection: string): string {
    return `ortho-${collection.replace(/[^A-Za-z0-9_-]+/g, '_')}.tif`;
}

function validBounds(b: PhotoBounds): boolean {
    return [b.west, b.south, b.east, b.north].every(Number.isFinite)
        && b.west < b.east && b.south < b.north;
}

/** The cleaned-photo commands print exactly one JSON line on stdout, last. */
function parseJsonLine<T>(stdout: string, command: string): T {
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    try {
        const doc = JSON.parse(line) as unknown;
        if (doc && typeof doc === 'object') return doc as T;
    } catch {
        // falls through to the error below
    }
    throw new Error(`${command} printed no JSON result: ${line.slice(0, 200)}`);
}

interface ReplaceStdout {
    changed: boolean;
    changedPixels: number;
    size: number;
    bounds3006?: PhotoBounds;
}

/** A validated client edit as golfpipe.patches reads it, minus its seq. */
type PreparedEdit = { entry: Record<string, unknown>; png: Buffer | null };

interface Site {
    siteId: string;
    courseName: string;
    manifestAsset: CourseAsset;
    /** The PRISTINE ortho of the built vintage; read, never written. */
    sourcePath: string;
    /** The inner terrain square, EPSG:3006. */
    square: Bbox3006;
}

/**
 * Photo cleaning for the golf simulator: ONE file per site is the cleaned
 * photo, `sources/<siteId>/ortho-<collection>.cleaned.tif`: 8192 x 8192 px RGB
 * on the inner terrain square (the square every GSPro ortho export and the
 * Unity textures use), made from the pristine photo on first use. Everything
 * works on that file directly (pipeline/golfpipe/cleaned.py):
 *
 *  - `pixelsFile`   hands its pixels out raw: what the Clean tool loads
 *                   into its pixel engine in the browser.
 *  - `writePixels`  writes a rectangle of finished pixels (one stroke of the
 *                   Clean tool) straight into it.
 *  - `exportImage`  hands it out as a PNG.
 *  - `importImage`  replaces it with any image of the same pixel size,
 *                   whatever it shows and wherever it came from.
 *  - `undo`         steps back to the version before the last change.
 *
 * There is no edit log to replay and nothing to export before importing. The
 * only other state is the undo history: a copy of the file from before each
 * of the last `MAX_UNDO` changes, in `sources/<siteId>/cleaned-history/`.
 *
 * ## Two photos on the map
 *
 * Cleaning is for the simulator only: the planning and playing imagery (web
 * planner, draw mode, iOS bundles) keeps the ORIGINAL photo. Changes are
 * therefore tiled into the sparse overlay `tiles/<siteId>/ortho-sim/` (only
 * the tiles a change touched; the tile route falls back to the pristine tile
 * elsewhere), which carries its own version stamp (`patchesGeneratedAt` in
 * the manifest). The pristine tree and its `generatedAt` are never touched.
 * Tiles under a change are cut from the 8192 px file, so they are a little
 * softer than the pristine tiles at the deepest zooms.
 *
 * A site cleaned under the retired patch-log model starts from its working
 * `ortho-<collection>.patched.tif`, so those edits carry over.
 */
export class CleanedPhotoService {
    private readonly db: Kysely<Database>;
    private readonly assets: AssetsService;
    private readonly courses: CoursesService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly python: string;
    private readonly runner: PipelineRunner;
    /** Per-site op chain: changes to one photo never interleave. */
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(deps: CleanedPhotoDeps) {
        this.db = deps.db;
        this.assets = deps.assets;
        this.courses = deps.courses;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? DEFAULT_PIPELINE_DIR;
        this.python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(this.python);
    }

    // --- Public API ---

    /**
     * What the Clean tool needs before it loads the photo: whether it exists,
     * where it lies, and how many changes can be undone.
     */
    async info(courseId: string): Promise<CleanedPhotoInfo> {
        const siteId = await this.siteIdForCourse(courseId);
        const none = { exists: false, undoDepth: 0, size: CLEANED_PHOTO_SIZE, bounds3006: null, patchesGeneratedAt: null };
        if (!siteId) return { ...none, reason: `Course ${courseId} has no map (no site): build the map first` };
        const manifestAsset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifestAsset?.metaJson) return { ...none, reason: `Site ${siteId} has no tile manifest: build the map first` };
        const patchesGeneratedAt = await this.readSimGeneratedAt(siteId);
        const resolved = await this.resolveOrthoSource(siteId, manifestAsset.metaJson);
        if ('reason' in resolved) return { ...none, patchesGeneratedAt, reason: resolved.reason };
        const [e0, n0, e1, n1] = (await this.resolveSite(courseId)).square;
        return {
            exists: await Bun.file(this.cleanedPath(resolved.sourcePath)).exists(),
            undoDepth: (await this.history(siteId)).length,
            size: CLEANED_PHOTO_SIZE,
            bounds3006: { west: e0, south: n0, east: e1, north: n1 },
            patchesGeneratedAt,
        };
    }

    /**
     * The photo's pixels as a file of raw RGB bytes, made from the pristine
     * photo first when the site has never been cleaned. The file is kept and
     * only written again when the photo changed since.
     */
    async pixelsFile(courseId: string): Promise<CleanedPixelsFile> {
        return this.enqueue(courseId, async (site) => {
            const cleaned = await this.ensureCleaned(site);
            const out = path.join(this.workDir(site.siteId), 'cleaned-pixels.rgb');
            const [photo, raw] = await Promise.all([stat(cleaned), stat(out).catch(() => null)]);
            if (!raw || raw.mtimeMs < photo.mtimeMs) {
                await this.runGolfpipe(['cleaned-export', '--cleaned', cleaned, '--out', out, '--format', 'rgb']);
            }
            return { path: out, bytes: (await stat(out)).size, size: CLEANED_PHOTO_SIZE };
        });
    }

    /**
     * Writes one rectangle of finished pixels into the cleaned photo and
     * rewrites the tiles under it. The Clean tool calls this after every
     * stroke. `snapshot` keeps the photo from before this write as an undo
     * step: the tool asks for it on the first write of an editing session, so
     * "Undo last change" steps back a whole session, not a stroke.
     */
    async writePixels(courseId: string, patch: PixelPatch, opts: { snapshot?: boolean } = {}): Promise<CleanedPhotoResult> {
        const { x, y, w, h, rgba } = patch;
        if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0 || x < 0 || y < 0
            || x + w > CLEANED_PHOTO_SIZE || y + h > CLEANED_PHOTO_SIZE) {
            throw new InvalidPixelPatchError(`The rectangle ${x},${y} ${w}x${h} is outside the ${CLEANED_PHOTO_SIZE} px photo`);
        }
        if (rgba.byteLength !== w * h * 4) {
            throw new InvalidPixelPatchError(`${rgba.byteLength} bytes is not ${w} x ${h} RGBA pixels`);
        }
        return this.enqueue(courseId, async (site) => {
            const cleaned = await this.ensureCleaned(site);
            await mkdir(this.workDir(site.siteId), { recursive: true });
            const dir = await mkdtemp(path.join(this.workDir(site.siteId), 'patch-'));
            try {
                await writeFile(path.join(dir, '0.rgba'), rgba);
                await writeFile(path.join(dir, 'patches.json'), JSON.stringify([{ x, y, w, h, file: '0.rgba' }]));
                const snapshot = opts.snapshot ? await this.snapshot(site.siteId, cleaned) : null;
                try {
                    await this.runGolfpipe(['cleaned-patch', '--cleaned', cleaned, '--patches-dir', dir,
                        ...this.tileArgs(site.siteId)]);
                } catch (err) {
                    if (snapshot) await this.restore(snapshot, cleaned);
                    throw err;
                }
                if (snapshot) await this.prune(site.siteId);
            } finally {
                await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
            return this.changed(site.siteId);
        });
    }

    /**
     * Steps the cleaned photo back to the version before its last change (a
     * bake of any size, or an import) and rewrites the tiles under what
     * differs. A no-op with nothing to undo.
     */
    async undo(courseId: string): Promise<CleanedPhotoResult> {
        return this.enqueue(courseId, async (site) => {
            const history = await this.history(site.siteId);
            const last = history[history.length - 1];
            if (last === undefined) {
                return { undoDepth: 0, patchesGeneratedAt: (await this.readSimGeneratedAt(site.siteId)) ?? '' };
            }
            const snapshot = this.snapshotPath(site.siteId, last);
            await this.runGolfpipe(['cleaned-replace', '--cleaned', this.cleanedPath(site.sourcePath),
                '--image', snapshot, ...this.tileArgs(site.siteId)]);
            await rm(snapshot, { force: true });
            return this.changed(site.siteId);
        });
    }

    /**
     * The cleaned photo as a PNG file to download, made from the pristine
     * photo first when the site has never been cleaned. The PNG is kept and
     * only re-encoded when the photo changed since.
     */
    async exportImage(courseId: string): Promise<CleanedExportFile> {
        return this.enqueue(courseId, async (site) => {
            const cleaned = await this.ensureCleaned(site);
            const out = path.join(this.workDir(site.siteId), 'cleaned-export.png');
            const [photo, png] = await Promise.all([stat(cleaned), stat(out).catch(() => null)]);
            if (!png || png.mtimeMs < photo.mtimeMs) {
                await this.runGolfpipe(['cleaned-export', '--cleaned', cleaned, '--out', out, '--format', 'png']);
            }
            return {
                path: out,
                file: `${courseSlug(site.courseName)}-cleaned-${CLEANED_PHOTO_SIZE}.png`,
                bytes: (await stat(out)).size,
            };
        });
    }

    /**
     * Where the import route streams the uploaded image for this course: a
     * fresh file under `sources/<siteId>/cleaned-work/`. Resolves the site
     * first, so an unknown course fails before any byte is stored.
     * `importImage` deletes the file; a caller that never gets there must.
     */
    async incomingImportPath(courseId: string): Promise<string> {
        const site = await this.resolveSite(courseId);
        const dir = this.workDir(site.siteId);
        await mkdir(dir, { recursive: true });
        return path.join(dir, `incoming-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }

    /**
     * Replaces the cleaned photo with the image at `tmpPath`: any PNG, JPEG
     * or TIFF of the photo's pixel size (8192 x 8192), whatever it shows.
     * Nothing has to be exported first. A partly transparent image is laid
     * over the photo. The previous photo goes into the undo history, the
     * tiles under the pixels that differ are rewritten, and an image
     * identical to the photo changes nothing. `tmpPath` is deleted in every
     * case.
     */
    async importImage(courseId: string, tmpPath: string): Promise<CleanedImportResult> {
        let image = tmpPath;
        try {
            const ext = await this.importKind(tmpPath);
            // golfpipe reads a GeoTIFF differently from a PNG: it goes by the name.
            image = `${tmpPath}.${ext}`;
            await rename(tmpPath, image);

            return await this.enqueue(courseId, async (site) => {
                const cleaned = await this.ensureCleaned(site);
                const snapshot = await this.snapshot(site.siteId, cleaned);
                let out: ReplaceStdout;
                try {
                    out = parseJsonLine<ReplaceStdout>(
                        await this.runGolfpipe(['cleaned-replace', '--cleaned', cleaned, '--image', image,
                            ...this.tileArgs(site.siteId)]),
                        'cleaned-replace');
                } catch (err) {
                    await this.restore(snapshot, cleaned);
                    throw err;
                }
                if (!out.changed) {
                    await rm(snapshot, { force: true });
                    return {
                        changed: false, changedPixels: 0, bounds3006: null, size: out.size,
                        undoDepth: (await this.history(site.siteId)).length,
                        patchesGeneratedAt: await this.readSimGeneratedAt(site.siteId),
                    };
                }
                await this.prune(site.siteId);
                return {
                    changed: true, changedPixels: out.changedPixels, bounds3006: out.bounds3006 ?? null, size: out.size,
                    ...(await this.changed(site.siteId)),
                };
            });
        } finally {
            await rm(image, { force: true }).catch(() => {});
            await rm(tmpPath, { force: true }).catch(() => {});
        }
    }

    /**
     * The cleaned photo file, made from the pristine photo first when the
     * site has never been cleaned: what a hole cleanup job works on a copy
     * of. `mtimeMs` tells a later step whether the photo changed since.
     */
    async photoFile(courseId: string): Promise<{ siteId: string; path: string; mtimeMs: number }> {
        return this.enqueue(courseId, async (site) => {
            const cleaned = await this.ensureCleaned(site);
            return { siteId: site.siteId, path: cleaned, mtimeMs: (await stat(cleaned)).mtimeMs };
        });
    }

    /** The upload's image kind by its first bytes, within the size cap. */
    private async importKind(tmpPath: string): Promise<string> {
        let size: number;
        const head = Buffer.alloc(8);
        try {
            size = (await stat(tmpPath)).size;
            const fh = await open(tmpPath, 'r');
            try {
                await fh.read(head, 0, head.length, 0);
            } finally {
                await fh.close();
            }
        } catch {
            throw new InvalidPhotoImportError('The uploaded image is missing');
        }
        if (size > CLEANED_IMPORT_MAX_BYTES) {
            throw new InvalidPhotoImportError(`Image too large (${size} bytes, max ${CLEANED_IMPORT_MAX_BYTES})`);
        }
        const ext = importImageKind(head);
        if (!ext) throw new InvalidPhotoImportError('The uploaded file is not a PNG, JPEG or TIFF image');
        return ext;
    }

    // --- The photo file and its undo history ---

    private cleanedPath(sourcePath: string): string {
        return sourcePath.replace(/\.tif$/i, '.cleaned.tif');
    }

    /** Scratch space of the service inside the site's sources (uploads, edit batches, the export PNG). */
    private workDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'cleaned-work');
    }

    private historyDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'cleaned-history');
    }

    private snapshotPath(siteId: string, n: number): string {
        return path.join(this.historyDir(siteId), `${n}.tif`);
    }

    /** The undo snapshots' numbers, oldest first. */
    private async history(siteId: string): Promise<number[]> {
        let names: string[];
        try {
            names = await readdir(this.historyDir(siteId));
        } catch {
            return [];
        }
        return names.flatMap(n => (/^\d+\.tif$/.test(n) ? [Number(n.slice(0, -4))] : [])).sort((a, b) => a - b);
    }

    /** Copies the photo into the undo history; returns the copy's path. */
    private async snapshot(siteId: string, cleaned: string): Promise<string> {
        await mkdir(this.historyDir(siteId), { recursive: true });
        const history = await this.history(siteId);
        const target = this.snapshotPath(siteId, (history[history.length - 1] ?? 0) + 1);
        await copyFile(cleaned, target);
        return target;
    }

    /** Puts a snapshot back as the photo after a failed change, and drops it. */
    private async restore(snapshot: string, cleaned: string): Promise<void> {
        await copyFile(snapshot, cleaned).catch(() => {});
        await rm(snapshot, { force: true }).catch(() => {});
    }

    /** Keeps the newest `MAX_UNDO` snapshots. */
    private async prune(siteId: string): Promise<void> {
        const history = await this.history(siteId);
        for (const n of history.slice(0, Math.max(0, history.length - MAX_UNDO))) {
            await rm(this.snapshotPath(siteId, n), { force: true }).catch(() => {});
        }
    }

    /**
     * The cleaned photo's path, creating the file on first use: from the
     * retired patch-log model's working raster when the site has a current
     * one (its edits carry over), else from the pristine photo.
     */
    private async ensureCleaned(site: Site): Promise<string> {
        const cleaned = this.cleanedPath(site.sourcePath);
        if (await Bun.file(cleaned).exists()) return cleaned;
        await mkdir(this.workDir(site.siteId), { recursive: true });
        const legacy = site.sourcePath.replace(/\.tif$/i, '.patched.tif');
        const [pristine, patched] = await Promise.all([stat(site.sourcePath), stat(legacy).catch(() => null)]);
        const from = patched && patched.mtimeMs >= pristine.mtimeMs ? legacy : site.sourcePath;
        await this.runGolfpipe(['cleaned-init', '--ortho', from, '--square-3006', site.square.join(','),
            '--out', cleaned, '--size', String(CLEANED_PHOTO_SIZE)]);
        return cleaned;
    }

    /** After a change: the new version stamp and what is left to undo. */
    private async changed(siteId: string): Promise<CleanedPhotoResult> {
        return {
            patchesGeneratedAt: await this.bumpSimVersion(siteId),
            undoDepth: (await this.history(siteId)).length,
        };
    }

    // --- Site / source resolution ---

    private async siteIdForCourse(courseId: string): Promise<string | null> {
        const course = await this.db
            .selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        return course.site_id ?? null;
    }

    /**
     * The course's site, the PRISTINE ortho of the vintage its map was built
     * from, and the inner terrain square: the same one the GSPro exports
     * resolve (`resolveCourseMapBbox`), so the cleaned photo and the Unity
     * textures share one square. Anything missing is a NotFound.
     */
    private async resolveSite(courseId: string): Promise<Site> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) throw new NotFoundError(`Course ${courseId} has no map (no site): build the map first`);
        const manifestAsset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifestAsset?.metaJson) {
            throw new NotFoundError(`Site ${siteId} has no tile manifest: build the map first`);
        }
        const resolved = await this.resolveOrthoSource(siteId, manifestAsset.metaJson);
        if ('reason' in resolved) throw new NotFoundError(resolved.reason);
        const { sweref, terrainSquare } = await resolveCourseMapBbox(this.courses, this.assets, courseId, 'clean the photo of');
        const course = await this.courses.get(courseId);
        return {
            siteId, manifestAsset, sourcePath: resolved.sourcePath, courseName: course.name,
            square: terrainSquare ?? innerSquareFrom3006(sweref),
        };
    }

    /**
     * Resolves the PRISTINE source GeoTIFF of the vintage the flat ortho tile
     * tree was BUILT from, or a human `reason` there is none. In order:
     *
     *  1. `builtOrtho`: the explicit built-vintage marker map-build records
     *     alongside the manifest (and re-terrain carries over).
     *  2. Legacy manifests without the marker: the newest recorded vintage
     *     (`orthoVintages[0]`), provided `activeOrtho` doesn't contradict
     *     it. A divergent `activeOrtho` is a leftover of the removed in-place
     *     vintage switcher: the flat tree's real vintage is unrecorded, so
     *     refuse rather than clean the wrong year's photo.
     *  3. Nothing recorded at all (pre-vintage legacy build) but exactly one
     *     `ortho-*.tif` in `sources/<siteId>/`: that sole source (logged).
     *
     * A NAMED vintage whose source tif is gone is always a refusal.
     */
    private async resolveOrthoSource(
        siteId: string,
        metaJson: string,
    ): Promise<{ sourcePath: string } | { reason: string }> {
        const meta = JSON.parse(metaJson) as {
            builtOrtho?: string;
            activeOrtho?: string;
            orthoVintages?: Array<{ collection: string }>;
        };
        const newest = meta.orthoVintages?.[0]?.collection;
        let collection = meta.builtOrtho;
        if (!collection) {
            if (newest && meta.activeOrtho && meta.activeOrtho !== newest) {
                return {
                    reason: `Site ${siteId} has ambiguous ortho vintage metadata (activeOrtho '${meta.activeOrtho}' `
                        + `vs newest recorded '${newest}'): rebuild the map before cleaning the photo`,
                };
            }
            collection = newest ?? meta.activeOrtho;
        }
        if (collection) {
            const sourcePath = path.join(this.dataDir, 'sources', siteId, orthoSourceName(collection));
            if (await Bun.file(sourcePath).exists()) return { sourcePath };
            return { reason: `Pristine ortho source missing: sources/${siteId}/${orthoSourceName(collection)}: rebuild the map` };
        }
        const fallback = await this.soleOrthoTif(siteId);
        if (fallback) {
            console.log(`[cleaned-photo] site ${siteId}: no ortho vintage recorded; falling back to the sole source ${path.basename(fallback)}`);
            return { sourcePath: fallback };
        }
        return { reason: `Site ${siteId} has no ortho vintage to clean: rebuild the map` };
    }

    /** The single pristine ortho source in `sources/<siteId>/`, or null if
     * there are zero or several. Working copies are not sources. */
    private async soleOrthoTif(siteId: string): Promise<string | null> {
        const dir = path.join(this.dataDir, 'sources', siteId);
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return null;
        }
        const tifs = names.filter(n => /^ortho-.+\.tif$/i.test(n) && !/\.(patched|cleaned)\.tif$/i.test(n));
        return tifs.length === 1 ? path.join(dir, tifs[0]) : null;
    }

    // --- Pipeline + versioning ---

    /** Where changed tiles go: the sparse sim overlay, parents filled from the read-only pristine tree. */
    private tileArgs(siteId: string): string[] {
        return [
            '--tiles-out', path.join(this.dataDir, 'tiles', siteId, 'ortho-sim'),
            '--pristine-tiles', path.join(this.dataDir, 'tiles', siteId, 'ortho'),
            '--minzoom', String(ORTHO_MINZOOM),
            '--maxzoom', String(ORTHO_MAXZOOM),
        ];
    }

    /** Runs one golfpipe command; resolves to its stdout. */
    private async runGolfpipe(args: string[]): Promise<string> {
        const result = await this.runner(['-m', 'golfpipe', ...args], {
            cwd: this.pipelineDir, env: { ...process.env },
        });
        if (result.code !== 0) {
            const raw = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
            // Progress lines come first on stderr; the reason is at the end.
            throw new PhotoPipelineError(`${args[0]} failed: ${raw.slice(-2000)}`);
        }
        return result.stdout;
    }

    /**
     * Bumps the cleaned map layer's version: rewrites `patchesGeneratedAt`
     * (ms precision, strictly monotonic) in BOTH the on-disk manifest.json
     * and the tile_manifest asset's metaJson; the web derives the ortho-sim
     * `?v=` cache-buster from it. The pristine `generatedAt` is never
     * touched: cleaning must not invalidate pristine tile caches.
     */
    private async bumpSimVersion(siteId: string): Promise<string> {
        const manifestPath = this.manifestPath(siteId);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        const prev = typeof manifest.patchesGeneratedAt === 'string' ? Date.parse(manifest.patchesGeneratedAt) : NaN;
        let ts = Date.now();
        if (Number.isFinite(prev) && ts <= prev) ts = prev + 1;
        const patchesGeneratedAt = new Date(ts).toISOString();
        manifest.patchesGeneratedAt = patchesGeneratedAt;
        const json = JSON.stringify(manifest);
        await writeFile(manifestPath, json);

        // Re-read the asset for a fresh optimistic-lock version.
        const asset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (asset) await this.assets.update(asset.id, asset.version, { metaJson: json });
        return patchesGeneratedAt;
    }

    private async readSimGeneratedAt(siteId: string): Promise<string | null> {
        try {
            const manifest = JSON.parse(await readFile(this.manifestPath(siteId), 'utf8')) as { patchesGeneratedAt?: string };
            return manifest.patchesGeneratedAt ?? null;
        } catch {
            return null;
        }
    }

    private manifestPath(siteId: string): string {
        return path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
    }

    // --- Serialization ---

    /** Chains ops per site so concurrent changes to one photo never interleave. */
    private async enqueue<T>(courseId: string, op: (site: Site) => Promise<T>): Promise<T> {
        const site = await this.resolveSite(courseId);
        const prev = this.queues.get(site.siteId) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(() => op(site));
        this.queues.set(site.siteId, run);
        try {
            return await run;
        } finally {
            if (this.queues.get(site.siteId) === run) this.queues.delete(site.siteId);
        }
    }
}
