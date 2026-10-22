import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { sweref99tmToWgs84, type FeatureGeometry } from './geo';

// A site with two courses side by side, holes running north from their tees:
// course A's holes 1 (x 0) and 2 (x 200), course B's hole 1 (x 600). Offsets in
// metres from a SWEREF origin near Landeryd.
const E0 = 541200, N0 = 6468000;
const ll = (dx: number, dy: number) => sweref99tmToWgs84(E0 + dx, N0 + dy);
const rect = (x0: number, y0: number, x1: number, y1: number): FeatureGeometry => ({
    crs: 'EPSG:3006',
    rings: [{ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x: E0 + x!, y: N0 + y! })) }],
});
const around = (x: number, y: number, r: number) => rect(x - r, y - r, x + r, y + r);

async function site() {
    const ctx = await createTestDb();
    await ctx.sitesService.create({ id: 'site-l', name: 'Landeryd' });
    const a = await ctx.coursesService.create({ name: 'Masters', siteId: 'site-l' });
    const b = await ctx.coursesService.create({ name: 'Classic', siteId: 'site-l' });
    const hole = async (courseId: string, number: number, x: number) => {
        const h = await ctx.holesService.create({ courseId, number, par: 4 });
        const tee = ll(x, 0), green = ll(x, 300);
        await ctx.teesService.create({ holeId: h.id, name: 'Yellow', lat: tee.lat, lon: tee.lon });
        await ctx.greensService.create({ holeId: h.id, centerLat: green.lat, centerLon: green.lon });
        return h;
    };
    const a1 = await hole(a.id, 1, 0), a2 = await hole(a.id, 2, 200), b1 = await hole(b.id, 1, 600);
    // A drawing group is a hole row without furniture: never a hole to assign to.
    await ctx.holesService.create({ courseId: a.id, number: 0, par: 0, drawingGroupName: 'Range' });
    const shape = (type: string, geometry: FeatureGeometry, extra: { holeId?: string; layer?: string } = {}) =>
        ctx.courseFeaturesService.create({ courseId: a.id, type, geometry, ...extra });
    const f = {
        green: await shape('green', around(0, 300, 15)),
        tee: await shape('tee', around(200, 0, 5)),
        fairway: await shape('fairway', rect(-15, 50, 15, 250)),
        onClassic: await shape('bunker', around(610, 150, 5)),
        between: await shape('semi_rough', rect(-20, 100, 220, 200)),
        // An ordinary rough goes into Roughs, even lying on hole 1's play line.
        rough: await shape('rough', rect(-40, 100, -20, 200)),
        // A rough island in hole 2's semi: onto hole 2, not Roughs.
        semi2: await shape('semi_rough', rect(170, 40, 230, 260)),
        island: await shape('rough', rect(180, 150, 190, 160)),
        // Drawn after the fairway and over it: stays over it on the hole.
        semiOverFairway: await shape('semi_rough', rect(-15, 120, 15, 140)),
        practice: await shape('green', around(1500, 1500, 10)),
        farAway: await shape('bunker', around(1500, 1500, 30)),
        alreadyOnHole2: await shape('fairway', rect(185, 50, 215, 250), { holeId: a2.id }),
        inRoughs: await shape('rough', rect(-30, 0, 30, 300), { layer: 'roughs' }),
    };
    // A new shape takes its type's slot; the drawer then raised the semi over the fairway.
    const others = (await ctx.courseFeaturesService.listByCourse(a.id))
        .filter((x) => x.holeId === null && x.layer === null).sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id)
        .filter((id) => id !== f.semiOverFairway.id);
    others.splice(others.indexOf(f.fairway.id) + 1, 0, f.semiOverFairway.id);
    await ctx.courseFeaturesService.reorder(a.id, null, others);
    return { ctx, a, b, a1, a2, b1, f };
}

test('propose puts greens, tees and play-line shapes on their own holes and leaves the rest in Others', async () => {
    const { ctx, a, a1, a2, b1, f } = await site();
    const result = await ctx.holeAssignmentService.propose(a.id);
    const by = (id: string) => result.proposals.find((p) => p.featureId === id);

    expect(by(f.green.id)).toMatchObject({ outcome: 'assign', holeId: a1.id, holeNumber: 1 });
    expect(by(f.tee.id)).toMatchObject({ outcome: 'assign', holeId: a2.id, holeNumber: 2 });
    expect(by(f.fairway.id)).toMatchObject({ outcome: 'assign', holeId: a1.id });
    // On the sibling course's hole: named, never put on this course.
    expect(by(f.onClassic.id)).toMatchObject({ outcome: 'other-course', holeId: b1.id, courseName: 'Classic', holeNumber: 1 });
    expect(by(f.between.id)?.outcome).toBe('ambiguous');
    expect(by(f.practice.id)).toMatchObject({ outcome: 'none', reason: "holds no hole's green centre" });
    expect(by(f.farAway.id)?.outcome).toBe('none');
    // Shapes already on a hole or in the Roughs group are the drawer's call.
    expect(by(f.alreadyOnHole2.id)).toBeUndefined();
    expect(by(f.inRoughs.id)).toBeUndefined();
    expect(by(f.rough.id)).toMatchObject({ outcome: 'roughs', holeId: null });
    expect(by(f.island.id)).toMatchObject({ outcome: 'assign', holeId: a2.id });
    expect(result.counts).toEqual({ assign: 6, roughs: 1, others: 0, otherCourse: 1, ambiguous: 1, none: 2 });
    // Play lines for the map: every real hole on the site, back tee -> green, in lon/lat.
    expect(result.lines.map((l) => l.holeId).sort()).toEqual([a1.id, a2.id, b1.id].sort());
    expect(result.lines.find((l) => l.holeId === a1.id)!.line).toHaveLength(2);
});

