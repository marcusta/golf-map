import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sql } from 'kysely';
import { createTestDb } from './db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from '../services/assets.service';
import type { PipelineRunner } from '../services/map-build.service';
import { OrthoPatchesService } from '../services/ortho-patches.service';

// Fixture for the ortho-patches service and route tests: a course with a
// built map in a temp data dir, and a stand-in for the golfpipe process that
// records each call and leaves the same files behind as the real commands
// (map-build test pattern — no Python).

export const SITE_ID = 'site-t55';
export const ACTIVE = 'orto-l2-2025';

export const MANIFEST = {
    courseId: TEST_COURSE_ID,
    bounds: { west: 15.55, south: 58.39, east: 15.58, north: 58.41 },
    layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 16 } },
    elevation: { min: 67.8, max: 83.9 },
    generatedAt: '2026-07-14T10:25:11.864Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
    orthoVintages: [{ collection: ACTIVE, dates: ['2025-06-21'] }],
    activeOrtho: ACTIVE,
};

// A real (1x1 transparent) PNG so the signature check passes.
export const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const TINY_PNG = Buffer.from(TINY_PNG_BASE64, 'base64');

/** The frame the fake export creates, and what a changed import reports. */
export const FRAME = { extent3006: [532463.6, 6472748.08, 533693.6, 6473978.08], size: 8192 };
export const IMPORT_BOUNDS_3006 = { west: 533000.5, south: 6473000.25, east: 533361.1, north: 6473456.85 };
export const IMPORT_BOUNDS_3857 = { west: 1733001.5, south: 8018002.5, east: 1733690.25, north: 8018873.75 };

export interface RunnerCall { args: string[] }

export function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

export function argValues(args: string[], flag: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === flag) out.push(args[i + 1]);
    }
    return out;
}

/** What the fake `import-ortho-square` finds in the edited image. */
export type FakeImportOutcome = 'changed' | 'identical' | 'below-min-area' | 'outside-ortho';

export interface FakeRunnerOptions {
    calls: RunnerCall[];
    /** Fail this call with exit 1 and `replay boom` on stderr. `command` is the golfpipe command. */
    fail?: (command: string) => boolean;
    torchOk?: () => boolean;
    importOutcome?: () => FakeImportOutcome;
}

/** `export-ortho-square`: frame on first use, image + export.json, export.json on stdout. */
async function fakeExport(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const framePath = argValue(args, '--frame')!;
    const outDir = argValue(args, '--out-dir')!;
    const seq = Number(argValue(args, '--seq'));
    const format = argValue(args, '--format') ?? 'png';
    const bounds = argValue(args, '--bounds-wgs84');
    if (existsSync(path.join(outDir, 'export.json'))) {
        return { code: 1, stdout: '', stderr: `error: export ${outDir} already exists — exports are immutable, use a new --seq` };
    }
    if (!existsSync(framePath)) {
        if (!bounds) return { code: 1, stdout: '', stderr: `error: ${framePath} does not exist and no --bounds-wgs84 was given` };
        await writeFile(framePath, JSON.stringify(FRAME));
    } else if (bounds) {
        return { code: 1, stdout: '', stderr: 'error: the frame exists; refusing other bounds' };
    }
    await mkdir(outDir, { recursive: true });
    const file = `ortho-sim-${seq}.${format}`;
    const image = `export ${seq} of ${path.basename(argValue(args, '--ortho')!)}`;
    await writeFile(path.join(outDir, file), image);
    const meta = {
        exportSeq: seq,
        extent3006: FRAME.extent3006,
        size: FRAME.size,
        logSeq: Number(argValue(args, '--log-seq')),
        sha256: new Bun.CryptoHasher('sha256').update(image).digest('hex'),
        createdAt: `2026-10-07T16:53:${String(seq).padStart(2, '0')}Z`,
        file,
        format,
        bytes: image.length,
    };
    await writeFile(path.join(outDir, 'export.json'), JSON.stringify(meta, null, 2) + '\n');
    return { code: 0, stdout: JSON.stringify(meta) + '\n', stderr: 'Exported\n' };
}

