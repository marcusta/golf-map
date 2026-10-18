// Acceptance A4: photo stems from proposal to the GSPro trees file, for real. The pipeline venv's Python
// runs `golfpipe photo-stems` and `gspro.py trees` on the Omberg cut-out of the rough between greens 1
// and 10 (pipeline/tests/fixtures/photo-stems-omberg/rough-1-10), installed as the course's site data.
//
//   propose (dry run: changes no file) -> propose -> accept two, skip one -> the trees export carries the two
//   with src "photo" and the same ids, the lidar trees as before -> the next proposal offers none of the three
import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { createTestDbWith } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { GsproExportService, defaultRunner, venvPython, type ExportRunner } from './gspro-export.service';

const PIPELINE = path.resolve(import.meta.dir, '..', '..', 'pipeline');
const PYTHON = venvPython(PIPELINE);
const FIXTURE = path.join(PIPELINE, 'tests', 'fixtures', 'photo-stems-omberg', 'rough-1-10');
const SITE_ID = 'site-omberg-cut';
/** Omberg's inner square (EPSG:3006), which the cut-out lies inside. */
const INNER: [number, number, number, number] = [477021, 6456736, 478531, 6458246];
const SKIP = existsSync(PYTHON) ? '' : `the pipeline venv (${PYTHON})`;
if (SKIP) console.warn(`photo-stems.acceptance.test: skipped, it needs ${SKIP}`);

type Proposal = { id: string; x: number; y: number; heightM: number; crownRadiusM: number; kind: number; source: string };
type UnityTree = { id: string; x: number; z: number; h: number; r: number; k: number; src?: string };

