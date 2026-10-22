import { afterEach, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { FeatureCollection } from 'geojson';
import type { ToolContext } from '../src/editor/tool';
import type { MapPointerEvent } from '../src/map/map.service';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FurnitureService, FURNITURE_TOOL_ID } from '../src/furniture/furniture.service';
import { FurnitureToolService } from '../src/furniture/furniture-tool.service';
import { FurniturePanelComponent } from '../src/furniture/furniture-panel.component';
import { HazardLinesService, HAZARD_LINES_OVERLAY_ID, type HazardLinesClient } from '../src/furniture/hazard-lines';
import { FeaturesService } from '../src/draw/features.service';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { sweref99tmToWgs84 } from '../src/geo/transform';
import { ApiError } from '@basics/core/client/api-error';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { GkdHazardLine, GkdLines } from '../../shared/api/gspro-export.gen';
import type { Hole } from '../../shared/api/holes.gen';
import type { TeesApi } from '../../shared/api/tees.gen';
import type { GreensApi } from '../../shared/api/greens.gen';
import type { PinsApi } from '../../shared/api/pins.gen';
import type { AimPointsApi } from '../../shared/api/aim-points.gen';
import { withBatchEndpoints } from './fake-feature-api';

// Furniture › Rules lines with the course file's automatic water lines: they load on activation (a busy icon
// while the pipeline runs), draw dashed, a click selects one, Play as it lies sets the waters' attribute through
// the rules engine (undoable), and Edit line turns the line into a drawn red penalty line that is selected for
// editing and holds the water from then on. The seams are the two HTTP clients: the course features (an
// in-memory server with optimistic locking) and gkd-lines (a stand-in for gspro.py: a line 2 m round every water
// no drawn penalty line's box holds).

let cleanups: Array<() => void> = [];
afterEach(() => {
    for (const c of cleanups.reverse()) c();
    cleanups = [];
    _reset();
    di.reset();
});

const E0 = 529_400, N0 = 6_487_400;
const ORIGIN = sweref99tmToWgs84(E0, N0);
/** Screen px per degree in the fake flat transform. */
const PX = 1e5;
const toScreen = (lng: number, lat: number) => ({ x: (lng - ORIGIN.lon) * PX, y: (ORIGIN.lat - lat) * PX });
const toLngLat = (x: number, y: number) => ({ lng: ORIGIN.lon + x / PX, lat: ORIGIN.lat - y / PX });
const screenOf = (e: number, n: number) => { const p = sweref99tmToWgs84(e, n); return toScreen(p.lon, p.lat); };

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: E0 + x0, y: N0 + y0 }, { x: E0 + x1, y: N0 + y0 }, { x: E0 + x1, y: N0 + y1 }, { x: E0 + x0, y: N0 + y1 },
] }] });

function row(id: string, type: string, geometry: CourseFeature['geometry'], holeId: string | null = null, attributes?: Record<string, unknown>): CourseFeature {
    return { id, courseId: 'c1', holeId, type, geometry, sortOrder: 0, source: null, sourceRef: null, license: null, version: 1, ...(attributes ? { attributes } : {}) } as CourseFeature;
}

/** The course features server, in memory (create / update / remove + the batch endpoints). */
function featuresServer(initial: CourseFeature[]) {
    const rows = new Map(initial.map(f => [f.id, structuredClone(f)]));
    let seq = 0;
    const api = {
        listByCourse: async () => [...rows.values()].map(f => structuredClone(f)),
        async create(input) {
            const f = row(`new${++seq}`, input.type, structuredClone(input.geometry), input.holeId ?? null, input.attributes ?? undefined);
            rows.set(f.id, f);
            return structuredClone(f);
        },
        async update(input) {
            const r = rows.get(input.id);
            if (!r || r.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.type !== undefined) r.type = input.type;
            if (input.holeId !== undefined) r.holeId = input.holeId;
            if (input.geometry !== undefined) r.geometry = structuredClone(input.geometry);
            if (input.attributes !== undefined) (r as { attributes?: unknown }).attributes = structuredClone(input.attributes) ?? undefined;
            r.version++;
            return structuredClone(r);
        },
        async remove(input) {
            const r = rows.get(input.id);
            if (!r || r.version !== input.version) throw new ApiError(409, 'Version conflict');
            rows.delete(input.id);
            return { ok: true };
        },
    } as CourseFeaturesApi;
    withBatchEndpoints(api, rows);
    return { api, rows };
}

