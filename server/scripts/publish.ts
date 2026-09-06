/**
 * Publish CLI (T59, builder side): packages one site's built artifacts into a
 * tar.zst bundle and uploads it to a serve-mode VPS, which ingests and swaps it
 * atomically (§7/§8).
 *
 * Usage (cwd = server/):
 *   bun run publish <siteId> [--ortho-maxzoom 19] [--out <dir>] [--no-upload] [--full-dem]
 *
 * Env:
 *   PUBLISH_URL    base URL of the serve-mode VPS (e.g. https://vps.example.com)
 *   PUBLISH_TOKEN  bearer token, set identically on both boxes
 *   DB_PATH / DATA_DIR  as for the server (defaults ../data/…)
 *   MAP_PIPELINE_DIR / MAP_PIPELINE_PYTHON  golfpipe location (as for map builds)
 *
 * The bundle-building logic is exported (`buildBundle`, `packBundle`) so it is
 * exercised by integration tests against a real migrated DB + synthetic tiles.
 */
import * as path from 'node:path';
import {
    existsSync,
    statSync,
    mkdirSync,
    rmSync,
    readdirSync,
    readFileSync,
    renameSync,
    copyFileSync,
} from 'node:fs';
import type { Kysely } from 'kysely';
import { config } from '@basics/core/server/config';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from '../db/schema';
import {
    BUNDLE_FORMAT_VERSION,
    CONTENT_TABLES,
    CONTENT_HASH_FILES,
    SEED_PINS_PATH,
    DEFAULT_ORTHO_MAXZOOM,
    BUNDLE_TILE_LAYERS,
    contentFilePath,
    contentHash,
    type BundleMeta,
    type BundleTileLayer,
    type ContentTable,
    type LayerZoomRange,
} from '../services/bundle';
import { createTarZst } from '../services/bundle-archive';
import { toGeoJson, type FeatureGeometry } from '../services/geo';
import { defaultRunner, type PipelineRunner, type PipelineRunResult } from '../services/map-build.service';

export interface PublishDeps {
    db: Kysely<Database>;
    dataDir: string;
    /** golfpipe checkout; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to `<pipelineDir>/.venv/bin/python`. */
    python?: string;
    /** Injected by tests that must not spawn Python. */
    runner?: PipelineRunner;
}

export interface BuildBundleOptions {
    siteId: string;
    orthoMaxzoom?: number;
    /** Staging root; the bundle tree is written under `<outDir>/<siteId>-bundle`. */
    outDir: string;
    /**
     * Fallback (§6): ship the whole builder DEM as `dem-analysis.tif` instead
     * of deriving the greens mosaic. Costs ~4x the bytes on the wire and on
     * the VPS; use it when golfpipe is unavailable on the builder box or when
     * a site needs full-resolution reads away from its greens.
     */
    fullDem?: boolean;
}

/** How the bundle's `dem/dem-analysis.tif` was produced. */
export type AnalysisDemMode = 'mosaic' | 'mosaic-cached' | 'full' | 'none';

export interface BuildBundleResult {
    stagingDir: string;
    meta: BundleMeta;
    warnings: string[];
    /** Which §6 path produced the shipped DEM (reported by the CLI). */
    analysisDem: AnalysisDemMode;
}

// --- Site scope ------------------------------------------------------------

interface SiteScope {
    courseIds: string[];
    holeIds: string[];
    greenIds: string[];
}

async function resolveScope(db: Kysely<Database>, siteId: string): Promise<SiteScope> {
    const courses = await db.selectFrom('courses').select('id').where('site_id', '=', siteId).execute();
    const courseIds = courses.map((r) => r.id);
    const holeIds = courseIds.length
        ? (await db.selectFrom('holes').select('id').where('course_id', 'in', courseIds).execute()).map((r) => r.id)
        : [];
    const greenIds = holeIds.length
        ? (await db.selectFrom('greens').select('id').where('hole_id', 'in', holeIds).execute()).map((r) => r.id)
        : [];
    return { courseIds, holeIds, greenIds };
}

