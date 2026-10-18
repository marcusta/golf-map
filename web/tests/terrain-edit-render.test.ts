import { describe, expect, test } from 'bun:test';
import { Signal } from '@basics/core/client/core';
import type { FeatureCollection } from 'geojson';
import type { MapService } from '../src/map/map.service';
import type { TerrainEdit } from '../../shared/api/terrain-edits.gen';
import type { AnchorPoint, Point } from '../src/geo/bezier';
import type { TerrainEditView } from '../src/terrain-edit/terrain-edit-tool.service';
import {
    TerrainEditOverlayRenderer,
    TERRAIN_EDIT_DRAFT_OVERLAY_ID,
    TERRAIN_EDIT_OVERLAY_ID,
    resetTerrainEditProjectionCount,
    terrainEditProjectionCount,
    terrainEditLiveGeojson,
    type GlyphMarkerFactory,
} from '../src/terrain-edit/terrain-edit-render';

// Item 17: the overlay renderer caches WGS84 rings per edit and diffs glyph
// markers by id. These tests drive the real renderer over a recording fake
// MapService and a fake marker factory (maplibre-gl does not load under bun).

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeMap {
    svc: MapService;
    adds: string[];
    updates: Array<{ id: string; data: FeatureCollection }>;
    removes: string[];
}

function fakeMap(): FakeMap {
    const f: FakeMap = {
        adds: [],
        updates: [],
        removes: [],
        svc: null as never,
    };
    f.svc = {
        map: new Signal<object | null>({}),
        addOverlayLayer: (id: string) => { f.adds.push(id); },
        updateOverlayData: (id: string, data: FeatureCollection) => { f.updates.push({ id, data }); },
        removeOverlayLayer: (id: string) => { f.removes.push(id); },
    } as unknown as MapService;
    return f;
}

interface MarkerLog { created: number; moved: number; removed: number }

function markerFactory(log: MarkerLog): GlyphMarkerFactory {
    return () => {
        log.created++;
        return {
            setLngLat() { log.moved++; return this; },
            remove() { log.removed++; return this; },
        };
    };
}

// SWEREF99 TM points around Landeryd.
const X0 = 446_000;
const Y0 = 6_473_000;

function ring(i: number, n = 8): Point[] {
    const cx = X0 + i * 50;
    return Array.from({ length: n }, (_, k) => ({
        x: cx + 10 * Math.cos((2 * Math.PI * k) / n),
        y: Y0 + 10 * Math.sin((2 * Math.PI * k) / n),
    }));
}

function edit(i: number, overrides: Partial<TerrainEdit> = {}): TerrainEdit {
    return {
        id: `e${i}`,
        siteId: 'site-1',
        op: 'plane',
        params: { featherM: 2 },
        rings: [ring(i)],
        enabled: true,
        version: 1,
        createdAt: '2026-07-18T10:00:00Z',
        updatedAt: '2026-07-18T10:00:00Z',
        ...overrides,
    };
}

/** Append one draft point the way DrawState.addPoint does (old objects kept). */
function addDraftPoint(draft: AnchorPoint[], k: number): AnchorPoint[] {
    return [...draft, { x: X0 + 5 * k, y: Y0 - 30 - (k % 2) * 5 }];
}

// Stable identities, as the tool service's computeds hand them out.
const NO_LABELS: TerrainEditView['labels'] = {};
const NO_SELECTION: TerrainEditView['selection'] = [];
const NO_RECIPES: TerrainEditView['recipes'] = {};

function view(edits: TerrainEdit[], draft: AnchorPoint[], cursor: Point | null = null): TerrainEditView {
    return { edits, draft, cursor, highlightId: null, labels: NO_LABELS, recipes: NO_RECIPES, selection: NO_SELECTION };
}

const roles = (fc: FeatureCollection) => fc.features.map(f => (f.properties as { role: string }).role);

function lastDraftData(m: FakeMap): FeatureCollection | undefined {
    for (let i = m.updates.length - 1; i >= 0; i--) {
        if (m.updates[i].id === TERRAIN_EDIT_DRAFT_OVERLAY_ID) return m.updates[i].data;
    }
    return undefined;
}

// ─── Scenario: E saved edits, then N draft clicks, one render per click ────

const E = 20;
const N = 30;
const RING_LEN = 8;

