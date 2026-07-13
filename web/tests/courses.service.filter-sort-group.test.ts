import { test, expect } from 'bun:test';
import { CoursesService } from '../src/courses/courses.service';
import type { CoursesApi, CourseSummary } from '../../shared/api/courses.gen';

// CoursesService.groups — filter (query) → sort (sortBy) → group (groupBy).
// Seeds the store directly (bypassing load()/the network) since these are
// pure client-side derivations over whatever is already in the EntityStore.

function summary(overrides: Partial<CourseSummary> & { id: string; name: string }): CourseSummary {
    return {
        status: 'draft',
        revision: 0,
        siteId: null,
        siteName: null,
        homeLat: null,
        homeLon: null,
        holeCount: 18,
        updatedAt: '2026-07-04T00:00:00Z',
        parTotal: 72,
        lengthM: 5800,
        mappedHoleCount: 0,
        routing: [],
        ...overrides,
    };
}

/** A CoursesApi that never resolves — these tests never call load(). */
function unusedApi(): CoursesApi {
    const reject = () => Promise.reject(new Error('not under test'));
    return { list: reject, get: reject, create: reject, update: reject, remove: reject, publish: reject };
}

function svcWith(items: CourseSummary[]): CoursesService {
    const svc = new CoursesService(unusedApi());
    svc.store.set(items, items.length);
    return svc;
}

function names(svc: CoursesService): string[] {
    return svc.groups.get().flatMap(g => g.courses.map(c => c.name));
}

// ── query filter ─────────────────────────────────────────────────────────

test('query filters by name, case-insensitive', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Landeryd Masters' }),
        summary({ id: 'c2', name: 'Örebro City' }),
    ]);

    svc.query.set('landeryd');
    expect(names(svc)).toEqual(['Landeryd Masters']);

    svc.query.set('MASTERS');
    expect(names(svc)).toEqual(['Landeryd Masters']);
});

test('query filters by siteName, case-insensitive', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Course A', siteName: 'Bokskogens GK' }),
        summary({ id: 'c2', name: 'Course B', siteName: 'Falsterbo GK' }),
    ]);

    svc.query.set('bokskogens');
    expect(names(svc)).toEqual(['Course A']);
});

test('blank/whitespace query matches everything', () => {
    const svc = svcWith([summary({ id: 'c1', name: 'A' }), summary({ id: 'c2', name: 'B' })]);

    svc.query.set('   ');
    expect(names(svc)).toEqual(['A', 'B']);
});

test('query with no matches yields no rows', () => {
    const svc = svcWith([summary({ id: 'c1', name: 'A' })]);

    svc.query.set('zzz-no-match');
    expect(svc.groups.get().every(g => g.courses.length === 0)).toBe(true);
});

// ── sortBy ────────────────────────────────────────────────────────────────

test('sortBy name sorts alphabetically', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Zebra' }),
        summary({ id: 'c2', name: 'Alpha' }),
        summary({ id: 'c3', name: 'Mike' }),
    ]);
    svc.groupBy.set('none');

    svc.setSortBy('name');
    expect(names(svc)).toEqual(['Alpha', 'Mike', 'Zebra']);
});

test('sortBy updated sorts most-recent first', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Oldest', updatedAt: '2026-01-01T00:00:00Z' }),
        summary({ id: 'c2', name: 'Newest', updatedAt: '2026-07-01T00:00:00Z' }),
        summary({ id: 'c3', name: 'Middle', updatedAt: '2026-04-01T00:00:00Z' }),
    ]);
    svc.groupBy.set('none');

    svc.setSortBy('updated');
    expect(names(svc)).toEqual(['Newest', 'Middle', 'Oldest']);
});

test('sortBy progress sorts highest mapped fraction first', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Half', holeCount: 10, mappedHoleCount: 5 }),
        summary({ id: 'c2', name: 'Full', holeCount: 10, mappedHoleCount: 10 }),
        summary({ id: 'c3', name: 'None', holeCount: 10, mappedHoleCount: 0 }),
    ]);
    svc.groupBy.set('none');

    svc.setSortBy('progress');
    expect(names(svc)).toEqual(['Full', 'Half', 'None']);
});

