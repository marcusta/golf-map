import { test, expect } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { PaintToolService, changeSummary, circleRing } from '../src/terrain-edit/paint-tool.service';
import type { PaintApi, PaintChangeResult, PaintList, PaintStroke } from '../../shared/api/paint.gen';

// The Terrain editor's Paint tool, client side, against a fake API object (plain functions, no mocking library —
// TESTING.md) that keeps strokes the way the server's paint.json does: what a drawn stroke sends, and what Preview,
// Save, Undo and Remove leave on screen.

function result(patch: Partial<PaintChangeResult> = {}): PaintChangeResult {
    return {
        courseId: 'course-1', action: 'stroke', id: 'stroke-1', dryRun: false, saved: true, file: 'docs/gspro/x/paint.json',
        layer: { written: false, path: null, ops: 2, note: 'layer not live yet' },
        preview: { status: 'shown', note: null, within: [0, 0, 1, 1], meshes: 2, previewed: ['A', 'B'], cleared: [], skipped: [] },
        sync: null, warnings: [], ...patch,
    };
}

function fakeApi(opts: { refuse?: string } = {}) {
    const strokes: PaintStroke[] = [];
    const calls: Array<{ call: string; input: any }> = [];
    let n = 0;
    const client: PaintApi = {
        list: async (input) => {
            calls.push({ call: 'list', input });
            return { courseId: input.courseId, file: 'paint.json', exists: true, rules: [], strokes: [...strokes], lakebed: null, layerLive: false } satisfies PaintList;
        },
        stroke: async (input) => {
            calls.push({ call: 'stroke', input });
            if (opts.refuse) throw new ApiError(409, opts.refuse);
            const id = input.stroke.id ?? `stroke-${++n}`;
            if (!input.dryRun) strokes.push({ ...input.stroke, id } as PaintStroke);
            return result({ id, dryRun: !!input.dryRun, saved: !input.dryRun });
        },
        rule: async () => { throw new Error('not used'); },
        disable: async () => { throw new Error('not used'); },
        remove: async (input) => {
            calls.push({ call: 'remove', input });
            const i = strokes.findIndex(s => s.id === input.id);
            if (i >= 0) strokes.splice(i, 1);
            return result({ action: 'remove', id: input.id, preview: { ...result().preview, previewed: [], cleared: ['A'] } });
        },
    };
    return { client, calls, strokes };
}

test('a line is clicked point by point; Preview sends it as a dry run and keeps the draft', async () => {
    const api = fakeApi();
    const paint = new PaintToolService(api.client);
    await paint.load('course-1');
    paint.active.set(true);
    paint.widthM.set(2);
    paint.click({ x: 529000.004, y: 6487000 });
    expect(paint.pending.get()).toBeNull();
    paint.click({ x: 529010, y: 6487000 });
    expect(paint.pending.get()).toEqual({
        geometry: 'line', channel: 'black', featherM: 0.5, strength: 1, points3006: [[529000, 6487000], [529010, 6487000]], widthM: 2,
    });

    expect(await paint.preview()).toBe(true);
    const sent = api.calls.find(c => c.call === 'stroke')!.input;
    expect(sent.dryRun).toBe(true);
    expect(sent.courseId).toBe('course-1');
    expect(paint.notice.get()).toBe('Preview · 2 meshes');
    expect(paint.draft.get()).toHaveLength(2);
    expect(paint.strokes.get()).toEqual([]);
});

test('Save keeps the stroke and clears the draft; Undo removes the strokes saved here, newest first', async () => {
    const api = fakeApi();
    const paint = new PaintToolService(api.client);
    await paint.load('course-1');
    paint.active.set(true);
    for (const id of ['first', 'second']) {
        paint.click({ x: 0, y: 0 });
        paint.click({ x: 5, y: 0 });
        expect(await paint.save()).toBe(true);
        expect(paint.notice.get()).toBe(`Saved stroke-${id === 'first' ? 1 : 2} · 2 meshes`);
    }
    expect(paint.draft.get()).toEqual([]);
    expect(paint.strokes.get().map(s => s.id)).toEqual(['stroke-1', 'stroke-2']);

    expect(await paint.undo()).toBe(true);
    expect(api.calls.filter(c => c.call === 'remove').map(c => c.input.id)).toEqual(['stroke-2']);
    expect(paint.notice.get()).toBe('Removed stroke-2 · 0 meshes, 1 back');
    expect(await paint.undo()).toBe(true);
    expect(paint.canUndo.get()).toBe(false);
    expect(await paint.undo()).toBe(false);
    expect(paint.strokes.get()).toEqual([]);
});

test('a circle is its centre and a rim point; the map shows it in its channel colour', async () => {
    const paint = new PaintToolService(fakeApi().client);
    await paint.load('course-1');
    paint.active.set(true);
    paint.setGeometry('circle');
    paint.channel.set('red');
    paint.click({ x: 100, y: 200 });
    paint.move({ x: 103, y: 204 });
    const live = paint.mark.get()!;
    expect(live.shapes).toHaveLength(1);
    expect(live.shapes[0]!.kind).toBe('area');
    expect(live.shapes[0]!.color).toBe('#ef4444');
    paint.click({ x: 103, y: 204 });
    expect(paint.pending.get()).toMatchObject({ geometry: 'circle', centre3006: [100, 200], radiusM: 5, channel: 'red' });
    // a third click starts a new circle
    paint.click({ x: 1, y: 1 });
    expect(paint.draft.get()).toEqual([{ x: 1, y: 1 }]);
    expect(paint.cancel()).toBe(true);
    paint.active.set(false);
    expect(paint.mark.get()).toBeNull();
});

test('a refused stroke leaves the server message and the draft', async () => {
    const paint = new PaintToolService(fakeApi({ refuse: 'stroke stroke-1: black has no overlay; use mode replace' }).client);
    await paint.load('course-1');
    paint.setGeometry('polygon');
    paint.click({ x: 0, y: 0 });
    paint.click({ x: 1, y: 0 });
    expect(paint.pending.get()).toBeNull();
    paint.click({ x: 1, y: 1 });
    expect(await paint.save()).toBe(false);
    expect(paint.notice.get()).toBe('stroke stroke-1: black has no overlay; use mode replace');
    expect(paint.draft.get()).toHaveLength(3);
});

test('changeSummary and circleRing', () => {
    expect(changeSummary(result({ preview: { ...result().preview, status: 'skipped', previewed: [] } }))).toBe('Saved stroke-1 · Unity closed');
    const ring = circleRing({ x: 10, y: 10 }, 2, 4);
    expect(ring[0]).toEqual({ x: 12, y: 10 });
    expect(ring).toHaveLength(4);
});