const boxOf = (f: CourseFeature) => {
    const pts = f.geometry.rings.flatMap(r => r.points);
    return { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
};

/** gspro.py gkd-lines' stand-in: every penalty line as drawn, a line 2 m out round each water no penalty's box holds. */
function linesServer(rows: Map<string, CourseFeature>) {
    let calls = 0;
    let gate: Promise<void> | null = null;
    let failWith: string | null = null;
    const attr = (f: CourseFeature) => (f as { attributes?: Record<string, unknown> }).attributes?.noAsItLies === true;
    const client: HazardLinesClient = {
        async gkdLines() {
            calls++;
            if (gate) await gate;
            if (failWith) throw new ApiError(409, failWith);
            const all = [...rows.values()];
            const penalties = all.filter(f => f.type === 'penalty_red' || f.type === 'penalty_yellow');
            const lines: GkdHazardLine[] = penalties.map(p => ({
                kind: 'penalty', featureId: p.id, type: p.type, noAsItLies: attr(p),
                points: p.geometry.rings[0]!.points.map(q => [q.x, q.y] as [number, number]),
            }));
            for (const w of all.filter(f => f.type === 'water')) {
                const b = boxOf(w);
                if (penalties.some(p => { const c = boxOf(p); return c.x0 <= b.x0 && c.y0 <= b.y0 && c.x1 >= b.x1 && c.y1 >= b.y1; })) continue;
                const points: [number, number][] = [];
                const x0 = b.x0 - 2, y0 = b.y0 - 2, x1 = b.x1 + 2, y1 = b.y1 + 2;
                for (let x = x0; x < x1; x += 3) points.push([x, y0]);
                for (let y = y0; y < y1; y += 3) points.push([x1, y]);
                for (let x = x1; x > x0; x -= 3) points.push([x, y1]);
                for (let y = y1; y > y0; y -= 3) points.push([x0, y]);
                lines.push({ kind: 'water', waterIds: [w.id], noAsItLies: attr(w), points });
            }
            const doc: GkdLines = { courseId: 'c1', crs: 'EPSG:3006', rule: { marginM: 1, bankMaxM: 3, bankStartM: 2, deepPct: 15, roughPct: 20 }, lines };
            return doc;
        },
    };
    return {
        client,
        calls: () => calls,
        hold: () => { let open!: () => void; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; },
        fail: (message: string | null) => { failWith = message; },
    };
}

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('not under test')) });

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Bun.sleep(1);
}

