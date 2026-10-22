import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { sweref99tmToWgs84, wgs84ToSweref99tm, type FeatureGeometry } from './geo';

// Two holes running north, offsets in metres from a SWEREF origin near Vreta.
//   Hole 1, a dogleg right: the corner (aim point) at (0, 250), the green at (80, 330); a back tee box round
//   (0, 0) and a forward one round (0, 70).
//   Hole 2, a par 3: the green at (300, 160), one tee box round (300, 0).
// Each hole has the one tee the v1 import gave it ("default"), at the back.
const E0 = 530000, N0 = 6487000;
const ll = (dx: number, dy: number) => sweref99tmToWgs84(E0 + dx, N0 + dy);
const box = (cx: number, cy: number, w: number, h: number): FeatureGeometry => ({
    crs: 'EPSG:3006',
    rings: [{ points: [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]].map(([x, y]) => ({ x: E0 + x!, y: N0 + y! })) }],
});
const REST1 = Math.hypot(80, 80);
const CARD = [
    'Hål\t1\t2\tTot',
    'Par\t4\t3\t7',
    `Vit\t${(250 + REST1).toFixed(1)}\t160\t`,
    `Gul\t${(180 + REST1).toFixed(1)}\t152\t`,
    `Röd\t${(186.9 + REST1).toFixed(1)}\t120\t`,
].join('\n');

async function course() {
    const ctx = await createTestDb();
    const c = await ctx.coursesService.create({ name: 'Vreta' });
    const hole = async (number: number, green: [number, number], aims: [number, number][], tee: [number, number]) => {
        const h = await ctx.holesService.create({ courseId: c.id, number, par: 4 });
        const g = ll(...green);
        await ctx.greensService.create({ holeId: h.id, centerLat: g.lat, centerLon: g.lon });
        for (const a of aims) await ctx.aimPointsService.create({ holeId: h.id, ...ll(...a) });
        await ctx.teesService.create({ holeId: h.id, name: 'default', ...ll(...tee) });
        return h;
    };
    const h1 = await hole(1, [80, 330], [[0, 250]], [0, -5]);
    const h2 = await hole(2, [300, 160], [], [300, -2]);
    const shape = (holeId: string, geometry: FeatureGeometry) => ctx.courseFeaturesService.create({ courseId: c.id, holeId, type: 'tee', geometry });
    await shape(h1.id, box(0, 0, 10, 20));
    await shape(h1.id, box(0, 70, 10, 16));
    await shape(h2.id, box(300, 0, 10, 20));
    await ctx.teeSetsService.listByCourse(c.id); // the v1 tees' "default" set
    await ctx.scorecardService.accept(c.id, { text: CARD });
    const sets = Object.fromEntries((await ctx.teeSetsService.listByCourse(c.id)).map((s) => [s.name, s.id]));
    return { ctx, c, h1, h2, sets };
}

const xyOf = (lon: number, lat: number) => {
    const p = wgs84ToSweref99tm(lat, lon);
    return [p.x - E0, p.y - N0];
};

test('propose puts each set on the tee shape its length crosses, and says what has no shape', async () => {
    const { ctx, c, h1, h2, sets } = await course();
    const { spots, counts, sets: withLengths } = await ctx.teePlacementService.propose(c.id);
    expect(withLengths).toBe(3);
    const at = (holeId: string, set: string) => spots.find((s) => s.holeId === holeId && s.teeSetId === sets[set])!;

    const white1 = at(h1.id, 'White');
    expect(white1).toMatchObject({ outcome: 'place', holeNumber: 1, setName: 'White', teeId: null });
    const [x, y] = xyOf(...white1.at!);
    expect(Math.abs(x!)).toBeLessThan(0.05);
    expect(Math.abs(y!)).toBeLessThan(0.05);
    // Yellow on the forward box; Red too, near its back edge.
    expect(xyOf(...at(h1.id, 'Yellow').at!)[1]).toBeCloseTo(70, 0);
    expect(xyOf(...at(h1.id, 'Red').at!)[1]).toBeCloseTo(63.1, 0);
    expect(at(h2.id, 'Yellow').outcome).toBe('place');
    // Hole 2's Red tee box is not drawn: the spot on the line back, 120 m out, to draw one at.
    const red2 = at(h2.id, 'Red');
    expect(red2).toMatchObject({ outcome: 'missed', reason: 'No tee shape at 120 m' });
    expect(xyOf(...red2.at!)[1]).toBeCloseTo(40, 0);
    expect(red2.arc!.length).toBeGreaterThan(2);
    expect(counts).toEqual({ place: 5, ok: 0, off: 0, ambiguous: 0, missed: 1, skipped: 0 });
    // Propose wrote nothing.
    expect((await ctx.teesService.listByCourse(c.id)).length).toBe(2);
});