describe('draft clicks over saved edits', () => {
    test('markers are created once per edit, not once per render', () => {
        const m = fakeMap();
        const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
        const r = new TerrainEditOverlayRenderer(markerFactory(log));
        const edits = Array.from({ length: E }, (_, i) => edit(i));

        r.render(m.svc, view(edits, []));
        let draft: AnchorPoint[] = [];
        for (let k = 0; k < N; k++) {
            draft = addDraftPoint(draft, k);
            r.render(m.svc, view(edits, draft));
        }

        console.log(`[terrain-edit] ${E} edits + ${N} draft clicks: markers created ${log.created}, removed ${log.removed}`);
        expect(log.created).toBe(E);
        expect(log.removed).toBe(0);
        expect(log.moved).toBe(0);
        // The edits overlay never re-uploads while only the draft changes.
        expect(m.updates.filter(u => u.id === TERRAIN_EDIT_OVERLAY_ID)).toHaveLength(0);
        expect(m.updates.filter(u => u.id === TERRAIN_EDIT_DRAFT_OVERLAY_ID)).toHaveLength(N);
    });

    test('each click projects exactly one new point (rings and old points come from the cache)', () => {
        const m = fakeMap();
        const r = new TerrainEditOverlayRenderer(markerFactory({ created: 0, moved: 0, removed: 0 }));
        const edits = Array.from({ length: E }, (_, i) => edit(100 + i));

        resetTerrainEditProjectionCount();
        r.render(m.svc, view(edits, []));
        const initial = terrainEditProjectionCount();
        // One conversion per ring vertex plus one per glyph anchor.
        expect(initial).toBe(E * RING_LEN + E);

        const perClick: number[] = [];
        let draft: AnchorPoint[] = [];
        for (let k = 0; k < N; k++) {
            draft = addDraftPoint(draft, k);
            const before = terrainEditProjectionCount();
            r.render(m.svc, view(edits, draft));
            perClick.push(terrainEditProjectionCount() - before);
        }
        const total = terrainEditProjectionCount();
        console.log(`[terrain-edit] projections: initial ${initial}, per click ${[...new Set(perClick)].join('/')}, total ${total}`);
        expect(perClick.every(n => n === 1)).toBe(true);
        expect(total).toBe(initial + N);
    });

    test('a pointer move projects only the cursor', () => {
        const m = fakeMap();
        const r = new TerrainEditOverlayRenderer(markerFactory({ created: 0, moved: 0, removed: 0 }));
        const edits = [edit(200)];
        let draft: AnchorPoint[] = [];
        for (let k = 0; k < 5; k++) draft = addDraftPoint(draft, k);
        r.render(m.svc, view(edits, draft));

        const before = terrainEditProjectionCount();
        for (let i = 0; i < 10; i++) r.render(m.svc, view(edits, draft, { x: X0 + i, y: Y0 }));
        expect(terrainEditProjectionCount() - before).toBe(10);
    });
});

describe('closing N edits in a row', () => {
    test('markers created grow O(N): one per new edit', () => {
        const m = fakeMap();
        const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
        const r = new TerrainEditOverlayRenderer(markerFactory(log));
        let edits: TerrainEdit[] = [];
        r.render(m.svc, view(edits, []));
        for (let i = 0; i < N; i++) {
            edits = [...edits, edit(300 + i)];
            r.render(m.svc, view(edits, []));
        }
        console.log(`[terrain-edit] ${N} closed edits: markers created ${log.created}`);
        expect(log.created).toBe(N);
        expect(log.removed).toBe(0);
    });
});

