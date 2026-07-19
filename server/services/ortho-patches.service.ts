import type { Kysely } from 'kysely';
import * as path from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Database } from '../db/schema';
import type { AssetsService, CourseAsset } from './assets.service';
import { NotFoundError } from '@basics/core/server/auth';
import type { PipelineRunner } from './map-build.service';

// --- Public types ---

/** Axis-aligned bounds; the CRS is named by the field carrying them. */
export interface PatchBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface OrthoPatchInput {
    /** MASK PNG (white/opaque = pixel to inpaint), base64 (no data-URL
     * prefix). The fill is computed server-side by LaMa against the pristine
     * source — the client's locally-inpainted preview pixels are never
     * baked (they carry WebP-lossy tile provenance and would seam). */
    maskPngBase64: string;
    /** The mask's EXACT frame: the tile crop's EPSG:3857 rectangle. */
    bounds3857: PatchBounds;
    /** EPSG:3006 bbox of the same area — informational, for the log/UI. */
    boundsSweref: PatchBounds;
    /** Mask mode that produced it ('sam' | 'ellipse'). */
    tool: string;
}

export interface OrthoPatchesInfo {
    count: number;
    lastCreatedAt: string | null;
    lastTool: string | null;
    /** Whether accepted patches can be baked onto the pristine ortho + tiles
     * right now (false on legacy courses with no persisted source). */
    bakeable: boolean;
    /** Human reason cleaning can only preview (present when !bakeable). */
    reason?: string;
}

export interface OrthoPatchResult {
    count: number;
    /** The bumped tile-manifest generatedAt (drives the ?v= cache-buster). */
    generatedAt: string;
}

interface PatchLogEntry {
    seq: number;
    file: string;
    bounds3857: PatchBounds;
    boundsSweref: PatchBounds;
    tool: string;
    createdAt: string;
}

/** Version 2: entries are MASKS (server-side inpaint). Version 1 stored
 * pre-rendered fill pixels; a non-empty v1 log is refused, never misread. */
interface PatchLog {
    version: 2;
    patches: PatchLogEntry[];
}

export interface OrthoPatchesDeps {
    db: Kysely<Database>;
    assets: AssetsService;
    /** Server data dir (sources/ + tiles/ live under it). */
    dataDir: string;
    /** golfpipe checkout dir; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to `<pipelineDir>/.venv/bin/python`. */
    python?: string;
    /** LaMa TorchScript checkpoint; defaults to $GOLFPIPE_LAMA_WEIGHTS or
     * `<repo>/data/models/big-lama.pt` (the assist sidecar's convention). */
    lamaWeights?: string;
    /** Injected in tests to avoid spawning Python. */
    runner?: PipelineRunner;
}

const MAX_PATCH_PNG_BYTES = 24 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Ortho tiles are built z14..z20 (map-build.service.ts) — retile the same range.
const ORTHO_MINZOOM = 14;
const ORTHO_MAXZOOM = 20;

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

function validBounds(b: PatchBounds): boolean {
    return [b.west, b.south, b.east, b.north].every(Number.isFinite)
        && b.west < b.east && b.south < b.north;
}

function boundsArg(b: PatchBounds): string {
    return `${b.west},${b.south},${b.east},${b.north}`;
}

/**
 * Interactive ortho photo cleaning (T55, reworked to seam-free windowed
 * baking): stores accepted patches as a REPLAYABLE LOG of MASKS under
 * `data/sources/<siteId>/patches/` (`<n>.png` mask + `patches.json`,
 * version 2) — the pristine source ortho is never modified.
 *
 * The client previews a locally-inpainted crop but on accept sends only the
 * MASK; the fill is computed server-side by `golfpipe bake-ortho-patch`,
 * which LaMa-inpaints a context window of the working `.patched.tif`
 * (pristine + prior patches, created lazily) and rewrites only that mask's
 * tile-pyramid subtree — no full-raster rewrite per accept. Baking against
 * source pixels (instead of pasting the client's WebP-lossy, mercator-
 * resampled tile pixels) is what eliminates the visible patch seam.
 *
 * Revert (and any rebuild after a vintage change) runs the FULL replay
 * (`golfpipe apply-ortho-patches`): pristine copy + every logged mask
 * re-inpainted in order. Because fills are regenerated by the model, a
 * replay is visually equivalent — NOT byte-identical — to the bakes it
 * replaces; the mask log, not the fill bytes, is the source of truth
 * (accepted by design).
 *
 * Every apply/revert bumps the tile manifest's `generatedAt` so the `?v=`
 * cache-buster changes and clients refetch (tile responses carry year-long
 * immutable cache headers).
 */