/** Site-scoped rows for a content table, as full-column objects (snake_case). */
async function contentRows(db: Kysely<Database>, table: ContentTable, scope: SiteScope, siteId: string): Promise<Record<string, unknown>[]> {
    const { courseIds, holeIds } = scope;
    switch (table) {
        case 'sites':
            return db.selectFrom('sites').selectAll().where('id', '=', siteId).execute();
        case 'courses':
            return db.selectFrom('courses').selectAll().where('site_id', '=', siteId).execute();
        case 'holes':
            return courseIds.length ? db.selectFrom('holes').selectAll().where('course_id', 'in', courseIds).execute() : [];
        case 'tees':
            return holeIds.length ? db.selectFrom('tees').selectAll().where('hole_id', 'in', holeIds).execute() : [];
        case 'greens':
            return holeIds.length ? db.selectFrom('greens').selectAll().where('hole_id', 'in', holeIds).execute() : [];
        case 'aim_points':
            return holeIds.length ? db.selectFrom('aim_points').selectAll().where('hole_id', 'in', holeIds).execute() : [];
        case 'course_features':
            return courseIds.length ? db.selectFrom('course_features').selectAll().where('course_id', 'in', courseIds).execute() : [];
        case 'hazards':
            return holeIds.length ? db.selectFrom('hazards').selectAll().where('hole_id', 'in', holeIds).execute() : [];
    }
}

function toJsonl(rows: Record<string, unknown>[]): string {
    return rows.map((r) => JSON.stringify(r)).join('\n');
}

// --- Tiles -----------------------------------------------------------------

/**
 * Copies a layer's tile tree into the staging bundle, capping ortho zoom at
 * `orthoMaxzoom`. Only numeric z-dirs are copied for ortho, so builder-only
 * per-vintage subdirs (`ortho/<collection>/…`) never travel to the VPS.
 * Returns the min/max zoom actually copied.
 */
function copyLayerTiles(srcLayerDir: string, dstLayerDir: string, opts: { maxzoom?: number }): LayerZoomRange {
    if (!existsSync(srcLayerDir)) return { minzoom: null, maxzoom: null };
    let minZ: number | null = null;
    let maxZ: number | null = null;

    for (const ent of readdirSync(srcLayerDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue; // skip collection subdirs
        const z = Number(ent.name);
        if (opts.maxzoom !== undefined && z > opts.maxzoom) continue;
        copyDirRecursive(path.join(srcLayerDir, ent.name), path.join(dstLayerDir, ent.name));
        minZ = minZ === null ? z : Math.min(minZ, z);
        maxZ = maxZ === null ? z : Math.max(maxZ, z);
    }
    return { minzoom: minZ, maxzoom: maxZ };
}

function copyDirRecursive(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true });
    for (const ent of readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) copyDirRecursive(s, d);
        else if (ent.isFile()) copyFileSync(s, d);
    }
}

// --- Bundle assembly -------------------------------------------------------