describe('glyph diff by id', () => {
    test('toggle restyles in place, a moved ring moves its marker, a deleted edit removes only its marker', () => {
        const m = fakeMap();
        const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
        const r = new TerrainEditOverlayRenderer(markerFactory(log));
        const a = edit(400);
        const b = edit(401);
        r.render(m.svc, view([a, b], []));
        expect(log.created).toBe(2);

        // Enabled toggle: server returns a new row with the same rings array.
        const a2 = { ...a, enabled: false, version: 2 };
        const before = terrainEditProjectionCount();
        r.render(m.svc, view([a2, b], []));
        expect(log).toEqual({ created: 2, moved: 0, removed: 0 });
        expect(terrainEditProjectionCount()).toBe(before); // ring cache hit

        // New rings for b: the marker moves, no new marker.
        const b2 = { ...b, rings: [ring(402)], version: 2 };
        r.render(m.svc, view([a2, b2], []));
        expect(log).toEqual({ created: 2, moved: 1, removed: 0 });

        // Delete a.
        r.render(m.svc, view([b2], []));
        expect(log).toEqual({ created: 2, moved: 1, removed: 1 });
    });

    test('clear removes both overlays and every marker; the next render starts fresh', () => {
        const m = fakeMap();
        const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
        const r = new TerrainEditOverlayRenderer(markerFactory(log));
        const edits = [edit(500), edit(501)];
        r.render(m.svc, view(edits, []));
        r.clear(m.svc);
        expect(m.removes.sort()).toEqual([TERRAIN_EDIT_DRAFT_OVERLAY_ID, TERRAIN_EDIT_OVERLAY_ID].sort());
        expect(log.removed).toBe(2);

        r.render(m.svc, view(edits, []));
        expect(log.created).toBe(4);
        expect(m.adds.filter(id => id === TERRAIN_EDIT_OVERLAY_ID)).toHaveLength(2);
    });
});

describe('recipe edits', () => {
    test('a recipe edit is drawn on its feature in the recipe colour, with a pill naming the recipe', () => {
        const m = fakeMap();
        const pills: HTMLElement[] = [];
        const r = new TerrainEditOverlayRenderer(el => {
            pills.push(el);
            return { setLngLat() { return this; }, remove() { return this; } };
        });
        const hand = edit(500);
        const done = edit(501, { op: 'recipe', params: { featherM: 0, recipe: 'pot' }, rings: [] });
        const away = edit(502, { op: 'recipe', params: { featherM: 0, recipe: 'pot' }, rings: [] }); // its feature is not loaded
        const edits = [hand, done, away];
        const base = view(edits, []);
        r.render(m.svc, base); // overlay added

        const recipes = { e501: { rings: [ring(501)], color: '#fb923c' } };
        r.render(m.svc, { ...base, labels: { e501: 'Pot bunker' }, recipes });
        const data = m.updates.filter(u => u.id === TERRAIN_EDIT_OVERLAY_ID).at(-1)!.data;
        expect(data.features.map(f => f.properties)).toEqual([
            { role: 'edit', enabled: true },
            { role: 'recipe', enabled: true, color: '#fb923c' },
        ]);
        expect(pills.map(el => el.textContent)).toEqual(['▱ plane', '◈ Pot bunker']);
        // happy-dom keeps the colour as written.
        expect(pills[1].style.cssText).toContain('#fb923c');

        // Hovering its row highlights the feature's outline.
        r.render(m.svc, { ...base, labels: { e501: 'Pot bunker' }, recipes, highlightId: 'e501' });
        expect(roles(lastDraftData(m)!)).toEqual(['highlight']);
    });
});

describe('a lake shore', () => {
    test('its dense outline is drawn once, simplified, with the islands as holes; a draft click leaves it alone', () => {
        const m = fakeMap();
        const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
        const r = new TerrainEditOverlayRenderer(markerFactory(log));
        // 50k points 0.25 m apart along a wavy 2 km shoreline, and one island.
        const N = 50_000;
        const lake = Array.from({ length: N }, (_, k) => {
            const a = (2 * Math.PI * k) / N;
            const rad = 2000 + 3 * Math.sin(400 * a);
            return { x: X0 + rad * Math.cos(a), y: Y0 + rad * Math.sin(a) };
        });
        const shore = edit(900, { op: 'shore', origin: 'lake-shore', params: { featherM: 0, levelM: 88.5 }, rings: [lake, ring(0, 64)] });
        r.render(m.svc, view([], [])); // overlay added
        resetTerrainEditProjectionCount();
        r.render(m.svc, view([shore], []));
        const data = m.updates.filter(u => u.id === TERRAIN_EDIT_OVERLAY_ID).at(-1)!.data;
        expect(data.features).toHaveLength(1);
        const coords = (data.features[0].geometry as { coordinates: number[][][] }).coordinates;
        expect(coords).toHaveLength(2);
        expect(coords[0][0]).toEqual(coords[0].at(-1)!);
        expect(coords[0].length).toBeLessThan(N);
        expect(terrainEditProjectionCount()).toBeLessThan(N);

        resetTerrainEditProjectionCount();
        r.render(m.svc, view([shore], addDraftPoint([], 0)));
        expect(terrainEditProjectionCount()).toBe(1);
    });
});

