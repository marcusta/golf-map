import type { Kysely } from 'kysely';
import * as path from 'node:path';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Database } from '../db/schema';
import type { AssetsService, CourseAsset } from './assets.service';
import { NotFoundError } from '@basics/core/server/auth';
import type { PipelineRunner } from './map-build.service';
import { venvPython } from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import {
    ORTHO_IMPORT_MAX_BYTES,
    type OrthoImportNoChangeReason,
    type OrthoImportResult,
} from '../../shared/ortho-import';

// --- Public types ---

/** Axis-aligned bounds; the CRS is named by the field carrying them. */
export interface PatchBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** Clone-stamp brush parameters (normal brush-engine semantics — see
 * pipeline/golfpipe/stamp.py, the authoritative renderer). */
export interface StampBrush {
    /** Brush DIAMETER in ground metres. */
    sizeM: number;
    /** Whole-stroke alpha cap, (0, 1]. */
    opacity: number;
    /** Per-dab alpha + dab spacing driver, (0, 1]. */
    flow: number;
    /** Fully-opaque core fraction of the radius, [0, 1]. */
    hardness: number;
}

export interface OrthoMaskEditInput {
    kind: 'mask';
    /** MASK PNG (white/opaque = pixel to inpaint), base64 (no data-URL
     * prefix). The fill is computed server-side by LaMa against the working
     * patched raster — client preview pixels are never baked. */
    maskPngBase64: string;
    /** The mask's EXACT frame: the tile crop's EPSG:3857 rectangle. */
    bounds3857: PatchBounds;
    /** EPSG:3006 bbox of the same area — informational, for the log/UI. */
    boundsSweref: PatchBounds;
    /** Mask mode that produced it ('sam' | 'ellipse'). */
    tool: string;
}

export interface OrthoStampEditInput {
    kind: 'stamp';
    brush: StampBrush;
    /** source = dest + offset, EPSG:3006 metres (dx east, dy north). */
    offsetM: { dx: number; dy: number };
    /** Dest stroke polyline, EPSG:3006 metres. */
    path: Array<{ x: number; y: number }>;
    /** Aligned-clone flag state at capture (stored for the log). */
    aligned: boolean;
    /** Tone-match toggle state for this stroke (default on client-side). */
    toneMatch: boolean;
    /** Dest stroke bbox + brush radius in EPSG:3857 — the retile frame. */
    bounds3857: PatchBounds;
    boundsSweref: PatchBounds;
}

export type OrthoEditInput = OrthoMaskEditInput | OrthoStampEditInput;

export interface OrthoPatchesInfo {
    count: number;
    lastCreatedAt: string | null;
    lastTool: string | null;
    /** Whether MASK edits can bake right now (pristine source resolvable AND
     * the LaMa/torch inpaint deps are present). */
    bakeable: boolean;
    /** Whether STAMP edits can bake (pristine source resolvable — stamps are
     * pure pixel math and never need torch). */
    stampBakeable: boolean;
    /** Human reason cleaning can't (fully) bake (present when !bakeable). */
    reason?: string;
    /** The SIM layer's version stamp (null before the first bake). */
    patchesGeneratedAt: string | null;
    /** Every finished square export of the cleaned photo, oldest first. */
    exports: OrthoExportSummary[];
    /** The site's fixed square frame; null until the first export creates it. */
    frame: SimFrame | null;
}

/** The site's fixed export frame (`sources/<siteId>/sim-frame.json`, D-OX1). */
export interface SimFrame {
    /** EPSG:3006 `[e0, n0, e1, n1]` — a square. */
    extent3006: number[];
    /** Pixels per side. */
    size: number;
}

export type OrthoExportFormat = 'png' | 'jpg';

/** One finished export as the Clean panel lists it. */
export interface OrthoExportSummary {
    /** Export number `<n>` (`exports/<n>/`). */
    seq: number;
    createdAt: string;
    /** Highest patch-log seq the image contains (0 = pristine photo). */
    logSeq: number;
    /** Pixels per side. */
    size: number;
    format: OrthoExportFormat;
    bytes: number;
    /** Path of the image download, relative to the API base (`/api`). */
    downloadPath: string;
}

/** `export.json` of the new export plus where to fetch the image. */
export interface OrthoExportResult {
    siteId: string;
    exportSeq: number;
    /** EPSG:3006 `[e0, n0, e1, n1]` of the frame. */
    extent3006: number[];
    size: number;
    logSeq: number;
    sha256: string;
    createdAt: string;
    /** Image file name inside `exports/<n>/`, e.g. `ortho-sim-3.png`. */
    file: string;
    format: OrthoExportFormat;
    bytes: number;
    /** Path of the image download, relative to the API base (`/api`). */
    downloadPath: string;
    /** True when the working raster was missing or older than the pristine
     * photo and the whole log was replayed (and the sim tiles rewritten)
     * before exporting. */
    replayed: boolean;
    /** Sim tile version after the export: changed only when `replayed`. */
    patchesGeneratedAt: string | null;
}