export class OrthoPatchesService {
    private readonly db: Kysely<Database>;
    private readonly assets: AssetsService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly python: string;
    private readonly lamaWeights: string;
    private readonly runner: PipelineRunner;
    /** Per-site op chain: applies/reverts for one map never interleave. */
    private readonly queues = new Map<string, Promise<unknown>>();
    /** Cached inpaint-deps pre-flight (torch importable in the venv). */
    private torchCheck: Promise<boolean> | null = null;

    constructor(deps: OrthoPatchesDeps) {
        this.db = deps.db;
        this.assets = deps.assets;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? path.resolve(process.cwd(), '../pipeline');
        this.python = deps.python ?? path.join(this.pipelineDir, '.venv', 'bin', 'python');
        this.lamaWeights = deps.lamaWeights
            ?? process.env.GOLFPIPE_LAMA_WEIGHTS
            ?? path.resolve(this.pipelineDir, '..', 'data', 'models', 'big-lama.pt');
        this.runner = deps.runner ?? defaultRunner(this.python);
    }

    // --- Public API ---

    /**
     * Patch count + last-entry summary for the course's map (site), plus a
     * pre-flight `bakeable` flag (+ `reason`) computed by the SAME source
     * resolution the bake uses — so the Clean panel can gate "Accept & bake"
     * up front instead of failing late (legacy/unbuilt courses can only
     * preview).
     */
    async info(courseId: string): Promise<OrthoPatchesInfo> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) {
            return {
                count: 0, lastCreatedAt: null, lastTool: null,
                bakeable: false,
                reason: `Course ${courseId} has no map (no site) — build the map first`,
            };
        }
        const log = await this.readLog(siteId);
        const last = log.patches[log.patches.length - 1] ?? null;
        const bake = await this.checkBakeable(siteId);
        return {
            count: log.patches.length,
            lastCreatedAt: last?.createdAt ?? null,
            lastTool: last?.tool ?? null,
            ...bake,
        };
    }

    /**
     * Pre-flight for the Clean panel: can accepted patches actually bake?
     * Runs the same resolution the bake uses (manifest present + a pristine
     * ortho source resolvable) PLUS the server-side inpaint requirements
     * (LaMa weights on disk, torch importable in the pipeline venv),
     * reporting the blocking reason rather than failing late at accept.
     */
    private async checkBakeable(siteId: string): Promise<{ bakeable: boolean; reason?: string }> {
        const manifestAsset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifestAsset?.metaJson) {
            return { bakeable: false, reason: `Site ${siteId} has no tile manifest — build the map first` };
        }
        const resolved = await this.resolveOrthoSource(siteId, manifestAsset.metaJson);
        if ('reason' in resolved) return { bakeable: false, reason: resolved.reason };
        return this.checkInpaintDeps();
    }

    /**
     * The bake now inpaints server-side, so the pipeline venv needs the
     * optional torch extra and the big-lama checkpoint. Torch's import probe
     * costs a couple of seconds, so it is cached for the process lifetime;
     * the weights file is re-checked each time (downloadable while running).
     */
    private async checkInpaintDeps(): Promise<{ bakeable: boolean; reason?: string }> {
        if (!(await Bun.file(this.lamaWeights).exists())) {
            return {
                bakeable: false,
                reason: `LaMa weights missing at ${this.lamaWeights} — download big-lama.pt (see pipeline/README.md)`,
            };
        }
        this.torchCheck ??= this.runner(['-c', 'import torch'], {
            cwd: this.pipelineDir, env: { ...process.env },
        }).then(r => r.code === 0, () => false);
        if (!(await this.torchCheck)) {
            return {
                bakeable: false,
                reason: 'Inpaint dependencies (torch) missing in the pipeline venv — '
                    + 'cd pipeline && ./.venv/bin/pip install -r requirements-inpaint.txt',
            };
        }
        return { bakeable: true };
    }

    /**
     * Stores one accepted mask (png + log entry) and bakes it INCREMENTALLY:
     * `golfpipe bake-ortho-patch` runs one windowed LaMa inpaint into the
     * working `.patched.tif` (created lazily from pristine on first patch)
     * and retiles only that mask's subtree, then the tile version bumps. On
     * pipeline failure the stored mask is rolled back — the log only ever
     * describes what the tiles show.
     */
    async apply(courseId: string, input: OrthoPatchInput): Promise<OrthoPatchResult> {
        return this.enqueue(courseId, async (site) => {
            const png = this.decodeMaskPng(input.maskPngBase64);
            if (!validBounds(input.bounds3857) || !validBounds(input.boundsSweref)) {
                throw new Error('Patch bounds are degenerate (need finite west < east, south < north)');
            }
            if (!input.tool || input.tool.length > 40) throw new Error('Patch tool label is missing/too long');

            const dir = this.patchesDir(site.siteId);
            await mkdir(dir, { recursive: true });
            const log = await this.readLog(site.siteId);
            const seq = (log.patches[log.patches.length - 1]?.seq ?? 0) + 1;
            const file = `${seq}.png`;
            const entry: PatchLogEntry = {
                seq,
                file,
                bounds3857: input.bounds3857,
                boundsSweref: input.boundsSweref,
                tool: input.tool,
                createdAt: new Date().toISOString(),
            };
            await writeFile(path.join(dir, file), png);
            await this.writeLog(site.siteId, { ...log, patches: [...log.patches, entry] });

            try {
                await this.bakeOne(site, seq);
            } catch (err) {
                // Roll back: the failed patch must not linger in the log.
                await this.writeLog(site.siteId, log).catch(() => {});
                await rm(path.join(dir, file), { force: true }).catch(() => {});
                throw err;
            }

            const generatedAt = await this.bumpTileVersion(site.siteId);
            return { count: log.patches.length + 1, generatedAt };
        });
    }

    /**
     * Revert v1: drops the LAST log entry, re-replays the remaining log
     * (full replay from pristine — remaining fills are REGENERATED by LaMa,
     * visually equivalent but not byte-identical to the original bakes), and
     * retiles the reverted patch's bounds too (its tiles must rewrite from
     * the now-unpatched raster). No-op result when the log is empty.
     */
    async revertLast(courseId: string): Promise<OrthoPatchResult> {
        return this.enqueue(courseId, async (site) => {
            const log = await this.readLog(site.siteId);
            const last = log.patches[log.patches.length - 1];
            if (!last) return { count: 0, generatedAt: await this.readGeneratedAt(site.siteId) };

            const remaining: PatchLog = { ...log, patches: log.patches.slice(0, -1) };
            await this.writeLog(site.siteId, remaining);
            try {
                await this.replay(site, [last.bounds3857]);
            } catch (err) {
                await this.writeLog(site.siteId, log).catch(() => {});
                throw err;
            }
            await rm(path.join(this.patchesDir(site.siteId), last.file), { force: true }).catch(() => {});

            const generatedAt = await this.bumpTileVersion(site.siteId);
            return { count: remaining.patches.length, generatedAt };
        });
    }

    // --- Site / source resolution ---

    private async siteIdForCourse(courseId: string): Promise<string | null> {
        const course = await this.db
            .selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        return course.site_id ?? null;
    }

    /**
     * The patchable map for a course: its site, the tile_manifest asset, and
     * the PRISTINE source GeoTIFF of the ACTIVE (flat-tree) ortho vintage.
     * Patching requires a built map — anything missing is a NotFound.
     */
    private async resolveSite(courseId: string): Promise<{
        siteId: string;
        manifestAsset: CourseAsset;
        sourcePath: string;
    }> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) throw new NotFoundError(`Course ${courseId} has no map (no site) — build the map first`);
        const manifestAsset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifestAsset?.metaJson) {
            throw new NotFoundError(`Site ${siteId} has no tile manifest — build the map first`);
        }
        const resolved = await this.resolveOrthoSource(siteId, manifestAsset.metaJson);
        if ('reason' in resolved) throw new NotFoundError(resolved.reason);
        return { siteId, manifestAsset, sourcePath: resolved.sourcePath };
    }

    /**
     * Resolves the PRISTINE source GeoTIFF of the vintage the flat ortho tile
     * tree was BUILT from — the only raster patches may replay onto — or a
     * human `reason` cleaning can't bake. Pre-flight (`bakeable`) and the
     * bake share this resolution, in order:
     *
     *  1. `builtOrtho` — the explicit built-vintage marker map-build records
     *     alongside the manifest (and re-terrain carries over).
     *  2. Legacy manifests without the marker: the newest recorded vintage
     *     (`orthoVintages[0]` — the collection every build tiles into the
     *     flat tree), provided `activeOrtho` doesn't contradict it. A
     *     divergent `activeOrtho` is a leftover of the removed in-place
     *     vintage switcher: the flat tree's real vintage is unrecorded, so
     *     refuse rather than risk replaying wrong-year pixels into the tile
     *     pyramid.
     *  3. Nothing recorded at all (pre-vintage legacy build) but exactly one
     *     `ortho-*.tif` in `sources/<siteId>/`: that sole source (logged).
     *
     * A NAMED vintage whose source tif is gone is always a refusal — never a
     * silent fallback onto some other vintage's tif.
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
                        + `vs newest recorded '${newest}') — rebuild the map before baking patches`,
                };
            }
            collection = newest ?? meta.activeOrtho;
        }
        if (collection) {
            const sourcePath = path.join(this.dataDir, 'sources', siteId, orthoSourceName(collection));
            if (await Bun.file(sourcePath).exists()) return { sourcePath };
            return { reason: `Pristine ortho source missing: sources/${siteId}/${orthoSourceName(collection)} — rebuild the map` };
        }
        const fallback = await this.soleOrthoTif(siteId);
        if (fallback) {
            console.log(`[ortho-patches] site ${siteId}: no ortho vintage recorded; falling back to the sole source ${path.basename(fallback)}`);
            return { sourcePath: fallback };
        }
        return { reason: `Site ${siteId} has no ortho vintage to patch — rebuild the map` };
    }

    /**
     * The single pristine ortho source in `sources/<siteId>/`, or null if
     * there are zero or several. Excludes the working `.patched.tif` (the
     * replay's OUTPUT — never a valid source to replay onto).
     */
    private async soleOrthoTif(siteId: string): Promise<string | null> {
        const dir = path.join(this.dataDir, 'sources', siteId);
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return null; // sources dir absent — nothing persisted
        }
        const tifs = names.filter(n => /^ortho-.+\.tif$/i.test(n) && !/\.patched\.tif$/i.test(n));
        return tifs.length === 1 ? path.join(dir, tifs[0]) : null;
    }

    // --- Bake / replay + versioning ---

    /** Common args shared by the incremental bake and the full replay. */
    private bakeArgs(site: { siteId: string; sourcePath: string }): string[] {
        return [
            '--ortho', site.sourcePath,
            '--patches-dir', this.patchesDir(site.siteId),
            '--out', site.sourcePath.replace(/\.tif$/i, '.patched.tif'),
            '--tiles-out', path.join(this.dataDir, 'tiles', site.siteId, 'ortho'),
            '--minzoom', String(ORTHO_MINZOOM),
            '--maxzoom', String(ORTHO_MAXZOOM),
            '--weights', this.lamaWeights,
        ];
    }

    private async runGolfpipe(args: string[]): Promise<void> {
        const result = await this.runner(['-m', 'golfpipe', ...args], {
            cwd: this.pipelineDir, env: { ...process.env },
        });
        if (result.code !== 0) {
            const raw = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
            throw new Error(`${args[0]} failed: ${raw.slice(0, 2000)}`);
        }
    }

    /** Incremental accept: windowed inpaint of ONE mask + subtree retile. */
    private async bakeOne(site: { siteId: string; sourcePath: string }, seq: number): Promise<void> {
        await this.runGolfpipe(['bake-ortho-patch', ...this.bakeArgs(site), '--seq', String(seq)]);
    }

    /** Full replay from pristine (revert / rebuild convergence). */
    private async replay(
        site: { siteId: string; sourcePath: string },
        extraBounds3857: PatchBounds[] = [],
    ): Promise<void> {
        const args = ['apply-ortho-patches', ...this.bakeArgs(site)];
        for (const b of extraBounds3857) args.push('--extra-bounds', boundsArg(b));
        await this.runGolfpipe(args);
    }

    /**
     * Bumps the tile version: rewrites `generatedAt` (ms precision, so two
     * bakes in the same second still differ) in BOTH the on-disk
     * manifest.json and the tile_manifest asset's metaJson — the web derives
     * the `?v=` cache-buster from the asset copy.
     */
    private async bumpTileVersion(siteId: string): Promise<string> {
        const manifestPath = this.manifestPath(siteId);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        // Strictly monotonic: two bakes inside one millisecond must still
        // mint distinct versions or the second one never reaches clients.
        const prev = typeof manifest.generatedAt === 'string' ? Date.parse(manifest.generatedAt) : NaN;
        let ts = Date.now();
        if (Number.isFinite(prev) && ts <= prev) ts = prev + 1;
        const generatedAt = new Date(ts).toISOString();
        manifest.generatedAt = generatedAt;
        const json = JSON.stringify(manifest);
        await writeFile(manifestPath, json);

        // Re-read the asset for a fresh optimistic-lock version.
        const asset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (asset) await this.assets.update(asset.id, asset.version, { metaJson: json });
        return generatedAt;
    }

    private async readGeneratedAt(siteId: string): Promise<string> {
        try {
            const manifest = JSON.parse(await readFile(this.manifestPath(siteId), 'utf8')) as { generatedAt?: string };
            return manifest.generatedAt ?? '';
        } catch {
            return '';
        }
    }

    // --- Patch store (server-owned; golfpipe only ever READS it) ---

    private patchesDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'patches');
    }

    private manifestPath(siteId: string): string {
        return path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
    }

    private logPath(siteId: string): string {
        return path.join(this.patchesDir(siteId), 'patches.json');
    }

    private async readLog(siteId: string): Promise<PatchLog> {
        let doc: { version?: unknown; patches?: unknown };
        try {
            doc = JSON.parse(await readFile(this.logPath(siteId), 'utf8')) as typeof doc;
            if (!Array.isArray(doc.patches)) throw new Error('bad log');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, patches: [] };
            throw new Error(`Patch log for site ${siteId} is unreadable: ${(err as Error).message}`);
        }
        const patches = doc.patches as PatchLogEntry[];
        if (doc.version !== 2 && patches.length > 0) {
            // Version 1 stored pre-rendered FILL PIXELS; baking them as masks
            // would inpaint the wrong region. Detectable, never misread.
            throw new Error(
                `Patch log for site ${siteId} is a legacy version-1 pixel-patch log `
                + `(${patches.length} entr${patches.length === 1 ? 'y' : 'ies'}) — `
                + 'delete data/sources/<siteId>/patches to reset it',
            );
        }
        return { version: 2, patches };
    }

    private async writeLog(siteId: string, log: PatchLog): Promise<void> {
        await mkdir(this.patchesDir(siteId), { recursive: true });
        await writeFile(this.logPath(siteId), JSON.stringify(log, null, 2));
    }

    private decodeMaskPng(maskPngBase64: string): Buffer {
        if (!maskPngBase64) throw new Error('Mask PNG is empty');
        const buf = Buffer.from(maskPngBase64, 'base64');
        if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            throw new Error('Mask payload is not a PNG');
        }
        if (buf.length > MAX_PATCH_PNG_BYTES) {
            throw new Error(`Mask PNG too large (${buf.length} bytes, max ${MAX_PATCH_PNG_BYTES})`);
        }
        return buf;
    }

    // --- Serialization ---

    /** Chains ops per site so concurrent applies/reverts never interleave. */
    private async enqueue<T>(
        courseId: string,
        op: (site: { siteId: string; manifestAsset: CourseAsset; sourcePath: string }) => Promise<T>,
    ): Promise<T> {
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
