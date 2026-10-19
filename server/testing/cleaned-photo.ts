// Fixture for the cleaned-photo tests: a seeded course with a built site on
// disk and a stand-in for golfpipe's cleaned-* commands that keeps the photo
// as a small text file, so a test can read what each command did to it.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sql } from 'kysely';
import { createTestDb } from './db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from '../services/assets.service';
import { CoursesService } from '../services/courses.service';
import { CleanedPhotoService } from '../services/cleaned-photo.service';
import type { PipelineRunner } from '../services/map-build.service';

export const SITE_ID = 'site-clean';
export const ACTIVE = 'orto-l2-2025';
/** The inner terrain square the manifest carries. */
export const SQUARE = [529030, 6486669, 531080, 6488719];

export const MANIFEST = {
    courseId: TEST_COURSE_ID,
    bounds: { west: 15.55, south: 58.39, east: 15.58, north: 58.41 },
    terrain: { inner: { square3006: SQUARE, sideM: 2050 } },
    layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 16 } },
    elevation: { min: 67.8, max: 83.9 },
    generatedAt: '2026-07-14T10:25:11.864Z',
    attribution: '© Lantmäteriet, CC BY 4.0',
    orthoVintages: [{ collection: ACTIVE, dates: ['2025-06-21'] }],
    activeOrtho: ACTIVE,
};

// A real (1x1 transparent) PNG so signature checks pass.
export const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const TINY_PNG = Buffer.from(TINY_PNG_BASE64, 'base64');

export const CHANGE_BOUNDS_3006 = { west: 530000, south: 6487000, east: 530100, north: 6487050 };

export interface RunnerCall {
    args: string[];
    /** `cleaned-patch` only: the patches as they lay in the patches dir. */
    patches?: { entries: Array<Record<string, any>>; files: string[]; bytes: number[] };
}

