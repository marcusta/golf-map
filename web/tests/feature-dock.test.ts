import { test, expect, afterEach } from 'bun:test';
import { Router, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ContextDockComponent } from '../src/draw/feature-dock.component';
import { ServerModeService } from '../src/app/server-mode.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FeaturesService } from '../src/draw/features.service';
import { DrawToolService, DRAW_TOOL_ID } from '../src/draw/draw-tool.service';
import { EditorModeService } from '../src/editor/editor-mode.service';
import { MEASURE_TOOL_ID } from '../src/measure/measure-tool.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { Hole } from '../../shared/api/holes.gen';

// Draw dock (review item 28): stack rows bound to per-feature signals,
// Shift/Cmd row clicks, panels kept mounted across sub-mode switches, the
// move-to-hole select built once per hole list, and the tool notice in the
// footer.

const mounted: ContextDockComponent[] = [];
afterEach(() => {
    for (const c of mounted.splice(0)) c.destroy();
    document.body.textContent = '';
    localStorage.clear();
    _reset();
    di.reset();
});

function row(i: number, opts: Partial<CourseFeature> = {}): CourseFeature {
    const x = i * 30;
    return {
        id: `f${i}`, courseId: 'c1', holeId: null, type: 'bunker',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }] }] },
        sortOrder: i, source: null, sourceRef: null, license: null, attributes: null, version: 1,
        ...opts,
    };
}

function hole(n: number): Hole {
    return {
        id: `h${n}`, courseId: 'c1', number: n, par: 4, strokeIndex: null, notes: null,
        savedRegionJson: null, version: 1, createdAt: '', updatedAt: '',
    };
}

async function setup(rows: CourseFeature[]) {
    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);
    const router = new Router();
    router.navigate('/course/c1');
    di.set(Router, router);
    const detail = new CourseDetailService({} as never, {} as never);
    detail.holeStore.set([hole(1), hole(2)]);
    di.set(CourseDetailService, detail);
    const api = { listByCourse: async () => rows.map(r => structuredClone(r)) } as unknown as CourseFeaturesApi;
    const features = new FeaturesService(api);
    di.set(FeaturesService, features);
    await features.load('c1');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const dock = new ContextDockComponent({});
    dock.mount(host);
    mounted.push(dock);
    return { host, features, detail };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function stackRow(host: HTMLElement, id: string): HTMLElement {
    return host.querySelector<HTMLElement>(`[data-testid="stack-row"][data-feature-id="${id}"]`)!;
}

function click(el: HTMLElement, init: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
}

test('stack rows list topmost first; plain click selects one row', async () => {
    const { host, features } = await setup([row(0), row(1), row(2)]);
    const ids = [...host.querySelectorAll<HTMLElement>('[data-testid="stack-row"]')].map(el => el.dataset.featureId);
    expect(ids).toEqual(['f2', 'f1', 'f0']);

    click(stackRow(host, 'f1'));
    expect([...features.selectedIds.get()]).toEqual(['f1']);
    expect(stackRow(host, 'f1').classList.contains('selected')).toBe(true);
    click(stackRow(host, 'f0'));
    expect(stackRow(host, 'f1').classList.contains('selected')).toBe(false);
    expect(stackRow(host, 'f0').classList.contains('selected')).toBe(true);
});

test('Shift-click selects the range from the last clicked row', async () => {
    const { host, features } = await setup([0, 1, 2, 3, 4].map(i => row(i)));
    click(stackRow(host, 'f4'));
    click(stackRow(host, 'f1'), { shiftKey: true });
    expect([...features.selectedIds.get()].sort()).toEqual(['f1', 'f2', 'f3', 'f4']);
    for (const id of ['f1', 'f2', 'f3', 'f4']) expect(stackRow(host, id).classList.contains('selected')).toBe(true);
    expect(stackRow(host, 'f0').classList.contains('selected')).toBe(false);
});

test('Cmd/Ctrl-click toggles one row and moves the range anchor', async () => {
    const { host, features } = await setup([0, 1, 2, 3].map(i => row(i)));
    click(stackRow(host, 'f3'));
    click(stackRow(host, 'f1'), { metaKey: true });
    expect([...features.selectedIds.get()].sort()).toEqual(['f1', 'f3']);
    click(stackRow(host, 'f3'), { ctrlKey: true });
    expect([...features.selectedIds.get()]).toEqual(['f1']);
    // Anchor is now f3: Shift-click on f2 adds f3..f2.
    click(stackRow(host, 'f2'), { shiftKey: true });
    expect([...features.selectedIds.get()].sort()).toEqual(['f1', 'f2', 'f3']);
});