export async function buildBundle(deps: PublishDeps, opts: BuildBundleOptions): Promise<BuildBundleResult> {
    const { db, dataDir } = deps;
    const { siteId } = opts;
    const orthoMaxzoom = opts.orthoMaxzoom ?? DEFAULT_ORTHO_MAXZOOM;
    const warnings: string[] = [];

    const site = await db.selectFrom('sites').select('id').where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new Error(`Site ${siteId} not found`);

    const scope = await resolveScope(db, siteId);

    const stagingDir = path.join(opts.outDir, `${siteId}-bundle`);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(path.join(stagingDir, 'content'), { recursive: true });
    mkdirSync(path.join(stagingDir, 'seed'), { recursive: true });

    // Content jsonl (always write every table file, even when empty, so the
    // content hash covers a fixed file set).
    for (const table of CONTENT_TABLES) {
        const rows = await contentRows(db, table, scope, siteId);
        await Bun.write(path.join(stagingDir, contentFilePath(table)), toJsonl(rows));
    }

    // Pin seed (D3): all of the site's current pins; ingest applies only on a
    // first publish (site with no pins on the VPS).
    const seedPins = scope.greenIds.length
        ? await db.selectFrom('pins').selectAll().where('green_id', 'in', scope.greenIds).execute()
        : [];
    await Bun.write(path.join(stagingDir, SEED_PINS_PATH), toJsonl(seedPins));

    // Tiles.
    const srcTiles = path.join(dataDir, 'tiles', siteId);
    const manifestPath = path.join(srcTiles, 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw new Error(`No tile manifest for site ${siteId} at ${manifestPath} — build the map first`);
    }
    const layerZoomRanges: Partial<Record<BundleTileLayer, LayerZoomRange>> = {};
    for (const layer of BUNDLE_TILE_LAYERS) {
        const range = copyLayerTiles(
            path.join(srcTiles, layer),
            path.join(stagingDir, 'tiles', layer),
            layer === 'ortho' ? { maxzoom: orthoMaxzoom } : {},
        );
        if (range.minzoom !== null) layerZoomRanges[layer] = range;
    }

    // Manifest with ortho maxzoom capped.
    const manifest = JSON.parse(await Bun.file(manifestPath).text());
    const stems = manifest.assets?.['tree-stems'];
    if (stems !== undefined) {
        if (stems.path !== 'tree-stems.json' || stems.format !== 'tree-stems-v1') {
            throw new Error('Invalid tree-stems manifest descriptor');
        }
        // Copy the declared asset or fail the build; never publish a dangling descriptor.
        copyFileSync(path.join(srcTiles, 'tree-stems.json'), path.join(stagingDir, 'tiles', 'tree-stems.json'));
    }
    if (manifest.layers?.ortho && typeof manifest.layers.ortho.maxzoom === 'number') {
        manifest.layers.ortho.maxzoom = Math.min(manifest.layers.ortho.maxzoom, orthoMaxzoom);
    }
    await Bun.write(path.join(stagingDir, 'tiles', 'manifest.json'), JSON.stringify(manifest));

    // Analysis DEM (D2/§6): the greens mosaic, unless --full-dem was asked for.
    const analysisDem = await installAnalysisDem(deps, opts, siteId, scope, stagingDir, warnings);

    // Content hash over the fixed file set.
    const parts: Buffer[] = [];
    for (const rel of CONTENT_HASH_FILES) {
        const file = Bun.file(path.join(stagingDir, rel));
        parts.push((await file.exists()) ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0));
    }

    const meta: BundleMeta = {
        formatVersion: BUNDLE_FORMAT_VERSION,
        siteId,
        courseIds: scope.courseIds,
        contentHash: contentHash(parts),
        orthoMaxzoom,
        layerZoomRanges,
        createdAt: new Date().toISOString(),
    };
    await Bun.write(path.join(stagingDir, 'meta.json'), JSON.stringify(meta, null, 2));

    if (analysisDem === 'none') warnings.push('No analysis DEM shipped (no dem_cog asset / file); green reading unavailable on the VPS.');

    return { stagingDir, meta, warnings, analysisDem };
}

// --- Analysis DEM (§6 / W4) ------------------------------------------------

/**
 * The builder DEM the analysis mosaic must be derived from.
 *
 * `dem-edited.tif` when the site has terrain edits, else the raw `dem.tif`
 * (D-TE2) — which is exactly what a completed map build registers as the
 * site's `dem_cog` asset, so the asset is the authority. The on-disk
 * `dem-edited.tif` is still checked as a safety net: if edits were applied
 * but the asset was left pointing at the raw DEM, publishing the raw DEM
 * would silently ship un-edited greens.
 */