test('accept writes the new tees in set order; the rest only when asked for by key', async () => {
    const { ctx, c, h1, h2, sets } = await course();
    const res = await ctx.teePlacementService.accept(c.id);
    expect(res).toMatchObject({ placed: 5, moved: 0, dryRun: false });
    // In the course's set order (the v1 "default" set came first).
    expect((await ctx.teesService.listByHole(h1.id)).map((t) => t.name)).toEqual(['default', 'White', 'Yellow', 'Red']);

    // Placed: each is now at its length. The missed one waits.
    const again = await ctx.teePlacementService.propose(c.id);
    expect(again.counts).toMatchObject({ place: 0, ok: 5, missed: 1 });
    const red2 = again.spots.find((s) => s.holeId === h2.id && s.teeSetId === sets.Red)!;
    await expect(ctx.teePlacementService.accept(c.id, { keys: [again.spots.find((s) => s.outcome === 'ok')!.key] }))
        .rejects.toThrow('nothing to write');
    const placed = await ctx.teePlacementService.accept(c.id, { keys: [red2.key] });
    expect(placed).toMatchObject({ placed: 1, moved: 0 });
    expect((await ctx.teesService.listByHole(h2.id)).map((t) => t.name)).toEqual(['default', 'White', 'Yellow', 'Red']);
});

test('a tee moved away from its length is off, and moves back when asked for', async () => {
    const { ctx, c, h1, sets } = await course();
    await ctx.teePlacementService.accept(c.id);
    const white = (await ctx.teesService.listByHole(h1.id)).find((t) => t.teeSetId === sets.White)!;
    await ctx.teesService.update(white.id, white.version, ll(0, 10));
    const off = (await ctx.teePlacementService.propose(c.id)).spots.find((s) => s.teeId === white.id)!;
    expect(off).toMatchObject({ outcome: 'off', currentLengthM: Math.round((240 + REST1) * 10) / 10 });
    expect(off.moveM).toBeCloseTo(10, 0);
    expect(off.reason).toBe(`Is ${Math.round(240 + REST1)} m, the card says ${Math.round(250 + REST1)} m`);
    // A plain accept leaves it; by key it moves.
    expect((await ctx.teePlacementService.accept(c.id)).moved).toBe(0);
    expect(await ctx.teePlacementService.accept(c.id, { keys: [off.key], dryRun: true })).toMatchObject({ moved: 1, dryRun: true });
    await ctx.teePlacementService.accept(c.id, { keys: [off.key] });
    const moved = (await ctx.teesService.listByHole(h1.id)).find((t) => t.id === white.id)!;
    expect(Math.abs(xyOf(moved.lon, moved.lat)[1]!)).toBeLessThan(0.05);
});

test('a hole without a green centre, or a length shorter than the line from the corner, gets no tee', async () => {
    const { ctx, c, sets } = await course();
    const h3 = await ctx.holesService.create({ courseId: c.id, number: 3, par: 4 });
    await ctx.scorecardService.accept(c.id, { text: ['Hål\t1\t3', `Vit\t50\t300`].join('\n') });
    const spots = (await ctx.teePlacementService.propose(c.id)).spots.filter((s) => s.teeSetId === sets.White);
    expect(spots.find((s) => s.holeNumber === 1)).toMatchObject({ outcome: 'too-short', at: null });
    expect(spots.find((s) => s.holeId === h3.id)).toMatchObject({ outcome: 'no-green', reason: 'No green centre' });
});