test('a type edit rewrites only that row; a geometry edit with the same point count touches nothing', async () => {
    const { host, features } = await setup([0, 1, 2].map(i => row(i)));
    const before = stackRow(host, 'f1');
    const touched = new Set<Element>();
    const observer = new MutationObserver(records => {
        for (const r of records) {
            const target = r.target instanceof Element ? r.target : r.target.parentElement;
            const el = target?.closest('[data-testid="stack-row"]');
            if (el) touched.add(el);
        }
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });

    features.store.patch({ ...features.store.item('f1').peek(), type: 'green' });
    await tick();
    expect(touched.size).toBe(1);
    expect(touched.has(before)).toBe(true);
    expect(before.querySelector('.stack-row__label')!.textContent).toBe('Green');
    expect(stackRow(host, 'f1')).toBe(before);

    touched.clear();
    const g = features.store.items.peek().find(f => f.id === 'f0')!.geometry;
    features.patchLocal('f0', { ...g, rings: [{ points: g.rings[0]!.points.map(p => ({ x: p.x + 1, y: p.y })) }] });
    await tick();
    observer.disconnect();
    expect(touched.size).toBe(0);
});

test('removing a feature drops its row; the same id added back gets a fresh row', async () => {
    const { host, features } = await setup([row(0), row(1)]);
    const old = stackRow(host, 'f1');
    features.store.remove('f1');
    await tick();
    expect(stackRow(host, 'f1')).toBeNull();
    features.store.add(row(1, { type: 'green' }));
    await tick();
    const fresh = stackRow(host, 'f1');
    expect(fresh).not.toBe(old);
    expect(fresh.querySelector('.stack-row__label')!.textContent).toBe('Green');
});

test('the per-feature eye hides the row without selecting it', async () => {
    const { host, features } = await setup([row(0)]);
    const el = stackRow(host, 'f0');
    click(el.querySelector<HTMLElement>('[data-testid="stack-row-eye"]')!);
    expect(features.hiddenIds.get().has('f0')).toBe(true);
    expect(features.selectedIds.get().size).toBe(0);
    expect(el.classList.contains('hidden')).toBe(true);
    features.showAll();
    expect(el.classList.contains('hidden')).toBe(false);
});

test('Draw panels survive a sub-mode switch and come back as the same elements', async () => {
    const { host } = await setup([row(0), row(1)]);
    const mode = di.get(EditorModeService);
    const rowEl = stackRow(host, 'f0');
    const panel = host.querySelector<HTMLElement>('[data-testid="stack-panel"]')!;

    mode.activeToolId.set(MEASURE_TOOL_ID);
    await tick();
    expect(panel.isConnected).toBe(true);
    expect((panel.closest('.ctx-dock__draw') as HTMLElement).style.display).toBe('none');

    mode.activeToolId.set(DRAW_TOOL_ID);
    await tick();
    expect(stackRow(host, 'f0')).toBe(rowEl);
    expect((panel.closest('.ctx-dock__draw') as HTMLElement).style.display).toBe('');
    expect(host.querySelectorAll('[data-testid="stack-panel"]').length).toBe(1);
});

test('the move-to-hole select is built once per hole list, not per selection change', async () => {
    const { host, features, detail } = await setup([row(0), row(1, { holeId: 'h1' }), row(2, { holeId: 'h2' })]);
    features.select('f0');
    await tick();
    const added: Node[] = [];
    const observer = new MutationObserver(records => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeName === 'OPTION') added.push(n);
    });
    observer.observe(host, { subtree: true, childList: true });

    features.select('f1');
    features.select('f0');
    await tick();
    expect(added.length).toBe(0);

    // Two holes selected: the "Mixed holes" entry appears, then goes.
    features.setSelection(['f1', 'f2']);
    await tick();
    const mixed = [...host.querySelectorAll('option')].find(o => o.value === '__mixed');
    expect(mixed?.textContent).toBe('Mixed holes');
    features.select('f1');
    await tick();
    expect([...host.querySelectorAll('option')].some(o => o.value === '__mixed')).toBe(false);

    observer.disconnect();
    detail.holeStore.set([hole(1), hole(2), hole(3)]);
    await tick();
    for (const select of host.querySelectorAll('select')) {
        expect([...select.options].map(o => o.value)).toEqual(['', 'h1', 'h2', 'h3']);
    }
});

test('the footer shows the draw tool notice as a quiet line', async () => {
    const { host } = await setup([row(0)]);
    const footer = host.querySelector<HTMLElement>('.ctx-dock__footer')!;
    expect(footer.textContent).toBe('1 feature · autosaves on close & edit');
    const tool = di.get(DrawToolService);
    tool.notice.set({ text: 'Deleted 2 features. Undo: Cmd+Z', until: Date.now() + 1000 });
    await tick();
    expect(footer.textContent).toBe('Deleted 2 features. Undo: Cmd+Z');
    expect(footer.classList.contains('error')).toBe(false);
    tool.notice.set(null);
    await tick();
    expect(footer.textContent).toBe('1 feature · autosaves on close & edit');
});