test('sortBy progress treats a 0-hole course as 0 progress (no divide-by-zero)', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Zero holes', holeCount: 0, mappedHoleCount: 0 }),
        summary({ id: 'c2', name: 'Some progress', holeCount: 10, mappedHoleCount: 1 }),
    ]);
    svc.groupBy.set('none');

    svc.setSortBy('progress');
    expect(names(svc)).toEqual(['Some progress', 'Zero holes']);
});

test('setSortBy persists the choice to localStorage', () => {
    localStorage.removeItem('courses.sortBy');
    const svc = svcWith([]);

    svc.setSortBy('updated');
    expect(localStorage.getItem('courses.sortBy')).toBe('updated');
});

// ── groupBy ───────────────────────────────────────────────────────────────

test('groupBy site buckets by siteName, alphabetical, "Unassigned" last', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'A1', siteName: 'Zeta GK' }),
        summary({ id: 'c2', name: 'A2', siteName: 'Alpha GK' }),
        summary({ id: 'c3', name: 'A3', siteName: null }),
        summary({ id: 'c4', name: 'A4', siteName: 'Alpha GK' }),
    ]);

    svc.setGroupBy('site');
    const groups = svc.groups.get();
    expect(groups.map(g => g.label)).toEqual(['Alpha GK', 'Zeta GK', 'Unassigned']);
    expect(groups[0]!.courses.map(c => c.id).sort()).toEqual(['c2', 'c4']);
    expect(groups[2]!.courses.map(c => c.id)).toEqual(['c3']);
});

test('groupBy status buckets Published vs Draft', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'A', status: 'published' }),
        summary({ id: 'c2', name: 'B', status: 'draft' }),
        summary({ id: 'c3', name: 'C', status: 'published' }),
    ]);

    svc.setGroupBy('status');
    const groups = svc.groups.get();
    const byLabel = new Map(groups.map(g => [g.label, g.courses.map(c => c.id)]));
    expect(byLabel.get('Published')?.sort()).toEqual(['c1', 'c3']);
    expect(byLabel.get('Draft')).toEqual(['c2']);
});

test('groupBy none yields a single unlabeled group with every row', () => {
    const svc = svcWith([summary({ id: 'c1', name: 'A' }), summary({ id: 'c2', name: 'B' })]);

    svc.setGroupBy('none');
    const groups = svc.groups.get();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeNull();
    expect(groups[0]!.courses.map(c => c.id)).toEqual(['c1', 'c2']);
});

test('setGroupBy persists the choice to localStorage', () => {
    localStorage.removeItem('courses.groupBy');
    const svc = svcWith([]);

    svc.setGroupBy('status');
    expect(localStorage.getItem('courses.groupBy')).toBe('status');
});

test('query + sort + group compose: filters first, then sorts within groups', () => {
    const svc = svcWith([
        summary({ id: 'c1', name: 'Bravo', siteName: 'Site A', updatedAt: '2026-01-01T00:00:00Z' }),
        summary({ id: 'c2', name: 'Alpha', siteName: 'Site A', updatedAt: '2026-06-01T00:00:00Z' }),
        summary({ id: 'c3', name: 'Charlie', siteName: 'Site B', updatedAt: '2026-03-01T00:00:00Z' }),
        summary({ id: 'c4', name: 'NoMatch', siteName: 'Site A', updatedAt: '2026-05-01T00:00:00Z' }),
    ]);

    svc.query.set('a'); // every seeded name contains an "a" — filter is a no-op here, isolating sort+group
    svc.setGroupBy('site');
    svc.setSortBy('updated');

    const groups = svc.groups.get();
    const siteA = groups.find(g => g.label === 'Site A')!;
    // Within Site A: Alpha (Jun) before Bravo (Jan) before NoMatch (May) sorted by updated desc.
    expect(siteA.courses.map(c => c.name)).toEqual(['Alpha', 'NoMatch', 'Bravo']);
});