/** A stored export image, for the download route. */
export interface OrthoExportFile {
    path: string;
    file: string;
    format: OrthoExportFormat;
    bytes: number;
    sha256: string;
}

/** The uploaded image or its query parameters are unusable — a 400. */
export class InvalidOrthoImportError extends Error {}

/** golfpipe exited non-zero. The message carries its stderr, which for the
 * export and import commands is written for the builder to read. */
export class OrthoPipelineError extends Error {}

export interface OrthoPatchResult {
    count: number;
    /** The bumped SIM-layer version stamp (drives the ortho-sim ?v=). The
     * pristine tree's generatedAt is deliberately NOT touched by bakes. */
    patchesGeneratedAt: string;
}

interface StampLogPayload {
    brush: StampBrush;
    offsetM: { dx: number; dy: number };
    path: number[][];
    aligned: boolean;
    toneMatch: boolean;
}

interface PatchLogEntryBase {
    seq: number;
    /** The retile frame of every kind. */
    bounds3857: PatchBounds;
    tool: string;
    createdAt: string;
}

interface MaskLogEntry extends PatchLogEntryBase {
    /** Absent = 'mask' (pre-stamp logs). */
    kind?: 'mask';
    /** The mask PNG file name. */
    file?: string;
    boundsSweref: PatchBounds;
}

interface StampLogEntry extends PatchLogEntryBase {
    kind: 'stamp';
    boundsSweref: PatchBounds;
    stamp: StampLogPayload;
}

/** An externally edited export, stored as the changed pixels only (D-OX4). */
interface RasterLogEntry extends PatchLogEntryBase {
    kind: 'raster';
    /** RGBA PNG cropped to the change bbox, alpha 255 on changed pixels. */
    file: string;
    /** The PNG's authoritative frame, EPSG:3006. */
    bounds3006: PatchBounds;
    /** The export the edit was diffed against. */
    exportSeq: number;
    changedPixels: number;
}

type PatchLogEntry = MaskLogEntry | StampLogEntry | RasterLogEntry;

/** A validated client edit, before it gets its seq and timestamp. */
type PreparedEdit =
    | { entry: Omit<MaskLogEntry, 'seq' | 'createdAt' | 'file'>; png: Buffer }
    | { entry: Omit<StampLogEntry, 'seq' | 'createdAt'>; png: null };

/** The PNG a log entry owns in the patches dir, if its kind has one. */
function entryFile(entry: PatchLogEntry): string | undefined {
    return entry.kind === 'stamp' ? undefined : entry.file;
}

/** `export.json` as golfpipe writes it (also its stdout). */
interface ExportMeta {
    exportSeq: number;
    extent3006: number[];
    size: number;
    logSeq: number;
    sha256: string;
    createdAt: string;
    file: string;
    format: OrthoExportFormat;
    bytes: number;
}

/** The one stdout line of `golfpipe import-ortho-square`. */
interface ImportStdout {
    changed: boolean;
    seq: number;
    exportSeq: number;
    changedPixels: number;
    diffPixels: number;
    tolerance: number;
    minAreaPx: number;
    reason?: OrthoImportNoChangeReason;
    file?: string;
    bounds3006?: PatchBounds;
    bounds3857?: PatchBounds;
    regions?: number;
}

/** Version 2: entries are MASKS (server-side inpaint), STAMP strokes
 * (server-side brush-engine render) or RASTER diffs of an externally edited
 * export. Version 1 stored pre-rendered fill pixels; a non-empty v1 log is
 * refused, never misread. */
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
    /** Python interpreter; defaults to MAP_PIPELINE_PYTHON, then the pipeline venv's. */
    python?: string;
    /** LaMa TorchScript checkpoint; defaults to $GOLFPIPE_LAMA_WEIGHTS or
     * `<repo>/data/models/big-lama.pt` (the assist sidecar's convention). */
    lamaWeights?: string;
    /** Injected in tests to avoid spawning Python. */
    runner?: PipelineRunner;
}

const MAX_PATCH_PNG_BYTES = 24 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A stamp session queues one edit per stroke, so a queue of a few hundred is
// ordinary; the cap only stops a runaway request.
const MAX_EDITS_PER_BATCH = 500;
const MAX_STAMP_PATH_POINTS = 4000;
const MAX_STAMP_OFFSET_M = 10_000;
const MAX_STAMP_SIZE_M = 100;

/** Pixels per side of a new export frame (golfpipe square_frame.DEFAULT_SIZE; the GSPro ortho textures' size). */
const SIM_FRAME_SIZE = 8192;

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

/** The export/import commands print exactly one JSON line on stdout. */
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

