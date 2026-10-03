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

function view(edits: TerrainEdit[], draft: AnchorPoint[], cursor: Point | null = null): TerrainEditView {
    return { edits, draft, cursor };
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
