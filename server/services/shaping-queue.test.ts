// The shaping queue's files: requests, the lease, batches and slices (docs/shaping-queue.md).
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { test, expect, afterEach } from 'bun:test';
import { ShapingQueue, sliceFor, batchFlags, parseRegion, type NewQueueRequest, type QueueRequest } from './shaping-queue';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function queue(opts: ConstructorParameters<typeof ShapingQueue>[1] = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'shaping-queue-'));
    dirs.push(dir);
    return new ShapingQueue(dir, opts);
}

const FLAGS = { dryRun: false, paths: false, save: false, skipUnity: false };
const req = (over: Partial<NewQueueRequest> = {}): NewQueueRequest =>
    ({ courseId: 'omberg', note: null, region: null, featureIds: [], flags: FLAGS, ...over });

test('one lease at a time; released, the next caller gets it', async () => {
    const q = await queue();
    const a = await q.tryLease();
    expect(a).not.toBeNull();
    expect(await q.tryLease()).toBeNull();
    expect((await q.holder())!.live).toBe(true);
    await q.release(a!);
    expect(await q.holder()).toBeNull();
    expect(await q.tryLease()).not.toBeNull();
});

test('a stale lease is taken over and the requests it left running are queued again', async () => {
    let holderAlive = true;
    const q = await queue({ alive: () => holderAlive });
    const r = await q.submit(req({ note: 'bd-1' }));
    const dead = (await q.tryLease())!;
    const batch = await q.takeBatch(dead);
    expect(batch!.requests.map(x => x.id)).toEqual([r.id]);
    expect((await q.get(r.id))!.state).toBe('running');

    // Its process is gone: the next caller takes over and the orphan is queued again.
    holderAlive = false;
    const next = await q.tryLease();
    holderAlive = true;
    expect(next).not.toBeNull();
    expect(await q.beat(dead)).toBe(false);
    expect((await q.get(r.id))!.state).toBe('queued');
    const again = await q.takeBatch(next!);
    expect(again!.requests.map(x => x.id)).toEqual([r.id]);
});

test('a lease with no heartbeat for staleMs is stale even with its process alive', async () => {
    const q = await queue({ staleMs: 30 });
    expect(await q.tryLease()).not.toBeNull();
    expect(await q.tryLease()).toBeNull();
    await Bun.sleep(60);
    expect(await q.tryLease()).not.toBeNull();
});

test('a batch is every queued request of one course with the same dry run; the preferred course goes first', async () => {
    const q = await queue();
    const a1 = await q.submit(req({ courseId: 'vreta', note: 'a1' }));
    await Bun.sleep(2);
    const b1 = await q.submit(req({ courseId: 'omberg', note: 'b1' }));
    const a2 = await q.submit(req({ courseId: 'vreta', note: 'a2' }));
    const a3 = await q.submit(req({ courseId: 'vreta', note: 'a3 dry', flags: { ...FLAGS, dryRun: true } }));
    const lease = (await q.tryLease())!;

    const first = await q.takeBatch(lease, 'omberg');
    expect(first!.requests.map(r => r.id)).toEqual([b1.id]);
    const second = await q.takeBatch(lease);
    expect(second!.requests.map(r => r.id)).toEqual([a1.id, a2.id]);
    expect(second!.runId).not.toBe(first!.runId);
    expect((await q.get(a2.id))!).toMatchObject({ state: 'running', runId: second!.runId });
    await q.finish(second!.requests, true, null);
    expect((await q.get(a1.id))!).toMatchObject({ state: 'done', ok: true });
    const third = await q.takeBatch(lease);
    expect(third!.requests.map(r => r.id)).toEqual([a3.id]);
    expect(await q.takeBatch(lease)).toBeNull();
});

test('runs are written and read back; the latest run of a course', async () => {
    const q = await queue();
    const run = { id: 'r1', courseId: 'vreta', requestIds: ['x'], startedAt: '2026-10-18T10:00:00Z', finishedAt: null, job: { step: 'Blender sync' }, result: null, error: null, slices: {} };
    await q.writeRun(run);
    await q.writeRun({ ...run, id: 'r2', startedAt: '2026-10-18T11:00:00Z' });
    expect((await q.readRun('r1'))!.job).toEqual({ step: 'Blender sync' });
    expect((await q.latestRun('vreta'))!.id).toBe('r2');
    expect(await q.latestRun('omberg')).toBeNull();
    await expect(q.readRun('../lease')).rejects.toThrow(/Not a queue id/);
});

const place = (object: string, bounds: number[], featureIds: string[] = []) =>
    ({ object, objects: [object], featureIds, bounds: { epsg3006: bounds } });
const asReq = (id: string, over: Partial<NewQueueRequest>): QueueRequest =>
    ({ id, ...req(over), createdAt: '', pid: 1, state: 'running', runId: 'r', ok: null, error: null });

test('a slice: places in the region (grown 5 m) or naming its features, their objects, warnings that concern it, overlaps', () => {
    const result = {
        changedObjects: ['Spline_tee_7', 'Spline_hall_12_Rock_-_Mesh', 'Spline_road_3'],
        places: [
            place('Spline_tee_7', [1000, 2000, 1010, 2010]),
            place('Spline_hall_12_Rock_-_Mesh', [5000, 5000, 5020, 5020]),
            place('Spline_road_3', [9000, 9000, 9100, 9010], ['feat-road']),
        ],
        warnings: ['1 seam gap under 1 mm', 'Spline_tee_7: steep edge', 'Spline_road_3: T-junction'],
    };
    const tee = asReq('a', { note: 'bd-7 tee', region: [1012, 2012, 1020, 2020] });  // 2 m off the tee's box
    const road = asReq('b', { note: 'bd-9 road', featureIds: ['feat-road'] });
    const near = asReq('c', { note: 'bd-8 bank', region: [1015, 2015, 1030, 2030] });
    const all = asReq('d', { note: 'whole' });
    const batch = [tee, road, near, all];

    const s = sliceFor(tee, result, batch);
    expect(s.whole).toBe(false);
    expect(s.changedObjects).toEqual(['Spline_tee_7']);
    expect(s.warnings).toEqual(['1 seam gap under 1 mm', 'Spline_tee_7: steep edge']);
    expect(s.overlaps).toEqual(['also changed here in this run: bd-8 bank']);

    expect(sliceFor(road, result, batch).changedObjects).toEqual(['Spline_road_3']);
    expect(sliceFor(road, result, batch).warnings).toEqual(['1 seam gap under 1 mm', 'Spline_road_3: T-junction']);
    const whole = sliceFor(all, result, batch);
    expect(whole.whole).toBe(true);
    expect(whole.changedObjects).toHaveLength(3);
});

test('batch flags: paths and save when any asks, skipUnity only when all do; regions parse', () => {
    const a = asReq('a', { flags: { ...FLAGS, paths: true, skipUnity: true } });
    const b = asReq('b', { flags: { ...FLAGS, save: true } });
    expect(batchFlags([a, b])).toEqual({ dryRun: false, paths: true, save: true, skipUnity: false });
    expect(batchFlags([a])).toMatchObject({ skipUnity: true });
    expect(parseRegion('10,20,5,40')).toEqual([5, 20, 10, 40]);
    expect(parseRegion('1,2,3')).toBeNull();
});
