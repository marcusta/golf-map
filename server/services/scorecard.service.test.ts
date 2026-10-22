import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { sweref99tmToWgs84 } from './geo';

// Two straight holes north from their tees near Vreta: hole 1 to a green 360 m up, hole 2 to one 160 m up.
const E0 = 530000, N0 = 6487000;
const ll = (dx: number, dy: number) => sweref99tmToWgs84(E0 + dx, N0 + dy);

async function course() {
    const ctx = await createTestDb();
    const c = await ctx.coursesService.create({ name: 'Vreta' });
    const h1 = await ctx.holesService.create({ courseId: c.id, number: 1, par: 5 });
    const h2 = await ctx.holesService.create({ courseId: c.id, number: 2, par: 4 });
    for (const [h, x, len] of [[h1, 0, 360], [h2, 300, 160]] as const) {
        const g = ll(x, len);
        await ctx.greensService.create({ holeId: h.id, centerLat: g.lat, centerLon: g.lon });
    }
    const white = await ctx.teeSetsService.create({ courseId: c.id, name: 'White', color: 'white' });
    return { ctx, c, h1, h2, white };
}

const CARD = [
    'Hål\t1\t2\tTot',
    'Par\t4\t3\t7',
    'Hcp\t1\t2\t',
    'Vit 61\t360\t160\t520',
    'Gul 57\t330\t150\t480',
    'Vit herr 70,1/128',
    'Gul dam 72,4/131',
].join('\n');

test('propose reads the card and matches its sets to the course: by colour, else a new set', async () => {
    const { ctx, c, h1, white } = await course();
    const p = await ctx.scorecardService.propose(c.id, { text: CARD });
    expect(p.unit).toBe('m');
    expect(p.sets.map((s) => [s.label, s.teeSetId, s.name, s.matchedBy, s.totalM])).toEqual([
        ['Vit 61', white.id, 'White', 'colour', 520],
        ['Gul 57', null, 'Yellow', 'new', 480],
    ]);
    expect(p.holes[0]).toEqual({ number: 1, holeId: h1.id, par: 4, parWas: 5, strokeIndex: 1, strokeIndexWas: null });
    expect(p.counts).toEqual({ holes: 2, parChanged: 2, indexChanged: 2, newSets: 1, lengthsChanged: 4, ratingsChanged: 2 });
    expect(p.warnings).toEqual([]);
    // Nothing written.
    expect((await ctx.scorecardService.get(c.id)).sets).toEqual([]);
    expect((await ctx.holesService.get(h1.id)).par).toBe(5);
});

test('accept writes par, index, lengths and ratings, and makes the new sets', async () => {
    const { ctx, c, h1, h2, white } = await course();
    expect(await ctx.scorecardService.accept(c.id, { text: CARD, dryRun: true })).toEqual({
        dryRun: true, setsCreated: 1, lengthsWritten: 4, holesChanged: 2, ratingsWritten: 2,
    });
    expect((await ctx.scorecardService.get(c.id)).sets).toEqual([]);

    await ctx.scorecardService.accept(c.id, { text: CARD });
    expect(await ctx.holesService.get(h1.id)).toMatchObject({ par: 4, strokeIndex: 1 });
    expect(await ctx.holesService.get(h2.id)).toMatchObject({ par: 3, strokeIndex: 2 });
    const sets = await ctx.teeSetsService.listByCourse(c.id);
    expect(sets.map((s) => [s.name, s.color, s.ratingMen, s.slopeMen, s.ratingWomen, s.slopeWomen])).toEqual([
        ['White', 'white', 70.1, 128, null, null],
        ['Yellow', 'yellow', null, null, 72.4, 131],
    ]);
    // GSPro picks the new set up by its name.
    expect(sets[1]!.gsproTee).toBe('Yellow');
    const stored = await ctx.scorecardService.get(c.id);
    expect(stored.sets.map((s) => [s.teeSetId, s.totalM, s.lengths])).toEqual([
        [white.id, 520, [{ holeNumber: 1, lengthM: 360 }, { holeNumber: 2, lengthM: 160 }]],
        [sets[1]!.id, 480, [{ holeNumber: 1, lengthM: 330 }, { holeNumber: 2, lengthM: 150 }]],
    ]);
    // The same card again changes nothing; a new length replaces the stored one.
    expect((await ctx.scorecardService.propose(c.id, { text: CARD })).counts)
        .toEqual({ holes: 2, parChanged: 0, indexChanged: 0, newSets: 0, lengthsChanged: 0, ratingsChanged: 0 });
    await ctx.scorecardService.accept(c.id, { text: 'Hål 1 2\nVit 365 160' });
    expect((await ctx.scorecardService.get(c.id)).sets[0]!.lengths[0]).toEqual({ holeNumber: 1, lengthM: 365 });
});

test('a card naming its tees by number goes to the set whose tees add up to it; the map overrides', async () => {
    const { ctx, c, h1, h2, white } = await course();
    // White's tees at the back, 360 + 160 m.
    await ctx.teesService.create({ holeId: h1.id, teeSetId: white.id, ...ll(0, 0) });
    await ctx.teesService.create({ holeId: h2.id, teeSetId: white.id, ...ll(300, 0) });
    const card = 'Hole 1 2 Total\n52 358 161 519\n44 300 140 440\nyards';
    const p = await ctx.scorecardService.propose(c.id, { text: card, unit: 'm' });
    expect(p.sets.map((s) => [s.label, s.teeSetId, s.matchedBy, s.name])).toEqual([
        ['52', white.id, 'length', 'White'],
        ['44', null, 'new', '44'],
    ]);
    const mapped = await ctx.scorecardService.propose(c.id, { text: card, unit: 'm', map: [{ label: '52', teeSetId: 'new' }, { label: '44', teeSetId: white.id }] });
    expect(mapped.sets.map((s) => [s.label, s.teeSetId, s.matchedBy])).toEqual([['52', null, 'map'], ['44', white.id, 'map']]);
    // Yards from the text when no unit is given.
    expect((await ctx.scorecardService.propose(c.id, { text: card })).unit).toBe('yd');
});

test('holes the course lacks are left out with a warning; two card sets onto one set is refused', async () => {
    const { ctx, c } = await course();
    const p = await ctx.scorecardService.propose(c.id, { text: 'Hål 1 2 3\nVit 360 160 400\nVita tees 350 150 390' });
    expect(p.warnings).toEqual([
        'Not on the course, left out: hole 3',
        'Vita tees: White is already another of the card\'s sets; it becomes a new set',
    ]);
    expect(p.sets.map((s) => [s.teeSetId !== null, s.name, s.holes])).toEqual([[true, 'White', 2], [false, 'Vita tees', 2]]);
});