async function setup() {
    const detail = new CourseDetailService();
    detail.holeStore.set([{ id: 'h1', courseId: 'c1', number: 3, par: 4, strokeIndex: null, notes: null, savedRegionJson: null, version: 1, createdAt: '', updatedAt: '' } as Hole]);
    di.set(CourseDetailService, detail);
    di.set(ConfirmService, new ConfirmService());
    di.set(FurnitureService, new FurnitureService(unused as TeesApi, unused as GreensApi, unused as PinsApi, unused as AimPointsApi));

    // A pond on hole 3 (gets an automatic line) and one inside a drawn yellow penalty line (does not).
    const server = featuresServer([
        row('w1', 'water', rect(100, -140, 140, -100), 'h1'),
        row('w2', 'water', rect(200, -220, 220, -200)),
        row('p1', 'penalty_yellow', rect(195, -225, 225, -195)),
    ]);
    const features = new FeaturesService(server.api, createInlineSurfaceStackClient());
    await features.load('c1');
    di.set(FeaturesService, features);
    const lines = linesServer(server.rows);
    di.set(HazardLinesService, new HazardLinesService(lines.client));

    const overlays = new Map<string, FeatureCollection[]>();
    const record = (id: string, data: unknown) => { const l = overlays.get(id) ?? []; l.push(data as FeatureCollection); overlays.set(id, l); };
    const gl = new Map<string, Set<(e: unknown) => void>>();
    const glMap = {
        transform: { locationToScreenPoint: (l: { lng: number; lat: number }) => toScreen(l.lng, l.lat) },
        project: () => { throw new Error('terrain-aware map.project called'); },
        getCanvas: () => ({ style: {} }),
        getBearing: () => 0,
        boxZoom: { enable() {}, disable() {} },
        getMaxPitch: () => 60,
        setMaxPitch() {},
        on(type: string, h: (e: unknown) => void) { const s = gl.get(type) ?? new Set(); s.add(h); gl.set(type, s); },
        off(type: string, h: (e: unknown) => void) { gl.get(type)?.delete(h); },
        dragPan: { enable() {}, disable() {} },
    };
    const clickHandlers: Array<(e: MapPointerEvent) => void> = [];
    const map = {
        ready: new Signal(true),
        map: new Signal(glMap),
        zoom: new Signal(18),
        interactionMode: new Signal<string | null>(FURNITURE_TOOL_ID),
        onClick: (h: (e: MapPointerEvent) => void) => { clickHandlers.push(h); return () => { clickHandlers.splice(clickHandlers.indexOf(h), 1); }; },
        onMouseMove: () => () => {},
        addOverlayLayer: (id: string, data: unknown) => record(id, data),
        updateOverlayData: (id: string, data: unknown) => record(id, data),
        removeOverlayLayer: () => {},
    };
    const ctx: ToolContext = {
        map: map as never,
        elevation: { elevationAt: async () => null } as never,
        tileset: null as never,
        courseDetail: detail,
        features,
        courseId: 'c1',
        track: (d: () => void) => { cleanups.push(d); },
    };
    const tool = new FurnitureToolService();
    di.set(FurnitureToolService, tool);
    const release = lines.hold();
    tool.activate(ctx);
    cleanups.push(() => tool.deactivate());

    const host = document.createElement('div');
    document.body.appendChild(host);
    new FurniturePanelComponent({}).mount(host);
    cleanups.push(() => host.remove());

    const click = (x: number, y: number) => {
        const e: MapPointerEvent = { point: { x, y }, lngLat: toLngLat(x, y), originalEvent: new MouseEvent('click') };
        for (const h of [...clickHandlers]) h(e);
    };
    const $ = <T extends HTMLElement = HTMLElement>(testid: string) => host.querySelector<T>(`[data-testid="${testid}"]`)!;
    const autoOverlay = () => overlays.get(HAZARD_LINES_OVERLAY_ID)?.at(-1)?.features ?? [];
    return { tool, features, server, lines, release, click, $, host, autoOverlay };
}

test('the automatic water lines load on activation, draw dashed, and a click selects one', async () => {
    const t = await setup();
    // The pipeline is still running: a busy icon, nothing on the map yet.
    expect(t.$('furniture-gkd-lines-status').className).toContain('busy');
    expect(t.autoOverlay()).toEqual([]);
    t.release();
    await settle();

    const status = t.$('furniture-gkd-lines-status');
    expect(status.className).not.toContain('busy');
    expect(status.title).toMatch(/^1 automatic water line \(dashed\)/);
    // Only the pond no drawn line holds has one; the drawn yellow line is the rules engine's to draw.
    expect(t.autoOverlay().map(f => f.properties?.key)).toEqual(['w1']);
    expect(t.autoOverlay()[0]!.geometry.type).toBe('LineString');

    // A click 3 px off the line's west side selects it; the card says what it is, with the toggle and Edit line.
    const west = screenOf(E0 + 98, N0 - 120);
    t.click(west.x - 3, west.y);
    expect(t.tool.lines.selectedKey.peek()).toBe('w1');
    expect(t.autoOverlay().find(f => f.properties?.key === 'w1')!.properties!.selected).toBe(true);
    expect(t.$('furniture-rule-card').textContent).toBe('Water line (auto) · 1 shape');
    expect(t.host.querySelector('.selection.show')).not.toBeNull();
    expect(t.$('furniture-edit-line').className).toContain('show');
    expect(t.$<HTMLInputElement>('furniture-play-as-it-lies').checked).toBe(true);
    expect(t.host.querySelector('.delete-btn.hide')).not.toBeNull();

    // Esc clears it; so does a click on nothing.
    expect(t.tool.onEscape()).toBe(true);
    expect(t.tool.lines.selectedKey.peek()).toBeNull();
    t.click(west.x - 3, west.y);
    expect(t.tool.lines.selectedKey.peek()).toBe('w1');
    const far = screenOf(E0 + 60, N0 - 60);
    t.click(far.x, far.y);
    expect(t.tool.lines.selectedKey.peek()).toBeNull();

    // A click inside the drawn yellow line selects that feature, not an automatic line.
    const inYellow = screenOf(E0 + 210, N0 - 210);
    t.click(inYellow.x, inYellow.y);
    expect([...t.features.selectedIds.peek()]).toEqual(['p1']);
    expect(t.tool.lines.selectedKey.peek()).toBeNull();
    // Its own Play as it lies toggle shows; it is on until the line asks otherwise.
    expect(t.host.querySelector('.ail-row.show')).not.toBeNull();
    expect(t.$('furniture-edit-line').className).not.toContain('show');
});

