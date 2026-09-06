import { afterAll, expect, test } from 'bun:test';
import { TreeStemsService } from '../src/map/tree-stems.service';

const valid = { version: 1, crs: 'EPSG:3006', fields: ['x', 'y', 'heightM', 'crownRadiusM', 'groundM'], trees: [[550000, 6460000, 20, 4, 75]] };
const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/slow') await Bun.sleep(60);
    if (path === '/bad') return Response.json({ ...valid, trees: [[550000, 6460000, -1, 4, 75]] });
    if (path === '/missing') return new Response('missing', { status: 404 });
    if (path === '/v2') return Response.json({ ...valid, version: 2, fields: [...valid.fields, 'kind'], trees: [[550000, 6460000, 20, 4, 75, 1]] });
    return Response.json(path === '/empty' ? { ...valid, trees: [] } : valid);
} });
afterAll(() => server.stop(true));
async function settled(service: TreeStemsService) {
    for (let n = 0; n < 200 && service.loading.peek(); n++) await Bun.sleep(5);
    expect(service.loading.peek()).toBe(false);
}

test('real asset loading preserves empty success and rejects corrupt or missing data for polygon fallback', async () => {
    const service = new TreeStemsService();
    service.configure(`${server.url}valid`);
    await settled(service);
    expect(service.stems.peek()).toEqual([{ x: 550000, y: 6460000, heightM: 20, crownRadiusM: 4, groundM: 75, kind: 2 }]);
    service.configure(`${server.url}v2`);
    await settled(service);
    expect(service.stems.peek()).toEqual([{ x: 550000, y: 6460000, heightM: 20, crownRadiusM: 4, groundM: 75, kind: 1 }]);
    service.configure(`${server.url}empty`);
    await settled(service);
    expect(service.stems.peek()).toEqual([]);
    for (const path of ['bad', 'missing']) {
        service.configure(`${server.url}${path}`);
        await settled(service);
        expect(service.stems.peek()).toBeNull();
        expect(service.error.peek()).not.toBeNull();
    }
    service.configure(null);
});

test('course changes abort stale asset loads, including teardown during a request', async () => {
    const service = new TreeStemsService();
    service.configure(`${server.url}slow`);
    service.configure(`${server.url}empty`);
    await settled(service);
    await Bun.sleep(80);
    expect(service.stems.peek()).toEqual([]);
    service.configure(`${server.url}slow`);
    service.configure(null);
    await Bun.sleep(80);
    expect(service.stems.peek()).toBeNull();
    expect(service.loading.peek()).toBe(false);
    expect(service.error.peek()).toBeNull();
});
