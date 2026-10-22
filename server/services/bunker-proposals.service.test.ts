import { test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createTestDbWith } from '../testing/db';
import { BunkerProposalsService } from './bunker-proposals.service';
import type { ExportRunner } from './gspro-export.service';
import { sweref99tmToWgs84, type FeatureGeometry } from './geo';

// The pipeline itself runs for real in pipeline/tests/test_bunker_proposals.py and test_surface_model.py; here the
// runner records the call and writes what golfpipe propose-bunkers would, so the test covers what the SERVER decides:
// which files go in, which drawn bunkers are left out, the holes, the skipped places.

// A site with two courses: Masters' hole 1 runs north from x 0, Classic's hole 1 from x 600 (metres from E0, N0).
const E0 = 541200, N0 = 6468000;
const SITE_ID = 'site-bunkers';
const ll = (dx: number, dy: number) => sweref99tmToWgs84(E0 + dx, N0 + dy);
const square = (x: number, y: number, r: number): [number, number][] =>
    [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]].map(([dx, dy]) => [E0 + dx!, N0 + dy!] as [number, number]);
const geometry = (ring: [number, number][]): FeatureGeometry => ({ crs: 'EPSG:3006', rings: [{ points: ring.map(([x, y]) => ({ x, y })) }] });
const feature = (id: string, ring: [number, number][]) => ({
    type: 'Feature', properties: { id, areaM2: 36, confidence: 0.9, edge: 'nir' },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
});

async function setup(opts: { nir?: boolean } = {}) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bunker-proposals-svc-'));
    const ctx = await createTestDbWith({ dataDir });
    await ctx.sitesService.create({ id: SITE_ID, name: 'Landeryd' });
    const masters = await ctx.coursesService.create({ name: 'Masters', siteId: SITE_ID });
    const classic = await ctx.coursesService.create({ name: 'Classic', siteId: SITE_ID });
    for (const [courseId, x] of [[masters.id, 0], [classic.id, 600]] as const) {
        const h = await ctx.holesService.create({ courseId, number: 1, par: 4 });
        const tee = ll(x, 0), green = ll(x, 300);
        await ctx.teesService.create({ holeId: h.id, name: 'Yellow', lat: tee.lat, lon: tee.lon });
        await ctx.greensService.create({ holeId: h.id, centerLat: green.lat, centerLon: green.lon });
    }
    // Drawn bunkers, one on each course: both are the site's and are left out.
    await ctx.courseFeaturesService.create({ courseId: masters.id, type: 'bunker', geometry: geometry(square(10, 280, 4)) });
    await ctx.courseFeaturesService.create({ courseId: classic.id, type: 'bunker', geometry: geometry(square(610, 150, 4)) });
    const sources = path.join(dataDir, 'sources', SITE_ID);
    await mkdir(sources, { recursive: true });
    for (const f of ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif', 'dem.tif', 'dem-edited.tif']) await writeFile(path.join(sources, f), '');
    if (opts.nir !== false) await writeFile(path.join(sources, 'ortho-orto-l2-2025.nir.tif'), '');
    await ctx.assetsService.register({
        siteId: SITE_ID, courseId: masters.id, kind: 'tile_manifest', filename: `tiles/${SITE_ID}/manifest.json`,
        metaJson: JSON.stringify({ activeOrtho: 'orto-l2-2025', orthoVintages: [{ collection: 'orto-l2-2025' }, { collection: 'orto-l2-2023' }] }),
    });
    const modelPath = path.join(dataDir, 'surfaces.pt');
    await writeFile(modelPath, '');

    // What the pipeline finds: a bunker on Masters' hole 1, one far from any hole.
    let found = [feature('bk-a', square(-8, 150, 3)), feature('bk-far', square(1500, 1500, 3))];
    const calls: { args: string[]; known: { features: { geometry: { coordinates: number[][][] } }[] } }[] = [];
    const runner: ExportRunner = async (args) => {
        const known = JSON.parse(await readFile(args[args.indexOf('--known') + 1]!, 'utf8'));
        calls.push({ args, known });
        await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify({
            type: 'FeatureCollection', skipped: { drawn: 2, notCourse: 1, small: 4 }, features: found,
        }));
        return { code: 0, stdout: 'surfaces: 100x100 px on cuda in 3 s\n', stderr: '' };
    };
    const svc = new BunkerProposalsService({
        db: ctx.db, courses: ctx.coursesService, assets: ctx.assetsService, holeAssignment: ctx.holeAssignmentService,
        dataDir, runner, modelPath,
    });
    return { svc, calls, dataDir, masters, sources, modelPath, setFound: (f: typeof found) => { found = f; } };
}

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("the site's active photo, its NIR band, the raw lidar DEM and the model go to the pipeline", async () => {
    const { svc, calls, masters, sources, modelPath } = await setup();
    await svc.propose(masters.id, { dryRun: true });
    const args = calls[0]!.args;
    expect(args.slice(0, 3)).toEqual(['-m', 'golfpipe', 'propose-bunkers']);
    expect(flag(args, '--ortho')).toBe(path.join(sources, 'ortho-orto-l2-2025.tif'));
    expect(flag(args, '--nir')).toBe(path.join(sources, 'ortho-orto-l2-2025.nir.tif'));
    // The model was trained on the raw lidar ground, not the edited DEM.
    expect(flag(args, '--dem')).toBe(path.join(sources, 'dem.tif'));
    expect(flag(args, '--model')).toBe(modelPath);
    expect(flag(args, '--surfaces')).toBe(path.join(sources, 'surfaces-orto-l2-2025.tif'));
});