function resolveSourceDem(
    dataDir: string,
    siteId: string,
    assetFilename: string | null,
    warnings: string[],
): string | null {
    const edited = path.join(dataDir, 'sources', siteId, 'dem-edited.tif');
    const registered = assetFilename ? path.resolve(dataDir, assetFilename) : null;

    if (existsSync(edited)) {
        if (registered && path.resolve(registered) !== path.resolve(edited)) {
            warnings.push(
                `dem_cog points at ${assetFilename} but sources/${siteId}/dem-edited.tif exists — publishing the edited DEM. Rebuild the map to re-sync the asset.`,
            );
        }
        return edited;
    }
    if (!registered) return null;
    if (!existsSync(registered)) {
        warnings.push(`dem_cog asset points at a missing file: ${assetFilename}`);
        return null;
    }
    return registered;
}

/**
 * The site's green polygons as a WGS84 GeoJSON FeatureCollection — the
 * handoff format `golfpipe dem-analysis` expects (D-TE5). Greens are
 * `course_features` rows of type 'green'; a feature with unparseable or
 * degenerate geometry is skipped rather than failing the publish.
 */
async function greensFeatureCollection(
    db: Kysely<Database>,
    scope: SiteScope,
    warnings: string[],
): Promise<string> {
    const rows = scope.courseIds.length
        ? await db
            .selectFrom('course_features')
            .innerJoin('holes', 'holes.id', 'course_features.hole_id')
            .select(['course_features.id as id', 'course_features.geometry_json as geometry_json', 'holes.number as hole_number'])
            .where('course_features.course_id', 'in', scope.courseIds)
            .where('course_features.type', '=', 'green')
            .orderBy('holes.number')
            .execute()
        : [];

    const features: unknown[] = [];
    for (const row of rows) {
        try {
            const geometry = JSON.parse(row.geometry_json) as FeatureGeometry;
            if (!geometry.rings?.length) continue;
            features.push({
                type: 'Feature',
                geometry: toGeoJson(geometry),
                properties: { holeNumber: row.hole_number },
            });
        } catch (err) {
            warnings.push(`Green feature ${row.id} has unusable geometry, excluded from the analysis DEM: ${err}`);
        }
    }
    if (features.length === 0) {
        warnings.push('No green polygons found — the analysis DEM will be coarse everywhere. Draw the greens before publishing.');
    }
    return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * Installs `dem/dem-analysis.tif` into the staging bundle.
 *
 * Default path builds the §6 mosaic (0.5 m within 30 m of a green, 1 m
 * elsewhere, one deflate GeoTIFF on the source grid) via
 * `golfpipe dem-analysis`, cached at `sources/<siteId>/dem-analysis.tif` and
 * rebuilt only when stale — i.e. when the cache is missing, older than the
 * source DEM, or was built from a different set of greens.
 *
 * If the pipeline is unavailable or fails, the full builder DEM is shipped
 * with a warning: a fat bundle beats a VPS that cannot read greens at all.
 */
async function installAnalysisDem(
    deps: PublishDeps,
    opts: BuildBundleOptions,
    siteId: string,
    scope: SiteScope,
    stagingDir: string,
    warnings: string[],
): Promise<AnalysisDemMode> {
    const { db, dataDir } = deps;
    const asset = await db
        .selectFrom('course_assets')
        .select('filename')
        .where('site_id', '=', siteId)
        .where('kind', '=', 'dem_cog')
        .executeTakeFirst();

    const sourceDem = resolveSourceDem(dataDir, siteId, asset?.filename ?? null, warnings);
    if (!sourceDem) return 'none';

    const install = (from: string): void => {
        mkdirSync(path.join(stagingDir, 'dem'), { recursive: true });
        copyFileSync(from, path.join(stagingDir, 'dem', 'dem-analysis.tif'));
    };

    if (opts.fullDem) {
        install(sourceDem);
        return 'full';
    }

    const derivedDir = path.join(dataDir, 'sources', siteId);
    const cachePath = path.join(derivedDir, 'dem-analysis.tif');
    const greensPath = path.join(derivedDir, 'dem-analysis.greens.json');
    const greens = await greensFeatureCollection(db, scope, warnings);

    if (!isAnalysisDemStale(cachePath, greensPath, sourceDem, greens)) {
        install(cachePath);
        return 'mosaic-cached';
    }

    const pipelineDir = deps.pipelineDir
        ?? process.env.MAP_PIPELINE_DIR
        ?? path.resolve(process.cwd(), '../pipeline');
    const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? path.join(pipelineDir, '.venv', 'bin', 'python');
    const runner = deps.runner ?? defaultRunner(python);

    mkdirSync(derivedDir, { recursive: true });
    await Bun.write(greensPath, greens);
    // Build beside the cache and move on success, so a failed run can never
    // leave a half-written mosaic that the next publish would treat as fresh.
    const tmpPath = `${cachePath}.tmp`;
    rmSync(tmpPath, { force: true });

    // A missing interpreter does NOT come back as a non-zero exit: Bun.spawn
    // throws ENOENT before there is a process to exit. Both failures land in
    // the same fallback — the publish must survive a builder whose venv was
    // never created.
    let result: PipelineRunResult;
    try {
        result = await runner(
            ['-m', 'golfpipe', 'dem-analysis', '--input', sourceDem, '--greens', greensPath, '--out', tmpPath],
            { cwd: pipelineDir, env: { ...process.env } },
        );
    } catch (err) {
        result = { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
    if (result.code !== 0 || !existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
        rmSync(greensPath, { force: true }); // don't let a failed run poison the staleness check
        warnings.push(
            `golfpipe dem-analysis failed (exit ${result.code}) — shipping the full builder DEM instead. `
            + `Check the pipeline venv (${python}). ${result.stderr.trim().split('\n').pop() ?? ''}`,
        );
        install(sourceDem);
        return 'full';
    }

    rmSync(cachePath, { force: true });
    renameSync(tmpPath, cachePath);
    install(cachePath);
    return 'mosaic';
}

/** Cache is fresh only if it postdates the source DEM and matches its greens. */
function isAnalysisDemStale(cachePath: string, greensPath: string, sourceDem: string, greens: string): boolean {
    if (!existsSync(cachePath) || !existsSync(greensPath)) return true;
    if (statSync(cachePath).mtimeMs < statSync(sourceDem).mtimeMs) return true;
    try {
        return readFileSync(greensPath, 'utf8') !== greens;
    } catch {
        return true;
    }
}

/** Packs a staging bundle dir into `outPath` (tar.zst). */
export async function packBundle(stagingDir: string, outPath: string): Promise<void> {
    mkdirSync(path.dirname(outPath), { recursive: true });
    await createTarZst(stagingDir, outPath);
}

// --- Preflight -------------------------------------------------------------

export async function preflight(deps: PublishDeps, siteId: string): Promise<string[]> {
    const { db, dataDir } = deps;
    const warnings: string[] = [];

    const site = await db.selectFrom('sites').select('id').where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new Error(`Site ${siteId} not found`);

    const manifestPath = path.join(dataDir, 'tiles', siteId, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`No tile manifest for site ${siteId} — build the map first`);

    const running = await db
        .selectFrom('map_build_jobs')
        .select('id')
        .where('site_id', '=', siteId)
        .where('status', 'in', ['pending', 'running'])
        .executeTakeFirst();
    if (running) throw new Error(`A map build is in progress for site ${siteId} (job ${running.id}) — wait for it to finish`);

    // Warn if patched ortho sources are newer than the built tile tree (unbaked edits).
    const sourcesDir = path.join(dataDir, 'sources', siteId);
    const orthoDir = path.join(dataDir, 'tiles', siteId, 'ortho');
    if (existsSync(sourcesDir) && existsSync(orthoDir)) {
        const builtMtime = statSync(orthoDir).mtimeMs;
        for (const ent of readdirSync(sourcesDir)) {
            if (ent.endsWith('.patched.tif') && statSync(path.join(sourcesDir, ent)).mtimeMs > builtMtime) {
                warnings.push(`Patched ortho ${ent} is newer than the built tiles — edits may be unbaked. Rebuild before publishing.`);
            }
        }
    }
    return warnings;
}

// --- Upload ----------------------------------------------------------------

export async function uploadBundle(bundlePath: string, url: string, token: string): Promise<unknown> {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/ingest/site`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-tar+zstd',
        },
        body: Bun.file(bundlePath),
        // @ts-expect-error Bun streaming upload
        duplex: 'half',
    });
    const text = await res.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`Ingest failed (HTTP ${res.status}): ${text}`);
    }
    return json;
}

// --- CLI -------------------------------------------------------------------

const ANALYSIS_DEM_LABEL: Record<AnalysisDemMode, string> = {
    mosaic: 'rebuilt greens mosaic',
    'mosaic-cached': 'greens mosaic (cache still fresh)',
    full: 'full builder DEM',
    none: 'none',
};

const USAGE = 'Usage: bun run publish <siteId> [--ortho-maxzoom 19] [--out <dir>] [--no-upload] [--full-dem]';

export function parseArgs(argv: string[]): { siteId: string; orthoMaxzoom: number; outDir: string; upload: boolean; fullDem: boolean } {
    const positional: string[] = [];
    let orthoMaxzoom = DEFAULT_ORTHO_MAXZOOM;
    let outDir = path.join(path.dirname(config.dbPath), 'publish');
    let upload = true;
    let fullDem = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ortho-maxzoom') orthoMaxzoom = Number(argv[++i]);
        else if (a === '--out') outDir = argv[++i];
        else if (a === '--no-upload') upload = false;
        else if (a === '--full-dem') fullDem = true;
        else positional.push(a);
    }
    if (!positional[0]) throw new Error(USAGE);
    return { siteId: positional[0], orthoMaxzoom, outDir, upload, fullDem };
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));
    const dataDir = process.env.DATA_DIR ?? path.dirname(config.dbPath);

    mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = createDb<Database>(config.dbPath);
    await runMigrations(db, path.join(import.meta.dir, '../db/migrations'));

    try {
        console.log(`Preflight for site ${args.siteId}…`);
        const pfWarnings = await preflight({ db, dataDir }, args.siteId);
        for (const w of pfWarnings) console.warn(`  ⚠ ${w}`);

        console.log('Assembling bundle…');
        const { stagingDir, meta, warnings, analysisDem } = await buildBundle({ db, dataDir }, {
            siteId: args.siteId,
            orthoMaxzoom: args.orthoMaxzoom,
            outDir: args.outDir,
            fullDem: args.fullDem,
        });
        for (const w of warnings) console.warn(`  ⚠ ${w}`);
        console.log(`  analysis DEM: ${ANALYSIS_DEM_LABEL[analysisDem]}`);

        const bundlePath = path.join(args.outDir, `${args.siteId}.tar.zst`);
        console.log(`Packing → ${bundlePath}`);
        await packBundle(stagingDir, bundlePath);
        const size = statSync(bundlePath).size;
        console.log(`  bundle ${(size / 1e6).toFixed(1)} MB, ortho cap z${meta.orthoMaxzoom}, ${meta.courseIds.length} course(s)`);

        if (!args.upload) {
            console.log('--no-upload: bundle left on disk, not uploaded.');
            return;
        }

        const url = process.env.PUBLISH_URL;
        const token = process.env.PUBLISH_TOKEN;
        if (!url || !token) {
            throw new Error('Set PUBLISH_URL and PUBLISH_TOKEN to upload (or pass --no-upload).');
        }
        console.log(`Uploading to ${url} …`);
        const report = await uploadBundle(bundlePath, url, token);
        console.log('Ingest report:');
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await db.destroy();
    }
}

if (import.meta.main) {
    await main();
}
