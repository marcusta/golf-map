import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { PhotoStemsPanelComponent } from '../src/zones/photo-stems-panel.component';
import { PhotoStemsService } from '../src/zones/photo-stems.service';

// The Trees in photo panel beyond the frozen acceptance case (photo-stems.acceptance.test.ts): the real service,
// panel and api client; only the network is stubbed.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; _reset(); di.reset(); });

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const PROPOSALS = [
    { id: 'epsg3006:477695.92:6457352.36', x: 477695.92, y: 6457352.36, heightM: 3.9, crownRadiusM: 1.0, kind: 2, source: 'ortho-shadow' },
    { id: 'epsg3006:477704.12:6457352.85', x: 477704.12, y: 6457352.85, heightM: 4.2, crownRadiusM: 1.1, kind: 2, source: 'ortho-shadow' },
];
const settle = () => new Promise((r) => setTimeout(r, 0));

test('with every ring skipped Accept still saves the skips, so they are not offered again', async () => {
    const sent: unknown[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/photo-stems/propose')) return Promise.resolve(json({ courseId: 'c1', summer: 'orto-l2-2025', proposals: PROPOSALS, calibration: { matched: 17 } }));
        if (url.endsWith('/api/photo-stems/accept')) {
            sent.push(JSON.parse(String(init?.body)));
            return Promise.resolve(json({ courseId: 'c1', accepted: 5, skipped: 2, acceptedNow: 0, skippedNow: 2, path: 'x' }));
        }
        return Promise.resolve(json({}));
    }) as typeof fetch;
    const svc = new PhotoStemsService();
    di.set(PhotoStemsService, svc);
    const host = document.createElement('div');
    document.body.appendChild(host);
    new PhotoStemsPanelComponent({}).mount(host);
    svc.courseId.set('c1');
    host.querySelector<HTMLElement>('[data-testid="photo-stems-find"]')!.click();
    await settle();

    for (const p of PROPOSALS) svc.toggle(p.id);
    const accept = host.querySelector<HTMLButtonElement>('[data-testid="photo-stems-accept"]')!;
    expect(accept.disabled).toBe(false);
    accept.click();
    await settle();

    expect(sent).toEqual([{ courseId: 'c1', accept: [], skip: PROPOSALS.map((p) => p.id) }]);
    expect(host.textContent).toContain('2 skipped, not offered again');
});