/** `import-ortho-square`: writes `<seq>.png` only when something changed; never the log. */
async function fakeImport(args: string[], outcome: FakeImportOutcome): Promise<{ code: number; stdout: string; stderr: string }> {
    const exportDir = argValue(args, '--export-dir')!;
    const patchesDir = argValue(args, '--patches-dir')!;
    const seq = Number(argValue(args, '--seq'));
    if (!existsSync(argValue(args, '--image')!)) return { code: 1, stdout: '', stderr: 'error: edited image not found' };
    const meta = JSON.parse(await readFile(path.join(exportDir, 'export.json'), 'utf8')) as { exportSeq: number; format: string };
    const tolerance = argValue(args, '--tolerance');
    if (meta.format === 'jpg' && tolerance === undefined) {
        return { code: 1, stdout: '', stderr: 'error: refusing to import a JPEG/WebP image with the default tolerance' };
    }
    const base = {
        changed: outcome === 'changed',
        seq,
        exportSeq: meta.exportSeq,
        changedPixels: outcome === 'changed' ? 123168 : 0,
        diffPixels: outcome === 'identical' || outcome === 'outside-ortho' ? 0 : 121600,
        tolerance: tolerance === undefined ? 2 : Number(tolerance),
        minAreaPx: 4,
    };
    if (outcome !== 'changed') {
        return { code: 0, stdout: JSON.stringify({ ...base, reason: outcome }) + '\n', stderr: '' };
    }
    await mkdir(patchesDir, { recursive: true });
    await writeFile(path.join(patchesDir, `${seq}.png`), TINY_PNG);
    return {
        code: 0,
        stdout: JSON.stringify({
            ...base,
            kind: 'raster',
            file: `${seq}.png`,
            bounds3006: IMPORT_BOUNDS_3006,
            bounds3857: IMPORT_BOUNDS_3857,
            regions: 2,
            widthPx: 2404,
            heightPx: 3044,
            bytes: TINY_PNG.length,
        }) + '\n',
        stderr: 'Diffed\n',
    };
}

export function fakeRunner(opts: FakeRunnerOptions): PipelineRunner {
    return async (args) => {
        // The cached inpaint-deps pre-flight probes `python -c "import torch"`.
        if (args[0] === '-c') {
            return (opts.torchOk?.() ?? true)
                ? { code: 0, stdout: '', stderr: '' }
                : { code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'torch'" };
        }
        opts.calls.push({ args });
        const command = args[2];
        if (opts.fail?.(command)) return { code: 1, stdout: '', stderr: 'replay boom' };
        if (command === 'export-ortho-square') return fakeExport(args);
        if (command === 'import-ortho-square') return fakeImport(args, opts.importOutcome?.() ?? 'changed');
        // Materialize the working .patched.tif like the real command would.
        const out = argValue(args, '--out');
        if (out) await writeFile(out, 'fake patched tif');
        return { code: 0, stdout: 'ok\n', stderr: '' };
    };
}

export async function setup(opts: {
    fail?: (command: string) => boolean;
    withSite?: boolean;
    torchOk?: () => boolean;
    withWeights?: boolean;
    importOutcome?: () => FakeImportOutcome;
} = {}) {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'golf-patches-test-'));
    const calls: RunnerCall[] = [];
    const assets = new AssetsService(ctx.db, dataDir);

    const lamaWeights = path.join(dataDir, 'big-lama.pt');
    if (opts.withWeights !== false) await writeFile(lamaWeights, 'weights');

    if (opts.withSite !== false) {
        await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'T55 site', version: 1 }).execute();
        await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
            .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
        await mkdir(path.join(dataDir, 'sources', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'sources', SITE_ID, `ortho-${ACTIVE}.tif`), 'pristine');
        await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(MANIFEST));
        await assets.register({
            siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
            filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(MANIFEST),
        });
    }

    const svc = new OrthoPatchesService({
        db: ctx.db,
        assets,
        dataDir,
        pipelineDir: '/nonexistent/pipeline',
        python: '/nonexistent/python',
        lamaWeights,
        runner: fakeRunner({ calls, fail: opts.fail, torchOk: opts.torchOk, importOutcome: opts.importOutcome }),
    });
    const sourcesDir = path.join(dataDir, 'sources', SITE_ID);
    const patchesDir = path.join(sourcesDir, 'patches');
    const exportsDir = path.join(sourcesDir, 'exports');
    const simDir = path.join(dataDir, 'tiles', SITE_ID, 'ortho-sim');
    const readLog = async () =>
        JSON.parse(await readFile(path.join(patchesDir, 'patches.json'), 'utf8')) as {
            version: number;
            patches: Array<{
                seq: number; kind?: string; file?: string; tool: string;
                bounds3857: unknown; stamp?: Record<string, unknown>;
            } & Record<string, unknown>>;
        };
    const readManifest = async () =>
        JSON.parse(await readFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    /** An "edited image" waiting in the service's incoming dir, as the route leaves it. */
    const incoming = async (bytes: Uint8Array = TINY_PNG) => {
        const tmpPath = await svc.incomingImportPath(TEST_COURSE_ID);
        await writeFile(tmpPath, bytes);
        return tmpPath;
    };
    /** Files left in `patches/.incoming` (must be none after any import). */
    const incomingLeft = () => {
        const dir = path.join(patchesDir, '.incoming');
        return existsSync(dir) ? Array.from(new Bun.Glob('*').scanSync(dir)) : [];
    };
    return {
        ctx, svc, assets, dataDir, calls, sourcesDir, patchesDir, exportsDir, simDir,
        readLog, readManifest, lamaWeights, incoming, incomingLeft,
        cleanup: () => rm(dataDir, { recursive: true, force: true }),
    };
}