/**
 * Interactive ortho photo cleaning: stores accepted edits as a REPLAYABLE
 * LOG under `data/sources/<siteId>/patches/` (`patches.json`, version 2) —
 * the pristine source ortho is never modified. Three entry kinds (the third,
 * RASTER, is the diff of an externally edited square export — see
 * `exportSquare` / `importEdited` and docs/feature-ortho-export-import.md):
 *
 *  - MASK (`<n>.png` + entry): the fill is LaMa-inpainted server-side by
 *    golfpipe against the working `.patched.tif` (seam-free by provenance;
 *    needs torch + weights).
 *  - STAMP (entry only — brush params, source→dest offset, dest polyline):
 *    re-rendered by golfpipe's pure numpy brush engine. Torch-free and
 *    byte-reproducible on replay.
 *
 * ## Dual photo state (sim layer)
 *
 * Cleaning is for GOLF-SIMULATOR EXPORT ONLY — the planning/playing imagery
 * (web planner, draw mode, iOS tile bundles) must keep showing the ORIGINAL
 * photo. Bakes therefore NEVER touch the pristine flat tile tree
 * (`tiles/<siteId>/ortho/`). Instead they retile the affected subtree into a
 * parallel copy-on-write overlay `tiles/<siteId>/ortho-sim/` holding ONLY
 * patch-affected tiles; the tile route serves an `ortho-sim` request from
 * that overlay when the file exists and falls back to the pristine tile
 * otherwise. The overlay carries its OWN version stamp
 * (`patchesGeneratedAt` in the manifest/asset meta) so pristine tile caches
 * are never invalidated by cleaning; the pristine `generatedAt` stops
 * changing on bake/revert. The working `.patched.tif` alongside the source
 * remains the Unity/GSPro export source of truth. Reverting the last
 * remaining patch empties the sim tree entirely (pure pristine fallback).
 *
 * ## Batch baking
 *
 * `applyEdits` accepts the client's whole PENDING QUEUE in one call: all
 * entries are appended to the log, then ONE `golfpipe bake-ortho-patch`
 * invocation bakes them in order against the evolving patched raster and
 * retiles the UNION of affected subtrees in a single pass — a batch of N
 * edits pays for one process start, one raster open, one retile, one
 * version bump. A single accept is just a batch of one (no parallel paths).
 *
 * Revert (revert-last, one LOG ENTRY at a time) runs the FULL replay
 * (`golfpipe apply-ortho-patches`): pristine copy + every remaining logged
 * edit re-baked in order. Mask fills are regenerated by the model (visually
 * equivalent, not byte-identical); stamp strokes replay byte-identically.
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
            ?? DEFAULT_PIPELINE_DIR;
        this.python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.lamaWeights = deps.lamaWeights
            ?? process.env.GOLFPIPE_LAMA_WEIGHTS
            ?? path.resolve(this.pipelineDir, '..', 'data', 'models', 'big-lama.pt');
        this.runner = deps.runner ?? defaultRunner(this.python);
    }

    // --- Public API ---

    /**
     * Patch count + last-entry summary for the course's map (site), plus the
     * pre-flight `bakeable` (mask edits) / `stampBakeable` (stamp edits)
     * flags computed by the SAME source resolution the bake uses — so the
     * Clean panel can gate "Bake" up front instead of failing late. Stamps
     * only need the source (pure pixel math); masks additionally need the
     * LaMa weights + torch.
     */
    async info(courseId: string): Promise<OrthoPatchesInfo> {
        const siteId = await this.siteIdForCourse(courseId);
        if (!siteId) {
            return {
                count: 0, lastCreatedAt: null, lastTool: null,
                bakeable: false, stampBakeable: false,
                reason: `Course ${courseId} has no map (no site) — build the map first`,
                patchesGeneratedAt: null,
                exports: [],
                frame: null,
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
            patchesGeneratedAt: await this.readSimGeneratedAt(siteId),
            exports: (await this.listExports(siteId)).map(m => this.exportSummary(siteId, m)),
            frame: await this.readFrame(siteId),
        };
    }

    /**
     * Pre-flight for the Clean panel. Source-resolution failures block BOTH
     * kinds; missing inpaint deps (LaMa weights / torch) block only masks —
     * a stamp-only queue stays bakeable without them.
     */
    private async checkBakeable(siteId: string): Promise<{ bakeable: boolean; stampBakeable: boolean; reason?: string }> {
        const manifestAsset = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifestAsset?.metaJson) {
            return {
                bakeable: false, stampBakeable: false,
                reason: `Site ${siteId} has no tile manifest — build the map first`,
            };
        }
        const resolved = await this.resolveOrthoSource(siteId, manifestAsset.metaJson);
        if ('reason' in resolved) return { bakeable: false, stampBakeable: false, reason: resolved.reason };
        const inpaint = await this.checkInpaintDeps();
        return { bakeable: inpaint.ok, stampBakeable: true, reason: inpaint.reason };
    }

    /**
     * Mask bakes inpaint server-side, so the pipeline venv needs the
     * optional torch extra and the big-lama checkpoint. Torch's import probe
     * costs a couple of seconds, so it is cached for the process lifetime;
     * the weights file is re-checked each time (downloadable while running).
     */
    private async checkInpaintDeps(): Promise<{ ok: boolean; reason?: string }> {
        if (!(await Bun.file(this.lamaWeights).exists())) {
            return {
                ok: false,
                reason: `LaMa weights missing at ${this.lamaWeights} — download big-lama.pt (see pipeline/README.md)`,
            };
        }
        this.torchCheck ??= this.runner(['-c', 'import torch'], {
            cwd: this.pipelineDir, env: { ...process.env },
        }).then(r => r.code === 0, () => false);
        if (!(await this.torchCheck)) {
            return {
                ok: false,
                reason: 'Inpaint dependencies (torch) missing in the pipeline venv — '
                    + 'cd pipeline && ./.venv/bin/pip install -r requirements-inpaint.txt',
            };
        }
        return { ok: true };
    }

    /**
     * Batch accept: appends every edit (in order) to the log — mask edits
     * store their png, stamp edits are log-only — then bakes them with ONE
     * `golfpipe bake-ortho-patch --seq a --seq b …` call: each entry's
     * window is processed in seq order against the evolving `.patched.tif`
     * and the UNION of affected subtrees is retiled once, into the SIM
     * overlay tree (the pristine flat tree is never touched). On pipeline
     * failure every stored edit of the batch is rolled back — the log only
     * ever describes what the sim tiles show.
     */
    async applyEdits(courseId: string, edits: OrthoEditInput[]): Promise<OrthoPatchResult> {
        if (!Array.isArray(edits) || edits.length === 0) {
            throw new Error('No edits to bake');
        }
        if (edits.length > MAX_EDITS_PER_BATCH) {
            throw new Error(`Too many edits in one batch (${edits.length}, max ${MAX_EDITS_PER_BATCH})`);
        }
        // Validate/decode everything up front — nothing is stored on error.
        const prepared = edits.map(e => this.prepareEdit(e));

        return this.enqueue(courseId, async (site) => {
            const dir = this.patchesDir(site.siteId);
            await mkdir(dir, { recursive: true });
            const log = await this.readLog(site.siteId);
            let seq = log.patches[log.patches.length - 1]?.seq ?? 0;

            const newEntries: PatchLogEntry[] = [];
            const writtenFiles: string[] = [];
            for (const p of prepared) {
                seq += 1;
                const createdAt = new Date().toISOString();
                if (p.png) {
                    const file = `${seq}.png`;
                    await writeFile(path.join(dir, file), p.png);
                    writtenFiles.push(file);
                    newEntries.push({ ...p.entry, file, seq, createdAt });
                } else {
                    newEntries.push({ ...p.entry, seq, createdAt });
                }
            }
            await this.writeLog(site.siteId, { ...log, patches: [...log.patches, ...newEntries] });

            try {
                await this.bakeSeqs(site, newEntries.map(e => e.seq));
            } catch (err) {
                // Roll back: a failed batch must not linger in the log.
                await this.writeLog(site.siteId, log).catch(() => {});
                for (const file of writtenFiles) {
                    await rm(path.join(dir, file), { force: true }).catch(() => {});
                }
                throw err;
            }

            const patchesGeneratedAt = await this.bumpSimVersion(site.siteId);
            return { count: log.patches.length + newEntries.length, patchesGeneratedAt };
        });
    }

    /** Validates one edit; returns the (seq-less) log entry + mask png. */
    private prepareEdit(edit: OrthoEditInput): PreparedEdit {
        if (!validBounds(edit.bounds3857) || !validBounds(edit.boundsSweref)) {
            throw new Error('Edit bounds are degenerate (need finite west < east, south < north)');
        }
        if (edit.kind === 'mask') {
            const png = this.decodeMaskPng(edit.maskPngBase64);
            if (!edit.tool || edit.tool.length > 40) throw new Error('Edit tool label is missing/too long');
            return {
                entry: {
                    kind: 'mask',
                    bounds3857: edit.bounds3857,
                    boundsSweref: edit.boundsSweref,
                    tool: edit.tool,
                },
                png,
            };
        }
        if (edit.kind !== 'stamp') {
            throw new Error(`Unknown edit kind ${(edit as { kind?: string }).kind}`);
        }
        const { brush, offsetM, path: strokePath } = edit;
        if (!Number.isFinite(brush?.sizeM) || brush.sizeM <= 0 || brush.sizeM > MAX_STAMP_SIZE_M) {
            throw new Error(`Stamp brush sizeM must be in (0, ${MAX_STAMP_SIZE_M}] metres`);
        }
        for (const [name, v, min] of [
            ['opacity', brush.opacity, 0.01],
            ['flow', brush.flow, 0.01],
            ['hardness', brush.hardness, 0],
        ] as const) {
            if (!Number.isFinite(v) || v < min || v > 1) {
                throw new Error(`Stamp brush ${name} must be in [${min}, 1]`);
            }
        }
        if (!Number.isFinite(offsetM?.dx) || !Number.isFinite(offsetM?.dy)
            || Math.abs(offsetM.dx) > MAX_STAMP_OFFSET_M || Math.abs(offsetM.dy) > MAX_STAMP_OFFSET_M) {
            throw new Error(`Stamp offset must be finite and within ±${MAX_STAMP_OFFSET_M} m`);
        }
        if (!Array.isArray(strokePath) || strokePath.length === 0 || strokePath.length > MAX_STAMP_PATH_POINTS) {
            throw new Error(`Stamp path needs 1..${MAX_STAMP_PATH_POINTS} points`);
        }
        for (const p of strokePath) {
            if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
                throw new Error('Stamp path points must be finite {x, y}');
            }
        }
        return {
            entry: {
                kind: 'stamp',
                bounds3857: edit.bounds3857,
                boundsSweref: edit.boundsSweref,
                tool: 'stamp',
                stamp: {
                    brush: {
                        sizeM: brush.sizeM, opacity: brush.opacity,
                        flow: brush.flow, hardness: brush.hardness,
                    },
                    offsetM: { dx: offsetM.dx, dy: offsetM.dy },
                    path: strokePath.map(p => [p.x, p.y]),
                    aligned: !!edit.aligned,
                    toneMatch: !!edit.toneMatch,
                },
            },
            png: null,
        };
    }

    /**
     * Revert v1: drops the LAST log entry (one entry, not one batch), re-
     * replays the remaining log (full replay from pristine — remaining mask
     * fills are REGENERATED by LaMa; stamp strokes replay byte-identically)
     * into the sim overlay, and retiles the reverted entry's bounds too (its
     * sim tiles must rewrite from the now-unpatched raster). When the log
     * becomes empty the whole sim tree is deleted — every ortho-sim request
     * then falls back to the pristine tile. No-op result on an empty log.
     */
    async revertLast(courseId: string): Promise<OrthoPatchResult> {
        return this.enqueue(courseId, async (site) => {
            const log = await this.readLog(site.siteId);
            const last = log.patches[log.patches.length - 1];
            if (!last) return { count: 0, patchesGeneratedAt: (await this.readSimGeneratedAt(site.siteId)) ?? '' };

            const remaining: PatchLog = { ...log, patches: log.patches.slice(0, -1) };
            await this.writeLog(site.siteId, remaining);
            try {
                await this.replay(site, [last.bounds3857]);
            } catch (err) {
                await this.writeLog(site.siteId, log).catch(() => {});
                throw err;
            }
            // Mask and raster entries own a PNG; a stamp is log-only.
            const lastFile = entryFile(last);
            if (lastFile) {
                await rm(path.join(this.patchesDir(site.siteId), lastFile), { force: true }).catch(() => {});
            }
            if (remaining.patches.length === 0) {
                // Nothing baked anymore: pure pristine fallback everywhere.
                await rm(this.simTilesDir(site.siteId), { recursive: true, force: true }).catch(() => {});
            }

            const patchesGeneratedAt = await this.bumpSimVersion(site.siteId);
            return { count: remaining.patches.length, patchesGeneratedAt };
        });
    }

    // --- External edit: square export + diff import ---

    /**
     * Exports the cleaned photo as one square image on the site's fixed frame
     * (`golfpipe export-ortho-square`) into `sources/<siteId>/exports/<n>/`.
     *
     * The source is the replayed log and nothing else (D-OX2): the working
     * `.patched.tif` when the log has entries, replayed first if it is
     * missing or older than the pristine photo, or the pristine photo for an
     * empty log. The first export creates `sim-frame.json` from the tile
     * manifest bounds; later exports reuse it unchanged.
     *
     * Exports are numbered from 1 and never rewritten. A directory without
     * `export.json` is a failed attempt and is removed.
     */
    async exportSquare(courseId: string, format: OrthoExportFormat = 'png'): Promise<OrthoExportResult> {
        if (format !== 'png' && format !== 'jpg') throw new Error(`Unknown export format ${String(format)}`);
        return this.enqueue(courseId, async (site) => {
            const { siteId } = site;
            const log = await this.readLog(siteId);
            const logSeq = log.patches[log.patches.length - 1]?.seq ?? 0;

            let ortho = site.sourcePath;
            let replayed = false;
            if (log.patches.length > 0) {
                ortho = this.patchedPath(site);
                if (!(await this.workingRasterCurrent(site))) {
                    await this.replay(site);
                    await this.bumpSimVersion(siteId);
                    replayed = true;
                }
            }

            const exportsDir = this.exportsDir(siteId);
            await mkdir(exportsDir, { recursive: true });
            const done = await this.listExports(siteId);
            for (const name of await readdir(exportsDir)) {
                if (/^\d+$/.test(name) && !done.some(m => String(m.exportSeq) === name)) {
                    await rm(path.join(exportsDir, name), { recursive: true, force: true });
                }
            }
            const seq = (done[done.length - 1]?.exportSeq ?? 0) + 1;
            const outDir = path.join(exportsDir, String(seq));

            const args = [
                'export-ortho-square',
                '--ortho', ortho,
                '--frame', this.framePath(siteId),
                '--out-dir', outDir,
                '--seq', String(seq),
                '--log-seq', String(logSeq),
                '--format', format,
            ];
            if (!(await this.readFrame(siteId))) {
                const meta = JSON.parse(site.manifestAsset.metaJson ?? '{}') as {
                    bounds?: PatchBounds;
                    terrain?: { inner?: { square3006?: number[] } };
                };
                const inner = meta.terrain?.inner?.square3006;
                if (Array.isArray(inner) && inner.length === 4 && inner.every(Number.isFinite)
                    && inner[2] > inner[0] && Math.abs((inner[2] - inner[0]) - (inner[3] - inner[1])) < 1e-6) {
                    // The frame IS the inner terrain square, the one every GSPro
                    // export and the Unity textures are rendered over: an export
                    // edited outside then lines up with them pixel for pixel.
                    // Squaring the manifest's WGS84 bounds again (below) gave
                    // Vreta a 2090 m frame round a 2050 m terrain.
                    const frame: SimFrame = { extent3006: inner.map(Number), size: SIM_FRAME_SIZE };
                    await writeFile(this.framePath(siteId), JSON.stringify(frame, null, 2));
                } else {
                    // A site built before the manifest carried the square. An
                    // existing frame is never changed, and golfpipe refuses
                    // other bounds against one, so they go along only now.
                    if (!meta.bounds || !validBounds(meta.bounds)) {
                        throw new Error(`Site ${siteId}: the tile manifest has no bounds to make the export frame from`);
                    }
                    args.push('--bounds-wgs84', boundsArg(meta.bounds));
                }
            }
            try {
                await this.runGolfpipe(args);
            } catch (err) {
                await rm(outDir, { recursive: true, force: true }).catch(() => {});
                throw err;
            }
            const meta = await this.readExportMeta(siteId, seq);
            if (!meta) throw new Error(`export-ortho-square wrote no usable export.json in ${outDir}`);
            return {
                siteId,
                ...meta,
                downloadPath: this.exportDownloadPath(siteId, seq),
                replayed,
                patchesGeneratedAt: await this.readSimGeneratedAt(siteId),
            };
        });
    }

    /** The stored image of one export, for the download route. */
    async exportFile(siteId: string, seq: number): Promise<OrthoExportFile> {
        // The ids come from the URL: a site id is one path segment.
        if (!/^[A-Za-z0-9_-]+$/.test(siteId) || !Number.isInteger(seq) || seq < 1) {
            throw new NotFoundError('Export not found');
        }
        const meta = await this.readExportMeta(siteId, seq);
        const filePath = meta ? path.join(this.exportsDir(siteId), String(seq), meta.file) : null;
        if (!meta || !filePath || !(await Bun.file(filePath).exists())) {
            throw new NotFoundError(`Export ${seq} of site ${siteId} not found`);
        }
        return { path: filePath, file: meta.file, format: meta.format, bytes: meta.bytes, sha256: meta.sha256 };
    }

    /**
     * Where the import route streams the uploaded image for this course:
     * a fresh file under `sources/<siteId>/patches/.incoming/`. Resolves the
     * site first, so an unknown course fails before any byte is stored.
     * `importEdited` deletes the file; a caller that never gets there must.
     */
    async incomingImportPath(courseId: string): Promise<string> {
        const site = await this.resolveSite(courseId);
        const dir = path.join(this.patchesDir(site.siteId), '.incoming');
        await mkdir(dir, { recursive: true });
        return path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    }

    /**
     * Imports an externally edited export (`golfpipe import-ortho-square`):
     * the image at `tmpPath` is diffed against the export it was edited from
     * (`exportSeq`, default the latest) and only the changed pixels are
     * stored, as `patches/<seq>.png` plus ONE `raster` log entry, which is
     * then baked and retiled like any other entry.
     *
     * Nothing changed (`changed: false`) appends and bakes nothing. A failed
     * diff or bake leaves neither the entry nor its PNG behind. `tmpPath` is
     * deleted in every case.
     */
    async importEdited(
        courseId: string,
        input: { tmpPath: string; exportSeq?: number; tolerance?: number },
    ): Promise<OrthoImportResult> {
        const { tmpPath, exportSeq, tolerance } = input;
        try {
            if (exportSeq !== undefined && (!Number.isInteger(exportSeq) || exportSeq < 1)) {
                throw new InvalidOrthoImportError('exportSeq must be a whole number, 1 or higher');
            }
            if (tolerance !== undefined && (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 254)) {
                throw new InvalidOrthoImportError('tolerance must be a whole number from 0 to 254');
            }
            await this.assertImportPng(tmpPath);

            return await this.enqueue(courseId, async (site) => {
                const { siteId } = site;
                const dir = this.patchesDir(siteId);
                const log = await this.readLog(siteId);
                const seq = (log.patches[log.patches.length - 1]?.seq ?? 0) + 1;

                const exports = await this.listExports(siteId);
                if (exports.length === 0) {
                    throw new NotFoundError(`Site ${siteId} has no export to compare with — export the photo first`);
                }
                const exp = exportSeq === undefined
                    ? exports[exports.length - 1]
                    : exports.find(m => m.exportSeq === exportSeq);
                if (!exp) throw new NotFoundError(`Export ${exportSeq} of site ${siteId} not found`);

                // Read for its extent only; the pristine photo has the same one.
                const ortho = log.patches.length > 0 && (await this.workingRasterCurrent(site))
                    ? this.patchedPath(site)
                    : site.sourcePath;
                const args = [
                    'import-ortho-square',
                    '--ortho', ortho,
                    '--patches-dir', dir,
                    '--export-dir', path.join(this.exportsDir(siteId), String(exp.exportSeq)),
                    '--image', tmpPath,
                    '--seq', String(seq),
                ];
                // An explicit tolerance is what lets a JPEG export through,
                // so it is passed only when the client chose one.
                if (tolerance !== undefined) args.push('--tolerance', String(tolerance));

                const pngPath = path.join(dir, `${seq}.png`);
                let out: ImportStdout;
                try {
                    out = parseJsonLine<ImportStdout>(await this.runGolfpipe(args), 'import-ortho-square');
                } catch (err) {
                    await rm(pngPath, { force: true }).catch(() => {});
                    throw err;
                }

                const summary = {
                    exportSeq: out.exportSeq,
                    changedPixels: out.changedPixels,
                    diffPixels: out.diffPixels,
                    tolerance: out.tolerance,
                    minAreaPx: out.minAreaPx,
                };
                if (!out.changed) {
                    return {
                        changed: false,
                        reason: out.reason,
                        count: log.patches.length,
                        patchesGeneratedAt: await this.readSimGeneratedAt(siteId),
                        seq: null,
                        ...summary,
                        bounds3006: null, bounds3857: null, regions: null,
                    };
                }
                if (out.file !== `${seq}.png` || !out.bounds3006 || !out.bounds3857
                    || !validBounds(out.bounds3006) || !validBounds(out.bounds3857)) {
                    await rm(pngPath, { force: true }).catch(() => {});
                    throw new Error('import-ortho-square answered without a usable file/bounds');
                }

                const entry: RasterLogEntry = {
                    seq,
                    kind: 'raster',
                    file: out.file,
                    bounds3006: out.bounds3006,
                    bounds3857: out.bounds3857,
                    exportSeq: out.exportSeq,
                    changedPixels: out.changedPixels,
                    tool: 'external',
                    createdAt: new Date().toISOString(),
                };
                await this.writeLog(siteId, { ...log, patches: [...log.patches, entry] });
                try {
                    await this.bakeSeqs(site, [seq]);
                } catch (err) {
                    // Roll back: the log only ever describes what the sim tiles show.
                    await this.writeLog(siteId, log).catch(() => {});
                    await rm(pngPath, { force: true }).catch(() => {});
                    throw err;
                }

                return {
                    changed: true,
                    count: log.patches.length + 1,
                    patchesGeneratedAt: await this.bumpSimVersion(siteId),
                    seq,
                    ...summary,
                    bounds3006: entry.bounds3006,
                    bounds3857: entry.bounds3857,
                    regions: out.regions ?? null,
                };
            });
        } finally {
            await rm(tmpPath, { force: true }).catch(() => {});
        }
    }

    /** The upload must be a PNG within the cap (the route checks both while
     * streaming; this is the check that holds whoever the caller is). */
    private async assertImportPng(tmpPath: string): Promise<void> {
        let size: number;
        const head = Buffer.alloc(PNG_SIGNATURE.length);
        try {
            size = (await stat(tmpPath)).size;
            const fh = await open(tmpPath, 'r');
            try {
                await fh.read(head, 0, head.length, 0);
            } finally {
                await fh.close();
            }
        } catch {
            throw new InvalidOrthoImportError('The uploaded image is missing');
        }
        if (size > ORTHO_IMPORT_MAX_BYTES) {
            throw new InvalidOrthoImportError(`Image too large (${size} bytes, max ${ORTHO_IMPORT_MAX_BYTES})`);
        }
        if (!head.equals(PNG_SIGNATURE)) {
            throw new InvalidOrthoImportError('The uploaded image is not a PNG — save the edit as PNG');
        }
    }

    private exportsDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'exports');
    }

    private framePath(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'sim-frame.json');
    }

    private exportDownloadPath(siteId: string, seq: number): string {
        return `/ortho-patches/export/${siteId}/${seq}/file`;
    }

    private exportSummary(siteId: string, m: ExportMeta): OrthoExportSummary {
        return {
            seq: m.exportSeq, createdAt: m.createdAt, logSeq: m.logSeq, size: m.size,
            format: m.format, bytes: m.bytes,
            downloadPath: this.exportDownloadPath(siteId, m.exportSeq),
        };
    }

    private async readFrame(siteId: string): Promise<SimFrame | null> {
        try {
            const doc = JSON.parse(await readFile(this.framePath(siteId), 'utf8')) as Partial<SimFrame>;
            if (!Array.isArray(doc.extent3006) || doc.extent3006.length !== 4 || typeof doc.size !== 'number') return null;
            return { extent3006: doc.extent3006.map(Number), size: doc.size };
        } catch {
            return null;
        }
    }

    /** `exports/<seq>/export.json`, or null when that export is absent or
     * unfinished (golfpipe writes the file last). */
    private async readExportMeta(siteId: string, seq: number): Promise<ExportMeta | null> {
        let doc: Partial<ExportMeta>;
        try {
            doc = JSON.parse(await readFile(path.join(this.exportsDir(siteId), String(seq), 'export.json'), 'utf8')) as Partial<ExportMeta>;
        } catch {
            return null;
        }
        const file = doc.file;
        if (doc.exportSeq !== seq || typeof file !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file)
            || typeof doc.sha256 !== 'string' || typeof doc.size !== 'number'
            || !Array.isArray(doc.extent3006)) {
            return null;
        }
        return {
            exportSeq: seq,
            extent3006: doc.extent3006.map(Number),
            size: doc.size,
            logSeq: Number(doc.logSeq ?? 0),
            sha256: doc.sha256,
            createdAt: String(doc.createdAt ?? ''),
            file,
            format: doc.format === 'jpg' ? 'jpg' : 'png',
            bytes: Number(doc.bytes ?? 0),
        };
    }

    /** Every finished export of the site, oldest first. */
    private async listExports(siteId: string): Promise<ExportMeta[]> {
        let names: string[];
        try {
            names = await readdir(this.exportsDir(siteId));
        } catch {
            return [];
        }
        const out: ExportMeta[] = [];
        for (const name of names) {
            if (!/^\d+$/.test(name)) continue;
            const meta = await this.readExportMeta(siteId, Number(name));
            if (meta) out.push(meta);
        }
        return out.sort((a, b) => a.exportSeq - b.exportSeq);
    }

    private patchedPath(site: { sourcePath: string }): string {
        return site.sourcePath.replace(/\.tif$/i, '.patched.tif');
    }

    /** Whether the working `.patched.tif` exists and is no older than the
     * pristine photo — golfpipe's own test (`cmd_bake_ortho_patch`) for a
     * raster that needs no full replay. */
    private async workingRasterCurrent(site: { sourcePath: string }): Promise<boolean> {
        try {
            const [patched, pristine] = await Promise.all([stat(this.patchedPath(site)), stat(site.sourcePath)]);
            return patched.mtimeMs >= pristine.mtimeMs;
        } catch {
            return false;
        }
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

    /** Common args shared by the incremental bake and the full replay: bakes
     * land in the SIM overlay tree; the pristine flat tree is read-only (the
     * retile derives lower-zoom parents from it where the sim overlay has no
     * child tile of its own). */
    private bakeArgs(site: { siteId: string; sourcePath: string }): string[] {
        return [
            '--ortho', site.sourcePath,
            '--patches-dir', this.patchesDir(site.siteId),
            '--out', this.patchedPath(site),
            '--tiles-out', this.simTilesDir(site.siteId),
            '--pristine-tiles', path.join(this.dataDir, 'tiles', site.siteId, 'ortho'),
            '--minzoom', String(ORTHO_MINZOOM),
            '--maxzoom', String(ORTHO_MAXZOOM),
            '--weights', this.lamaWeights,
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
            throw new OrthoPipelineError(`${args[0]} failed: ${raw.slice(-2000)}`);
        }
        return result.stdout;
    }

    /** Batch accept: windowed bakes of the given seqs + ONE union retile. */
    private async bakeSeqs(site: { siteId: string; sourcePath: string }, seqs: number[]): Promise<void> {
        const args = ['bake-ortho-patch', ...this.bakeArgs(site)];
        for (const seq of seqs) args.push('--seq', String(seq));
        await this.runGolfpipe(args);
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
     * Bumps the SIM layer's version: rewrites `patchesGeneratedAt` (ms
     * precision, strictly monotonic) in BOTH the on-disk manifest.json and
     * the tile_manifest asset's metaJson — the web derives the ortho-sim
     * `?v=` cache-buster from it. The pristine `generatedAt` is deliberately
     * NEVER touched here: cleaning must not invalidate pristine tile caches
     * (web planner / iOS bundles keep their immutable URLs).
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

    // --- Patch store (server-owned; golfpipe only ever READS it) ---

    private patchesDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId, 'patches');
    }

    /** The copy-on-write sim overlay tree (only patch-affected tiles). */
    private simTilesDir(siteId: string): string {
        return path.join(this.dataDir, 'tiles', siteId, 'ortho-sim');
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
