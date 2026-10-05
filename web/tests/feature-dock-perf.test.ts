import { test, expect, afterEach } from 'bun:test';
import { Router, di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ContextDockComponent } from '../src/draw/feature-dock.component';
import { ServerModeService } from '../src/app/server-mode.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { Hole } from '../../shared/api/holes.gen';

// Review item 28: one local geometry edit must not re-render the whole
// feature stack. 2000 hand-drawn course-level features, one patchLocal on
// the selected feature, then count the stack rows and selection-panel
// options the DOM saw change.

const N = 2000;

const mounted: ContextDockComponent[] = [];
afterEach(() => {
    for (const c of mounted.splice(0)) c.destroy();
    document.body.textContent = '';
    _reset();
    di.reset();
});

function row(i: number): CourseFeature {
    const x = (i % 50) * 30, y = Math.floor(i / 50) * 30;
    return {
        id: `f${i}`, courseId: 'c1', holeId: null, type: i % 2 ? 'bunker' : 'rough',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x, y }, { x: x + 10, y }, { x: x + 10, y: y + 10 }, { x, y: y + 10 }] }] },
        sortOrder: i, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    };
}

async function setup() {
    const serverMode = new ServerModeService();
    serverMode.mode.set('builder');
    di.set(ServerModeService, serverMode);
    const router = new Router();
    router.navigate('/course/c1');
    di.set(Router, router);
    const detail = new CourseDetailService({} as never, {} as never);
    detail.holeStore.set(Array.from({ length: 18 }, (_, i) => ({
        id: `h${i + 1}`, courseId: 'c1', number: i + 1, par: 4, strokeIndex: null, notes: null,
        savedRegionJson: null, version: 1, createdAt: '', updatedAt: '',
    } satisfies Hole)));
    di.set(CourseDetailService, detail);
    const rows = Array.from({ length: N }, (_, i) => row(i));
    const api = { listByCourse: async () => rows.map(r => structuredClone(r)) } as unknown as CourseFeaturesApi;
    const features = new FeaturesService(api);
    di.set(FeaturesService, features);
    await features.load('c1');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const dock = new ContextDockComponent({});
    dock.mount(host);
    mounted.push(dock);
    return { host, features };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('one patchLocal on 2000 features re-renders at most the edited row', async () => {
    const { host, features } = await setup();
    const rowsHost = host.querySelector<HTMLElement>('[data-testid="stack-panel-rows"]')!;
    expect(rowsHost.querySelectorAll('[data-testid="stack-row"]').length).toBe(N);

    features.select('f1999'); // topmost row, selection panel shown
    await tick();

    const touchedRows = new Set<Element>();
    let optionsAdded = 0;
    let footerWrites = 0;
    const observer = new MutationObserver(records => {
        for (const r of records) {
            const target = r.target instanceof Element ? r.target : r.target.parentElement;
            const stackRow = target?.closest('[data-testid="stack-row"]');
            if (stackRow) touchedRows.add(stackRow);
            for (const n of r.addedNodes) if (n.nodeName === 'OPTION') optionsAdded++;
            if (target?.closest('.ctx-dock__footer')) footerWrites++;
        }
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });

    const current = features.store.items.peek().find(f => f.id === 'f1999')!;
    const ring = current.geometry.rings[0]!;
    const moved = {
        ...current.geometry,
        rings: [{ ...ring, points: ring.points.map((p, i) => i === 0 ? { x: p.x + 1, y: p.y } : p) }],
    };
    const t0 = performance.now();
    features.patchLocal('f1999', moved);
    const syncMs = performance.now() - t0;
    await tick();
    const settleMs = performance.now() - t0;
    observer.disconnect();

    console.log(`[item 28 bench] N=${N} patchLocal sync=${syncMs.toFixed(2)} ms settle=${settleMs.toFixed(2)} ms `
        + `stackRowsTouched=${touchedRows.size} optionsAdded=${optionsAdded} footerMutations=${footerWrites}`);
    expect(touchedRows.size).toBeLessThanOrEqual(1);
    expect(optionsAdded).toBe(0);
    expect(footerWrites).toBe(0);
});
