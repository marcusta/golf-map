import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { PhotoStemsPanelComponent } from '../src/zones/photo-stems-panel.component';
import { PhotoStemsService } from '../src/zones/photo-stems.service';

// Acceptance A5 (web half): the Vegetation mode's "Find trees in photo" shows the photo stems the server
// proposes as rings on the map, a click on a ring skips that tree, and Accept sends the rest as accepted and
// the skipped as skipped. The real service and panel, the real api client; only the network is stubbed
// (server half: server/services/photo-stems.acceptance.test.ts). MapLibre does not run under happy-dom, so
// the map's side is the service's ring layer (what the map draws) and its toggle (what a click on a ring calls).

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; _reset(); di.reset(); });

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const PROPOSALS = [
    { id: 'epsg3006:477695.92:6457352.36', x: 477695.92, y: 6457352.36, heightM: 3.9, crownRadiusM: 1.0, kind: 2, source: 'ortho-shadow' },
    { id: 'epsg3006:477704.12:6457352.85', x: 477704.12, y: 6457352.85, heightM: 4.2, crownRadiusM: 1.1, kind: 2, source: 'ortho-shadow' },
    { id: 'epsg3006:477791.32:6457262.05', x: 477791.32, y: 6457262.05, heightM: 4.8, crownRadiusM: 1.3, kind: 0, source: 'ortho-shadow' },
];

function stubServer(): { accepted: unknown[] } {
    const accepted: unknown[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/photo-stems/propose')) {
            return Promise.resolve(json({ courseId: 'c1', proposals: PROPOSALS, calibration: { matched: 17 } }));
        }
        if (url.endsWith('/api/photo-stems/accept')) {
            accepted.push(JSON.parse(String(init?.body)));
            return Promise.resolve(json({ courseId: 'c1', accepted: 2, skipped: 1 }));
        }
        return Promise.resolve(json({}));
    }) as typeof fetch;
    return { accepted };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const byTestId = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rings = (svc: PhotoStemsService) =>
    svc.layer().features.map((f) => ({ id: f.properties.id as string, skipped: f.properties.skipped as boolean }));

test('find shows the proposals as rings, a click skips one, Accept sends the rest', async () => {
    const server = stubServer();
    const svc = new PhotoStemsService();
    di.set(PhotoStemsService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new PhotoStemsPanelComponent({}).mount(host);
    svc.courseId.set('c1');

    byTestId(host, 'photo-stems-find')!.click();
    await settle();
    expect(rings(svc)).toEqual(PROPOSALS.map((p) => ({ id: p.id, skipped: false })));
    expect(byTestId(host, 'photo-stems-count')!.textContent).toContain('3');

    svc.toggle(PROPOSALS[1]!.id);  // a click on the second ring
    expect(rings(svc).find((r) => r.id === PROPOSALS[1]!.id)!.skipped).toBe(true);
    expect(byTestId(host, 'photo-stems-count')!.textContent).toContain('2');

    byTestId(host, 'photo-stems-accept')!.click();
    await settle();
    expect(server.accepted).toEqual([{ courseId: 'c1', accept: [PROPOSALS[0]!.id, PROPOSALS[2]!.id], skip: [PROPOSALS[1]!.id] }]);
    expect(rings(svc)).toEqual([]);
});