test('Play as it lies off sets noAsItLies on the waters through the rules engine, undoably, and reads the lines again', async () => {
    const t = await setup();
    t.release();
    await settle();
    const west = screenOf(E0 + 98, N0 - 120);
    t.click(west.x - 2, west.y);
    const toggle = t.$<HTMLInputElement>('furniture-play-as-it-lies');
    const before = t.lines.calls();

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await settle();
    expect((t.server.rows.get('w1') as { attributes?: unknown }).attributes).toEqual({ noAsItLies: true });
    expect(t.lines.calls()).toBe(before + 1);
    expect(t.tool.lines.selected.peek()!.line.noAsItLies).toBe(true);
    expect(toggle.checked).toBe(false);

    // The normal undo takes it back.
    expect(t.tool.rules.history.canUndo.peek()).toBe(true);
    t.tool.rules.undo();
    await settle();
    await t.features.flush();
    expect((t.server.rows.get('w1') as { attributes?: unknown }).attributes).toBeUndefined();
    expect(toggle.checked).toBe(true);
});

test('Edit line draws a red penalty line on the water\'s hole as a smooth spline, selected for editing, and the automatic line goes', async () => {
    const t = await setup();
    t.release();
    await settle();
    const west = screenOf(E0 + 98, N0 - 120);
    t.click(west.x - 2, west.y);

    t.$('furniture-edit-line').click();
    await settle();
    const made = [...t.server.rows.values()].find(f => f.id.startsWith('new'))!;
    expect(made.type).toBe('penalty_red');
    expect(made.holeId).toBe('h1');
    expect(made.geometry.curveType).toBe('bspline');
    expect(made.geometry.rings[0]!.points.length).toBeGreaterThanOrEqual(8);
    expect(made.geometry.rings[0]!.points.every(p => !p.corner)).toBe(true);
    // Selected for vertex editing, in the rules undo history; the water's automatic line is gone after the reload.
    expect([...t.features.selectedIds.peek()]).toEqual([made.id]);
    expect(t.tool.lines.selectedKey.peek()).toBeNull();
    expect(t.tool.rules.history.canUndo.peek()).toBe(true);
    expect(t.autoOverlay()).toEqual([]);
    expect(t.$('furniture-rule-card').textContent).toContain('Red penalty');
    expect(t.$('furniture-rule-card').textContent).toContain('hole 3');

    // Undo removes the drawn line, and the automatic one comes back.
    t.tool.rules.undo();
    await settle();
    expect(t.server.rows.has(made.id)).toBe(false);
    expect(t.autoOverlay().map(f => f.properties?.key)).toEqual(['w1']);
});

test('when the lines cannot be read, nothing is drawn and the reason is the status icon\'s tooltip', async () => {
    const t = await setup();
    t.lines.fail('This course has no built map on this machine — build its map first');
    t.release();
    await settle();
    const status = t.$('furniture-gkd-lines-status');
    expect(status.className).toContain('error');
    expect(status.title).toBe('No water lines: This course has no built map on this machine — build its map first');
    expect(t.autoOverlay()).toEqual([]);
});
