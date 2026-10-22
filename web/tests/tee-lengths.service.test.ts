import { test, expect } from 'bun:test';
import { TeeLengthsService, type TeeLengthsDeps } from '../src/furniture/tee-lengths.service';
import type { ScorecardApi, ScorecardProposal } from '../../shared/api/scorecard.gen';
import type { TeePlacementApi, TeePlacementProposal, TeeSpot } from '../../shared/api/tee-placement.gen';

// ── Fake clients: what the panel sends, and canned answers ────────────────

const spot = (key: string, outcome: TeeSpot['outcome'], extra: Partial<TeeSpot> = {}): TeeSpot => ({
    key, holeId: key.split(':')[0]!, holeNumber: Number(key.slice(1, 2)), teeSetId: key.split(':')[1]!, setName: 'Yellow', color: 'yellow',
    lengthM: 300, outcome, teeId: null, currentLengthM: null, at: [15.5, 58.5], from: null, moveM: null, shapeId: 's', arc: null, reason: null, ...extra,
});

const TEES: TeePlacementProposal = {
    courseId: 'c1', sets: 2,
    spots: [
        spot('h1:yellow', 'place'),
        spot('h1:white', 'ok', { at: null }),
        spot('h2:yellow', 'off', { teeId: 't2', from: [15.49, 58.49], moveM: 4.5, arc: [[15.5, 58.5], [15.501, 58.5]], reason: 'Is 299 m, the card says 294 m' }),
        spot('h3:yellow', 'missed', { shapeId: null, reason: 'No tee shape at 300 m' }),
        spot('h4:yellow', 'too-short', { at: null, reason: 'short' }),
    ],
    counts: { place: 1, ok: 1, off: 1, ambiguous: 0, missed: 1, skipped: 1 },
};

const CARD: ScorecardProposal = {
    courseId: 'c1', unit: 'm', warnings: ['Hole 2: par 9?'],
    holes: [{ number: 1, holeId: 'h1', par: 4, parWas: 5, strokeIndex: 1, strokeIndexWas: null }],
    sets: [{
        label: 'Gul 57', teeSetId: null, name: 'Yellow', color: 'yellow', matchedBy: 'new', totalM: 300, holes: 1, lengthsChanged: 1,
        ratingMen: null, slopeMen: null, ratingWomen: null, slopeWomen: null, ratingsChanged: false,
    }],
    counts: { holes: 1, parChanged: 1, indexChanged: 1, newSets: 1, lengthsChanged: 1, ratingsChanged: 0 },
};

function fakes() {
    const sent: { propose: unknown[]; accept: unknown[]; teesAccept: unknown[]; written: unknown[] } = { propose: [], accept: [], teesAccept: [], written: [] };
    const scorecard: ScorecardApi = {
        async get() { return { courseId: 'c1', sets: [] }; },
        async propose(input) { sent.propose.push(input); return structuredClone(CARD); },
        async accept(input) { sent.accept.push(input); return { dryRun: false, setsCreated: 1, lengthsWritten: 18, holesChanged: 1, ratingsWritten: 0 }; },
    };
    const teePlacement: TeePlacementApi = {
        async propose() { return structuredClone(TEES); },
        async accept(input) { sent.teesAccept.push(input); return { placed: 2, moved: 1, dryRun: false, spots: [] }; },
    };
    const deps: TeeLengthsDeps = { scorecard, teePlacement, async written(what, courseId) { sent.written.push({ what, courseId }); } };
    return { svc: new TeeLengthsService(deps), sent };
}

test('the scorecard step: read, send a set elsewhere, accept and go on to the tees', async () => {
    const { svc, sent } = fakes();
    svc.open('c1', 'scorecard');
    svc.text.set('Hål 1\nGul 57 300');
    svc.unit.set('yd');
    await svc.read();
    expect(sent.propose[0]).toEqual({ courseId: 'c1', text: 'Hål 1\nGul 57 300', unit: 'yd' });
    expect(svc.cardSummary()).toBe('1 holes · 1 lengths · 1 par/index');

    await svc.mapSet('Gul 57', 'set-yellow');
    expect(sent.propose[1]).toMatchObject({ map: [{ label: 'Gul 57', teeSetId: 'set-yellow' }] });

    await svc.save();
    expect(sent.accept[0]).toMatchObject({ courseId: 'c1', unit: 'yd', map: [{ label: 'Gul 57', teeSetId: 'set-yellow' }] });
    // The sets and the holes are re-read; the tees step opens with the new tees taken.
    expect(sent.written[0]).toEqual({ what: { sets: true, tees: false, holes: true }, courseId: 'c1' });
    expect(svc.step.peek()).toBe('tees');
    expect(svc.card.peek()).toBeNull();
    expect(svc.text.peek()).toBe('');
    expect([...svc.taken.peek()]).toEqual(['h1:yellow']);
    expect(svc.done.peek()).toBe('Saved: 18 lengths · 1 new sets · 1 holes');
});

test('the tees step: the new ones taken, a click takes one to check, accept sends exactly those', async () => {
    const { svc, sent } = fakes();
    svc.open('c1', 'tees');
    await svc.find();
    expect(svc.teesSummary()).toBe('1 to write · 1 ok · 2 to check · 1 skipped');
    expect(svc.teesDetail()).toBe('2 Yellow: Is 299 m, the card says 294 m\n3 Yellow: No tee shape at 300 m\n4 Yellow: short');

    // ok and skipped spots cannot be taken.
    svc.toggle('h1:white');
    svc.toggle('h4:yellow');
    svc.toggle('h2:yellow');
    expect([...svc.taken.peek()].sort()).toEqual(['h1:yellow', 'h2:yellow']);
    svc.toggle('h1:yellow');
    expect(svc.teesSummary()).toBe('1 to write · 1 ok · 1 to check · 1 skipped');

    // On the map: the off tee's circle, its move and its spot (taken); the missed spot hollow.
    const features = svc.layer().features.map((f) => [f.properties.key, f.properties.kind, f.properties.taken, f.properties.look]);
    expect(features).toEqual([
        ['h1:yellow', 'spot', false, false],
        ['h2:yellow', 'arc', true, true],
        ['h2:yellow', 'move', true, true],
        ['h2:yellow', 'spot', true, true],
        ['h3:yellow', 'spot', false, true],
    ]);
    // A click 4 px from a spot hits it, 20 px misses.
    expect(svc.spotAt(() => 4)).toBe('h1:yellow');
    expect(svc.spotAt(() => 20)).toBeNull();

    await svc.place();
    expect(sent.teesAccept[0]).toEqual({ courseId: 'c1', keys: ['h2:yellow'] });
    expect(sent.written[0]).toEqual({ what: { sets: true, tees: true, holes: false }, courseId: 'c1' });
    expect(svc.done.peek()).toBe('2 placed · 1 moved');
});

test('closing drops what is not accepted', async () => {
    const { svc } = fakes();
    svc.open('c1', 'scorecard');
    svc.text.set('x');
    await svc.read();
    svc.close();
    expect(svc.courseId.peek()).toBeNull();
    expect(svc.card.peek()).toBeNull();
    expect(svc.taken.peek().size).toBe(0);
});