test('accept writes only the proposed holes (all, or the ones named), and a dry run writes nothing', async () => {
    const { ctx, a, a1, a2, f } = await site();
    const holeOf = async (id: string) => (await ctx.courseFeaturesService.findById(id)).holeId;

    const dry = await ctx.holeAssignmentService.accept(a.id, { dryRun: true });
    expect(dry).toMatchObject({ assigned: 6, roughs: 1, dryRun: true });
    expect(await holeOf(f.green.id)).toBeNull();

    // Named: only the green; a shape not proposed onto a hole is ignored.
    const one = await ctx.holeAssignmentService.accept(a.id, { featureIds: [f.green.id, f.onClassic.id] });
    expect(one.assigned).toBe(1);
    expect(await holeOf(f.green.id)).toBe(a1.id);
    expect(await holeOf(f.fairway.id)).toBeNull();

    const rest = await ctx.holeAssignmentService.accept(a.id);
    expect(rest.holes.map((h) => h.holeNumber).sort()).toEqual([1, 1, 2, 2, 2]);
    expect(rest.roughs).toBe(1);
    const rough = await ctx.courseFeaturesService.findById(f.rough.id);
    expect(rough).toMatchObject({ holeId: null, layer: 'roughs' });
    // Hole 1 bottom -> top: the green it already had, then the moved shapes in their Others order
    // (a single move's type-rank slot would put the semi under the fairway).
    const hole1 = (await ctx.courseFeaturesService.listByHole(a1.id)).sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id);
    expect(hole1).toEqual([f.green.id, f.fairway.id, f.semiOverFairway.id]);
    // The island sits above its semi.
    const hole2 = (await ctx.courseFeaturesService.listByHole(a2.id)).sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id);
    expect(hole2.indexOf(f.island.id)).toBeGreaterThan(hole2.indexOf(f.semi2.id));
    expect(await holeOf(f.fairway.id)).toBe(a1.id);
    expect(await holeOf(f.tee.id)).toBe(a2.id);
    expect(await holeOf(f.onClassic.id)).toBeNull();
    expect(await holeOf(f.between.id)).toBeNull();
    // Nothing left to put on a hole.
    expect((await ctx.holeAssignmentService.propose(a.id)).counts.assign).toBe(0);
});

test('a rough island already in Roughs is proposed onto its hole; a plain rough in Roughs is left there', async () => {
    const { ctx, a, a2, f } = await site();
    await ctx.holeAssignmentService.accept(a.id);
    // Both in Roughs, as a blanket "every rough to Roughs" would leave them.
    const island = await ctx.courseFeaturesService.findById(f.island.id);
    await ctx.courseFeaturesService.update(island.id, island.version, { layer: 'roughs' });
    const again = await ctx.holeAssignmentService.propose(a.id);
    expect(again.proposals.find((p) => p.featureId === f.island.id)).toMatchObject({ outcome: 'assign', holeId: a2.id });
    expect(again.proposals.find((p) => p.featureId === f.rough.id)).toBeUndefined();
    await ctx.holeAssignmentService.accept(a.id);
    expect(await ctx.courseFeaturesService.findById(f.island.id)).toMatchObject({ holeId: a2.id, layer: null });
});

test('a rough island in Roughs off this course\'s holes goes back to Others, above the semi round it', async () => {
    const { ctx, a, f } = await site();
    const semi = await ctx.courseFeaturesService.create({ courseId: a.id, type: 'semi_rough', geometry: rect(580, 100, 640, 200) });
    const island = await ctx.courseFeaturesService.create({ courseId: a.id, type: 'rough', geometry: rect(605, 145, 615, 155), layer: 'roughs' });
    const p = (await ctx.holeAssignmentService.propose(a.id)).proposals.find((x) => x.featureId === island.id);
    expect(p).toMatchObject({ outcome: 'others', island: true });
    await ctx.holeAssignmentService.accept(a.id, { featureIds: [island.id] });
    const others = (await ctx.courseFeaturesService.listByCourse(a.id))
        .filter((x) => x.holeId === null && x.layer === null).sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id);
    expect(others.indexOf(island.id)).toBeGreaterThan(others.indexOf(semi.id));
    expect(others.at(-1)).toBe(island.id);
    void f;
});