test('every bunker drawn on the site goes along to be left out, the sibling course\'s too', async () => {
    const { svc, calls, masters } = await setup();
    await svc.propose(masters.id, { dryRun: true });
    const xs = calls[0]!.known.features.map((f) => Math.min(...f.geometry.coordinates[0]!.map((p) => p[0]!)) - E0);
    expect(xs.sort((a, b) => a - b)).toEqual([6, 606]);
});

test('each proposal comes with its hole, its outline for the map and what was left out', async () => {
    const { svc, masters } = await setup();
    const res = await svc.propose(masters.id);
    const byId = new Map(res.proposals.map((p) => [p.id, p]));
    expect(byId.get('bk-a')!.holeNumber).toBe(1);
    expect(byId.get('bk-far')!.holeId).toBeNull();
    expect(byId.get('bk-a')!.ring).toHaveLength(4);
    const [lon, lat] = byId.get('bk-a')!.lonLat[0]!;
    const want = ll(-11, 147);
    expect(lon).toBeCloseTo(want.lon, 6);
    expect(lat).toBeCloseTo(want.lat, 6);
    expect(res.left).toEqual({ drawn: 2, notCourse: 1, small: 4, skipped: 0 });
    expect(res.collection).toBe('orto-l2-2025');
    expect(res.predicted).toBe(true);
    expect((await svc.lastProposal(masters.id))!.proposals.map((p) => p.id)).toEqual(['bk-a', 'bk-far']);
});

test('a dry run keeps no proposal', async () => {
    const { svc, masters } = await setup();
    await svc.propose(masters.id, { dryRun: true });
    expect(await svc.lastProposal(masters.id)).toBeNull();
});

test('a skipped bunker is not offered again, even found a metre off under another id', async () => {
    const { svc, masters, setFound, sources } = await setup();
    // An irregular outline on raw SWEREF coordinates: its centre is kept where it is (no cancellation error).
    const blob: [number, number][] = [[0, 0], [4, -1], [7, 1], [6, 5], [2, 6], [-1, 3]].map(([x, y]) => [E0 + 1500 + x!, N0 + 1500 + y!]);
    setFound([feature('bk-a', square(-8, 150, 3)), feature('bk-far', blob)]);
    await svc.propose(masters.id);
    expect(await svc.skip(masters.id, { ids: ['bk-far'] })).toEqual({ skipped: 1, skippedNow: 1 });
    const kept = JSON.parse(await readFile(path.join(sources, 'bunker-proposals-skipped.json'), 'utf8')).skipped[0];
    expect(kept.x - (E0 + 1500)).toBeCloseTo(3.07, 1);
    expect(kept.y - (N0 + 1500)).toBeCloseTo(2.43, 1);
    setFound([feature('bk-a', square(-8, 150, 3)), feature('bk-far-2', blob.map(([x, y]) => [x + 1, y] as [number, number]))]);
    const again = await svc.propose(masters.id);
    expect(again.proposals.map((p) => p.id)).toEqual(['bk-a']);
    expect(again.left.skipped).toBe(1);
});

test('skipping an id the last proposal does not hold is refused', async () => {
    const { svc, masters } = await setup();
    await svc.propose(masters.id);
    await expect(svc.skip(masters.id, { ids: ['bk-nowhere'] })).rejects.toThrow(/Not in the last proposal/);
});

test('a photo without its NIR band says how to fetch it', async () => {
    const { svc, masters, dataDir } = await setup({ nir: false });
    await expect(svc.propose(masters.id)).rejects.toThrow(/NIR band is missing.*bun run bunkers -- "Masters" nir/);
    await rm(dataDir, { recursive: true, force: true });
});
