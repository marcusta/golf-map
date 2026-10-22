import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { BunkerProposalsPanelComponent } from '../src/draw/bunker-proposals-panel.component';
import { BunkerProposalsService } from '../src/draw/bunker-proposals.service';
import { outlineToBspline, OUTLINE_FIT_TOLERANCE_M } from '../src/geo/outline-fit';
import { flattenRing } from '../src/geo/bezier';

// The Find bunkers panel: the real service, panel and api client; only the network is stubbed. MapLibre does not run
// here, so the map side is the service's layer() and proposalAt(). Adding (FeaturesService.createMany) is the same
// createMany + one history entry as the SAM tool; the server side is server/services/bunker-proposals.service.test.ts.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; _reset(); di.reset(); });

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const E0 = 541200, N0 = 6468000;
const square = (x: number, y: number, r: number): [number, number][] =>
    [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]].map(([dx, dy]) => [E0 + dx!, N0 + dy!] as [number, number]);
const proposal = (id: string, x: number, y: number, r: number, holeNumber: number | null) => ({
    id, ring: square(x, y, r), lonLat: square(x, y, r).map(([a, b]) => [a / 1e5, b / 1e5]), areaM2: 4 * r * r,
    confidence: 0.9, edge: 'nir', holeId: holeNumber ? `h${holeNumber}` : null, holeNumber,
});
const PROPOSALS = [proposal('bk-a', 0, 0, 3, 1), proposal('bk-b', 0, 0, 10, 2), proposal('bk-c', 100, 0, 3, null)];
const settle = () => new Promise((r) => setTimeout(r, 0));

function mount(onSkip: (body: unknown) => void = () => {}) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/bunker-proposals/propose')) {
            return Promise.resolve(json({
                courseId: 'c1', siteId: 's1', collection: 'orto-l2-2025', proposals: PROPOSALS,
                left: { drawn: 3, notCourse: 1, small: 0, skipped: 1 }, predicted: true, seconds: 4, dryRun: false,
            }));
        }
        if (url.endsWith('/api/bunker-proposals/skip')) {
            onSkip(JSON.parse(String(init?.body)));
            return Promise.resolve(json({ skipped: 2, skippedNow: 1 }));
        }
        return Promise.resolve(json({}));
    }) as typeof fetch;
    const svc = new BunkerProposalsService();
    di.set(BunkerProposalsService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new BunkerProposalsPanelComponent({}).mount(host);
    return { svc, host };
}

test('Find shows how many bunkers Add makes and what was left out', async () => {
    const { svc, host } = mount();
    svc.open('c1');
    host.querySelector<HTMLElement>('[data-testid="bunker-find-find"]')!.click();
    await settle();
    expect(host.querySelector('[data-testid="bunker-find-count"]')!.textContent).toBe('3 to add');
    expect(host.textContent).toContain('4 drawn or skipped left out');
    svc.toggle('bk-c');
    expect(host.querySelector('[data-testid="bunker-find-count"]')!.textContent).toBe('2 to add');
});

test('a click inside nested outlines picks the smallest, and the layer marks it skipped', async () => {
    const { svc } = mount();
    svc.open('c1');
    await svc.find();
    expect(svc.proposalAt(E0 + 1, N0 + 1)).toBe('bk-a');
    expect(svc.proposalAt(E0 + 8, N0 + 8)).toBe('bk-b');
    expect(svc.proposalAt(E0 + 50, N0)).toBeNull();
    svc.toggle('bk-a');
    const props = svc.layer().features.map((f) => [f.properties.id, f.properties.skipped, f.properties.hole]);
    expect(props).toEqual([['bk-a', true, 1], ['bk-b', false, 2], ['bk-c', false, null]]);
    // Closed rings for MapLibre.
    const ring = svc.layer().features[0]!.geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]!);
});

test('Add refuses while Draw holds no features of this course: nothing added, no skips sent', async () => {
    const sent: unknown[] = [];
    const { svc, host } = mount((b) => sent.push(b));
    svc.open('c1');
    await svc.find();
    svc.toggle('bk-c');
    await svc.add();
    expect(host.textContent).toContain('Open the course in Draw first');
    expect(sent).toEqual([]);
    expect(svc.proposals.peek()).toHaveLength(3);
});

test('the outline fit makes a B-spline bunker within the fit tolerance of its sand edge', () => {
    // A 10 x 6 m ellipse traced at the photo's 0.16 m, as the NIR edge comes back.
    const ring = Array.from({ length: 160 }, (_, i) => {
        const a = (2 * Math.PI * i) / 160;
        return { x: E0 + 10 * Math.cos(a), y: N0 + 6 * Math.sin(a) };
    });
    const g = outlineToBspline(ring)!;
    expect(g.curveType).toBe('bspline');
    const flat = flattenRing(g.rings[0]!, 0.01, 'bspline');
    const off = Math.max(...flat.map(([x, y]) => {
        const a = Math.atan2((y - N0) / 6, (x - E0) / 10);
        return Math.hypot(x - (E0 + 10 * Math.cos(a)), y - (N0 + 6 * Math.sin(a)));
    }));
    expect(off).toBeLessThan(OUTLINE_FIT_TOLERANCE_M + 0.05);
    expect(outlineToBspline([{ x: 0, y: 0 }, { x: 0.1, y: 0 }])).toBeNull();
});