async function setup() {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-data-'));
    const ctx = await createTestDbWith({ dataDir }, seedCourse);
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Omberg cut-out', version: 1 }).execute();
    await ctx.db.updateTable('courses')
        .set({ site_id: SITE_ID, georeference_json: JSON.stringify({ bbox: INNER }) })
        .where('id', '=', TEST_COURSE_ID).execute();

    // The site's photos and lidar stems, where a map build leaves them.
    const sources = path.join(dataDir, 'sources', SITE_ID);
    const tiles = path.join(dataDir, 'tiles', SITE_ID);
    await mkdir(sources, { recursive: true });
    await mkdir(tiles, { recursive: true });
    for (const name of ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif']) {
        await copyFile(path.join(FIXTURE, name), path.join(sources, name));
    }
    await copyFile(path.join(FIXTURE, 'tree-stems.json'), path.join(tiles, 'tree-stems.json'));
    const manifest = await readFile(path.join(FIXTURE, 'manifest.json'), 'utf8');
    await writeFile(path.join(tiles, 'manifest.json'), manifest);
    await ctx.assetsService.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`, metaJson: manifest,
    });

    // The course's drawn surfaces there, as the app stores them.
    const rows = JSON.parse(await readFile(path.join(FIXTURE, 'features.json'), 'utf8')) as
        { type: string; source: string | null; attributes: Record<string, unknown> | null; geometry: unknown }[];
    await ctx.db.deleteFrom('course_features').where('course_id', '=', TEST_COURSE_ID).execute();
    let order = 0;
    for (const r of rows) {
        await ctx.db.insertInto('course_features').values({
            id: `cut-${order}`, course_id: TEST_COURSE_ID, hole_id: null, type: r.type,
            geometry_json: JSON.stringify(r.geometry), geojson: null, layer: null, sort_order: order++,
            source: r.source, source_ref: null, license: null,
            attributes_json: r.attributes ? JSON.stringify(r.attributes) : null, version: 1,
        }).execute();
    }

    // The export folder, with the inner heightmap already exported (its sidecar gives the height range).
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'photo-stems-export-'));
    await ctx.gsproExportService.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-1510m.tif.json'),
        JSON.stringify({ terrain: 'inner', minM: 80.76, maxM: 122.14 }));

    // stand-in: the test database lives in memory, so gspro.py (which reads the course's paths, rock slabs
    // and tree areas from the app database) is handed a snapshot of it, as it reads data/app.sqlite in the app.
    const real = defaultRunner(PYTHON);
    const snapshot = path.join(exportDir, 'app-snapshot.sqlite');
    const runner: ExportRunner = async (args, cwd, opts) => {
        if (args.includes('--course') && !args.includes('--db')) {
            await rm(snapshot, { force: true });
            await sql`VACUUM INTO ${snapshot}`.execute(ctx.db);
            args = [...args, '--db', snapshot];
        }
        return real(args, cwd, opts);
    };
    const exporter = new GsproExportService({
        db: ctx.db, courses: ctx.coursesService, assets: ctx.assetsService, dataDir, runner, terrainEdits: ctx.terrainEditsService,
    });
    return { ctx, dataDir, exportDir, exporter, svc: ctx.photoStemsService };
}

/** Every file under `dir` with its size and modification time. */
async function snapshotFiles(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath, entry.name);
        const s = await stat(full);
        out[path.relative(dir, full)] = `${s.size}:${s.mtimeMs}`;
    }
    return out;
}

async function exportedTrees(exporter: GsproExportService, exportDir: string): Promise<UnityTree[]> {
    const res = await exporter.exportTrees(TEST_COURSE_ID, 'inner', { force: true });
    expect(res.path).toBe(path.join(exportDir, 'linkan-inner-trees.json'));
    return JSON.parse(await readFile(res.path, 'utf8')).trees as UnityTree[];
}

test.skipIf(!!SKIP)('photo stems: propose, accept two and skip one, and the two reach the GSPro trees file', async () => {
    const { dataDir, exportDir, exporter, svc } = await setup();
    const lidarOnly = await exportedTrees(exporter, exportDir);
    expect(lidarOnly.filter((t) => t.src === 'photo')).toEqual([]);

    // A dry run proposes and changes no file.
    const before = await snapshotFiles(dataDir);
    const dry = await svc.propose(TEST_COURSE_ID, { dryRun: true });
    expect(await snapshotFiles(dataDir)).toEqual(before);
    expect(dry.proposals.length).toBeGreaterThanOrEqual(20);
    for (const p of dry.proposals as Proposal[]) {
        expect(p.source).toBe('ortho-shadow');
        expect(p.id).toMatch(/^epsg3006:\d+\.\d{2}:\d+\.\d{2}$/);
    }

    // The real proposal is the same trees under the same ids.
    const first = await svc.propose(TEST_COURSE_ID);
    expect((first.proposals as Proposal[]).map((p) => p.id).sort()).toEqual((dry.proposals as Proposal[]).map((p) => p.id).sort());

    const [a, b, c] = first.proposals as Proposal[];
    await svc.accept(TEST_COURSE_ID, { accept: [a!.id, b!.id], skip: [c!.id] });

    // The trees export carries the two accepted, marked as photo stems, at their proposed size; the lidar trees as before.
    const withPhoto = await exportedTrees(exporter, exportDir);
    const photo = withPhoto.filter((t) => t.src === 'photo').sort((p, q) => p.id.localeCompare(q.id));
    expect(photo.map((t) => t.id)).toEqual([a!.id, b!.id].sort());
    for (const t of photo) {
        const p = (t.id === a!.id ? a : b)!;
        expect(t.h).toBeCloseTo(p.heightM, 1);
        expect(t.r).toBeCloseTo(p.crownRadiusM, 1);
        expect(t.k).toBe(p.kind);
        expect(t.x).toBeCloseTo(p.x - INNER[0], 1);
        expect(t.z).toBeCloseTo(p.y - INNER[1], 1);
    }
    expect(withPhoto.filter((t) => t.src !== 'photo')).toEqual(lidarOnly);

    // The next proposal offers neither the accepted nor the skipped, and keeps the other ids.
    const second = await svc.propose(TEST_COURSE_ID);
    const ids = (second.proposals as Proposal[]).map((p) => p.id).sort();
    expect(ids).not.toContain(a!.id);
    expect(ids).not.toContain(b!.id);
    expect(ids).not.toContain(c!.id);
    expect(ids).toEqual((first.proposals as Proposal[]).map((p) => p.id).filter((id) => ![a!.id, b!.id, c!.id].includes(id)).sort());
}, 600_000);
