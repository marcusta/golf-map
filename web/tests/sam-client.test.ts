import { test, expect, describe } from 'bun:test';
import { SamClient, largestPolygon, SAM_CROP_SIZE, type FetchLike } from '../src/sam/sam-client';

// SAM sidecar client (T45) — /health and /segment contract tests against
// canned responses (the sidecar itself is a dev-workstation tool and never
// runs under bun test).

function fakeFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLike & { calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
    }) as FetchLike & { calls: typeof calls };
    fn.calls = calls;
    return fn;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SamClient /health', () => {
    test('healthy sidecar → true', async () => {
        const fetchFn = fakeFetch(() => json({ status: 'healthy', point_model: 'loaded' }));
        const client = new SamClient('http://sam.test', fetchFn);
        expect(await client.health()).toBe(true);
        expect(fetchFn.calls[0].url).toBe('http://sam.test/health');
    });

    test('non-200, wrong status body, and network errors → false (never throws)', async () => {
        expect(await new SamClient('http://sam.test', fakeFetch(() => json({}, 500))).health()).toBe(false);
        expect(await new SamClient('http://sam.test', fakeFetch(() => json({ status: 'loading' }))).health()).toBe(false);
        const dead = new SamClient('http://sam.test', () => Promise.reject(new Error('ECONNREFUSED')));
        expect(await dead.health()).toBe(false);
    });
});

describe('SamClient /segment contract', () => {
    test('POSTs the crop as JSON with zero offsets and parses polygons + confidence', async () => {
        const polygons = [[[10, 10], [200, 12], [180, 300]]];
        const fetchFn = fakeFetch(() => json({ polygons, confidence: 0.87 }));
        const client = new SamClient('http://sam.test', fetchFn);

        const result = await client.segmentPoint('BASE64JPEG');

        const call = fetchFn.calls[0];
        expect(call.url).toBe('http://sam.test/segment');
        expect(call.init?.method).toBe('POST');
        expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        // The crop is centered on the click, so the sidecar's point prompt
        // (crop center) needs no offsets — pinned to 0 by the contract.
        expect(JSON.parse(call.init?.body as string)).toEqual({ image: 'BASE64JPEG', offset_x: 0, offset_y: 0 });
        expect(result.polygons).toEqual(polygons);
        expect(result.confidence).toBe(0.87);
    });

    test('malformed response fields degrade to empty polygons / zero confidence', async () => {
        const client = new SamClient('http://sam.test', fakeFetch(() => json({ nonsense: true })));
        const result = await client.segmentPoint('X');
        expect(result.polygons).toEqual([]);
        expect(result.confidence).toBe(0);
    });

    test('HTTP errors throw (callers surface a notice and stay armed)', async () => {
        const client = new SamClient('http://sam.test', fakeFetch(() => json({ detail: 'boom' }, 500)));
        await expect(client.segmentPoint('X')).rejects.toThrow('SAM sidecar error: 500');
    });
});

describe('largestPolygon', () => {
    test('picks by shoelace AREA, not vertex count', () => {
        // A long, skinny, vertex-dense sliver vs a plain big square: the
        // prototype's point-count proxy would pick the sliver.
        const sliver = Array.from({ length: 50 }, (_, i) => [i * 4, i % 2 === 0 ? 0 : 1]);
        const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
        expect(largestPolygon([sliver, square])).toBe(square);
    });

    test('ignores degenerate polygons and handles the empty case', () => {
        expect(largestPolygon([])).toBeNull();
        expect(largestPolygon([[[1, 1], [2, 2]]])).toBeNull();
        const tri = [[0, 0], [10, 0], [0, 10]];
        expect(largestPolygon([[[1, 1], [2, 2]], tri])).toBe(tri);
    });
});

test('SAM_CROP_SIZE matches the sidecar MAX_INFERENCE_SIZE (512)', () => {
    expect(SAM_CROP_SIZE).toBe(512);
});