export function argValue(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

export interface FakeRunnerOptions {
    calls: RunnerCall[];
    /** Fail this call with exit 1 and `pipeline boom` on stderr. `command` is the golfpipe command. */
    fail?: (command: string) => boolean;
    /** Whether a `cleaned-replace` of an uploaded image finds a difference (default yes). */
    importChanges?: () => boolean;
    /** `cleanup-hole` fails for these holes. */
    failHole?: (hole: number) => boolean;
    /** Pixels `cleanup-hole` reports changed for a hole (default 100 x its number). */
    holeChanges?: (hole: number) => number;
}

export function fakeRunner(opts: FakeRunnerOptions): PipelineRunner {
    const ok = (doc: unknown) => ({ code: 0, stdout: `progress line\n${JSON.stringify(doc)}\n`, stderr: '' });
    return async (args) => {
        const call: RunnerCall = { args };
        opts.calls.push(call);
        const command = args[2];
        const cleaned = argValue(args, '--cleaned');
        if (command === 'cleaned-patch') {
            const dir = argValue(args, '--patches-dir')!;
            const entries = JSON.parse(await readFile(path.join(dir, 'patches.json'), 'utf8')) as Array<Record<string, any>>;
            const bytes = await Promise.all(entries.map(async e => (await readFile(path.join(dir, e.file))).length));
            call.patches = { entries, files: (await readdir(dir)).sort(), bytes };
        }
        if (opts.fail?.(command)) {
            // A real failure can leave the photo half written.
            if (cleaned && existsSync(cleaned) && command !== 'cleaned-export') await writeFile(cleaned, 'half written');
            return { code: 1, stdout: '', stderr: 'progress\nerror: pipeline boom' };
        }
        if (command === 'cleaned-init') {
            const out = argValue(args, '--out')!;
            await writeFile(out, `photo of ${path.basename(argValue(args, '--ortho')!)}`);
            return ok({ file: path.basename(out), size: Number(argValue(args, '--size')) });
        }
        if (command === 'cleaned-patch') {
            const e = call.patches!.entries[0];
            await writeFile(cleaned!, `${await readFile(cleaned!, 'utf8')} +${e.w}x${e.h}@${e.x},${e.y}`);
            return ok({ patches: call.patches!.entries.length, pixels: e.w * e.h, tiles: 12 });
        }
        if (command === 'cleaned-replace') {
            const image = argValue(args, '--image')!;
            if (!existsSync(image)) return { code: 1, stdout: '', stderr: 'error: no such image' };
            const snapshot = image.endsWith('.tif') && path.basename(path.dirname(image)) === 'cleaned-history';
            if (!snapshot && !(opts.importChanges?.() ?? true)) return ok({ changed: false, changedPixels: 0, size: 8192 });
            await writeFile(cleaned!, snapshot ? await readFile(image) : `image ${path.extname(image)} of ${(await readFile(image)).length} bytes`);
            return ok({ changed: true, changedPixels: 5000, size: 8192, bounds3006: CHANGE_BOUNDS_3006, tiles: 30 });
        }
        if (command === 'cleanup-hole') {
            // A cleaned hole: its review files and what it found, `changedPx`
            // from `holeChanges` (default 100 per hole number).
            const hole = Number(argValue(args, '--hole'));
            const out = argValue(args, '--out')!;
            if (opts.failHole?.(hole)) return { code: 1, stdout: '', stderr: `hole ${hole}: progress\nerror: hole ${hole} lies outside the photo` };
            await mkdir(out, { recursive: true });
            for (const name of ['review', 'photo', 'filled', 'detect', 'overlay', 'changed']) await writeFile(path.join(out, `${name}.png`), TINY_PNG);
            const changedPx = opts.holeChanges?.(hole) ?? 100 * hole;
            const doc = { hole, window: { x0: 0, y0: 0, w: 1, h: 1 }, scopePx: 1000 * hole, targetPx: 2 * changedPx, changedPx, seconds: 1.5, warnings: [], perSurface: {} };
            await writeFile(path.join(out, 'hole.json'), JSON.stringify(doc));
            return ok(doc);
        }
        if (command === 'cleanup-compose') {
            const out = argValue(args, '--out')!;
            await writeFile(out, TINY_PNG);
            return ok({ file: out, holes: argValue(args, '--holes')!.split(',').map(Number), changedPixels: 1 });
        }
        if (command === 'cleaned-export') {
            const out = argValue(args, '--out')!;
            const format = argValue(args, '--format')!;
            await writeFile(out, `${format} of ${await readFile(cleaned!, 'utf8')}`);
            return ok({ file: path.basename(out), format, size: 8192, bytes: 1 });
        }
        return { code: 1, stdout: '', stderr: `error: unknown command ${command}` };
    };
}

/** Seeded course + (by default) a built site on disk + the service on the fake pipeline. */
export async function setup(opts: {
    fail?: (command: string) => boolean;
    withSite?: boolean;
    importChanges?: () => boolean;
    manifest?: Record<string, unknown>;
} = {}) {
    const ctx = await createTestDb(seedCourse);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'golf-cleaned-test-'));
    const calls: RunnerCall[] = [];
    const assets = new AssetsService(ctx.db, dataDir);
    const manifest = opts.manifest ?? MANIFEST;

    const sourcesDir = path.join(dataDir, 'sources', SITE_ID);
    if (opts.withSite !== false) {
        await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Clean site', version: 1 }).execute();
        await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID)
            .set({ site_id: SITE_ID, updated_at: sql`(datetime('now'))` }).execute();
        await mkdir(sourcesDir, { recursive: true });
        await writeFile(path.join(sourcesDir, `ortho-${ACTIVE}.tif`), 'pristine');
        await mkdir(path.join(dataDir, 'tiles', SITE_ID), { recursive: true });
        await writeFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), JSON.stringify(manifest));
        await assets.register({
            siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
            filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify(manifest),
        });
    }

    const svc = new CleanedPhotoService({
        db: ctx.db,
        assets,
        courses: new CoursesService(ctx.db),
        dataDir,
        pipelineDir: '/nonexistent/pipeline',
        python: '/nonexistent/python',
        runner: fakeRunner({ calls, fail: opts.fail, importChanges: opts.importChanges }),
    });
    const cleanedPath = path.join(sourcesDir, `ortho-${ACTIVE}.cleaned.tif`);
    const historyDir = path.join(sourcesDir, 'cleaned-history');
    const workDir = path.join(sourcesDir, 'cleaned-work');
    const list = (dir: string) => (existsSync(dir) ? Array.from(new Bun.Glob('*').scanSync({ cwd: dir, onlyFiles: false })).sort() : []);
    return {
        ctx, svc, assets, dataDir, calls, sourcesDir, cleanedPath, historyDir, workDir,
        /** The photo's content (the fake keeps it as text), or null before it exists. */
        photo: async () => (existsSync(cleanedPath) ? readFile(cleanedPath, 'utf8') : null),
        /** Undo snapshot file names, oldest first. */
        snapshots: () => list(historyDir).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
        /** What is left in the service's scratch dir. */
        workLeft: () => list(workDir),
        readManifest: async () =>
            JSON.parse(await readFile(path.join(dataDir, 'tiles', SITE_ID, 'manifest.json'), 'utf8')) as Record<string, unknown>,
        /** An uploaded image waiting in the service's scratch dir, as the route leaves it. */
        incoming: async (bytes: Uint8Array = TINY_PNG) => {
            const tmpPath = await svc.incomingImportPath(TEST_COURSE_ID);
            await writeFile(tmpPath, bytes);
            return tmpPath;
        },
        cleanup: () => rm(dataDir, { recursive: true, force: true }),
    };
}