describe('rubber band', () => {
    test('draft-cursor segment runs from the last point to the pointer; absent without a draft', () => {
        const m = fakeMap();
        const r = new TerrainEditOverlayRenderer(markerFactory({ created: 0, moved: 0, removed: 0 }));
        let draft: AnchorPoint[] = [];
        r.render(m.svc, view([], draft));
        for (let k = 0; k < 3; k++) draft = addDraftPoint(draft, k);
        r.render(m.svc, view([], draft, { x: X0 + 40, y: Y0 }));
        const drafting = lastDraftData(m)!;
        expect(roles(drafting)).toContain('draft-cursor');
        const band = drafting.features.find(f => (f.properties as { role: string }).role === 'draft-cursor')!;
        const line = drafting.features.find(f => (f.properties as { role: string }).role === 'draft-line')!;
        const lineCoords = (line.geometry as { coordinates: number[][] }).coordinates;
        expect((band.geometry as { coordinates: number[][] }).coordinates[0]).toEqual(lineCoords[lineCoords.length - 1]);

        // Ring closed: the draft is empty, a stale cursor draws nothing.
        r.render(m.svc, view([], [], { x: X0 + 40, y: Y0 }));
        expect(lastDraftData(m)!.features).toHaveLength(0);
    });
});

test('a pond edge proposal draws as two lines on the live overlay: the proposed edge and the lidar water', () => {
    const ring = [{ x: 530000, y: 6487000 }, { x: 530020, y: 6487000 }, { x: 530020, y: 6487020 }, { x: 530000, y: 6487020 }];
    const lidar = ring.map(p => ({ x: p.x + (p.x > 530010 ? -2 : 2), y: p.y + (p.y > 6487010 ? -2 : 2) }));
    const v = { ...view([], []), pondEdge: { proposed: ring, lidar } };
    const fc = terrainEditLiveGeojson(v, null);
    const roles = fc.features.map(f => [f.properties?.role, f.geometry.type]);
    expect(roles).toEqual([['pond-lidar', 'LineString'], ['pond-proposed', 'LineString']]);
    const proposed = fc.features[1]!.geometry as { coordinates: number[][] };
    expect(proposed.coordinates[0]).toEqual(proposed.coordinates[proposed.coordinates.length - 1]);   // closed
    expect(terrainEditLiveGeojson({ ...v, pondEdge: null }, null).features).toEqual([]);
});

test('a Find falls proposal draws its pieces and falls on the live overlay, with a pill per level and drop', () => {
    const box = (x0: number, x1: number) => [{ x: X0 + x0, y: Y0 - 3 }, { x: X0 + x1, y: Y0 - 3 }, { x: X0 + x1, y: Y0 + 3 }, { x: X0 + x0, y: Y0 + 3 }];
    const waterSteps = {
        pieces: [
            { ring: box(0, 29.5), kind: 'pond' as const, label: '109.61', at: { x: X0 + 15, y: Y0 } },
            { ring: box(30.5, 60), kind: 'creek' as const, label: '109.12›108.60', at: { x: X0 + 45, y: Y0 } },
        ],
        falls: [{ line: [{ x: X0 + 30.5, y: Y0 - 3 }, { x: X0 + 30.5, y: Y0 + 3 }], label: '0.49 m', at: { x: X0 + 30.5, y: Y0 } }],
    };
    const v = { ...view([], []), waterSteps };
    expect(terrainEditLiveGeojson(v, null).features.map(f => [f.properties?.role, f.geometry.type])).toEqual([
        ['steps-pond', 'LineString'], ['steps-creek', 'LineString'], ['steps-fall', 'LineString'],
    ]);

    const log: MarkerLog = { created: 0, moved: 0, removed: 0 };
    const m = fakeMap();
    const r = new TerrainEditOverlayRenderer(markerFactory(log));
    r.render(m.svc, v);
    expect(log.created).toBe(3);
    r.render(m.svc, v);                                   // the same proposal: the pills stay
    expect(log.created).toBe(3);
    r.render(m.svc, { ...v, waterSteps: null });          // discarded: they go
    expect(log.removed).toBe(3);
    expect(lastDraftData(m)!.features).toEqual([]);
});
