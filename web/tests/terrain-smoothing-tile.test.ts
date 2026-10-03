import { afterEach, expect, test } from 'bun:test';
import { decodeTerrainRgb, smoothingSigmaPixels, smoothTerrainTile } from '../src/map/terrain-smoothing';
import { SmoothedTerrainRenderer } from '../src/map/terrain-smoothing-loader';

/** Deterministic Terrain-RGB RGBA bytes for tile (x, y): ridges, a fence line every 211 px, hash noise. */
function fixtureTile(x: number, y: number): Uint8ClampedArray<ArrayBuffer> {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
            const gx = x * 256 + px, gy = y * 256 + py;
            let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263);
            h = Math.imul(h ^ (h >>> 13), 1274126177);
            const noise = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
            const metres = 40 + 8 * Math.sin(gx / 97) + 5 * Math.cos(gy / 61) + 0.6 * noise + (gx % 211 === 0 ? 1.5 : 0);
            const value = Math.round((metres + 10000) * 10);
            const i = (py * 256 + px) * 4;
            rgba[i] = value >> 16; rgba[i + 1] = (value >> 8) & 255; rgba[i + 2] = value & 255; rgba[i + 3] = 255;
        }
    }
    return rgba;
}

function sha256(bytes: Uint8ClampedArray): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

/**
 * Golden RGBA hashes from the main-thread protocol handler before the worker
 * move (commit 690f1678), run on these fixtures with stubbed fetch and canvas.
 * `missing` tiles answered 404.
 */
const GOLDEN: { z: number; x: number; y: number; missing: string[]; hash: string }[] = [
    { z: 16, x: 35589, y: 19558, missing: [], hash: '61cb84f7afe1c84c58a7878d230d616bab046d08ca3e77820519230de107ab83' },
    { z: 17, x: 71178, y: 39116, missing: [], hash: '9838690bed0a703ff5c4cc1ab76a75d2e58dfa2c36622816a0ff623b407efa73' },
    { z: 18, x: 142356, y: 78232, missing: [], hash: '570b8ce4b22d3573e38be832a1b82b34bbea90a83594151764c325501f12c747' },
    {
        z: 17, x: 71178, y: 39116,
        missing: [key(17, 71177, 39115), key(17, 71178, 39115), key(17, 71179, 39115), key(17, 71177, 39116)],
        hash: 'b59400c5c941ad9873cb6c7b0c1c05d5f2e6ab2d47f875a465cc5fcdeeddfd14',
    },
];

test('pure body reproduces the pre-worker output byte for byte', () => {
    for (const { z, x, y, missing, hash } of GOLDEN) {
        const tiles = Array.from({ length: 9 }, (_, i) => {
            const tx = x + i % 3 - 1, ty = y + Math.floor(i / 3) - 1;
            return missing.includes(key(z, tx, ty)) ? null : decodeTerrainRgb(fixtureTile(tx, ty));
        });
        expect(sha256(smoothTerrainTile(tiles, smoothingSigmaPixels(z, y)))).toBe(hash);
    }
});

// Bun has no createImageBitmap or OffscreenCanvas. These stand-ins carry the
// fixture RGBA bytes through the decode path unchanged.
const saved = { fetch: globalThis.fetch, createImageBitmap: (globalThis as any).createImageBitmap, OffscreenCanvas: (globalThis as any).OffscreenCanvas };
afterEach(() => Object.assign(globalThis, saved));

function stubTileServer(missing: string[] = []) {
    const requests: string[] = [];
    const releases: (() => void)[] = [];
    let held: (tile: string) => boolean = () => false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const m = /\/terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(String(input))!;
        requests.push(key(+m[1], +m[2], +m[3]));
        if (held(key(+m[1], +m[2], +m[3]))) {
            await new Promise<void>((resolve, reject) => {
                releases.push(resolve);
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        }
        if (missing.includes(key(+m[1], +m[2], +m[3]))) return new Response(null, { status: 404 });
        return new Response(fixtureTile(+m[2], +m[3]));
    }) as typeof fetch;
    (globalThis as any).createImageBitmap = async (blob: Blob) =>
        ({ width: 256, height: 256, data: new Uint8ClampedArray(await blob.arrayBuffer()), close() {} });
    (globalThis as any).OffscreenCanvas = class {
        private data: Uint8ClampedArray | null = null;
        getContext() {
            return {
                drawImage: (bitmap: { data: Uint8ClampedArray }) => { this.data = bitmap.data; },
                getImageData: () => ({ data: this.data! }),
            };
        }
    };
    return {
        requests,
        hold(which: (tile: string) => boolean = () => true) { held = which; },
        release() { held = () => false; releases.splice(0).forEach(r => r()); },
    };
}

const href = (z: number, x: number, y: number) => `http://localhost/tiles/site/terrain/${z}/${x}/${y}.png?v=3`;

test('renderer fetches and decodes each tile once and matches the golden output', async () => {
    const { z, x, y, missing, hash } = GOLDEN[3];
    const server = stubTileServer(missing);
    const renderer = new SmoothedTerrainRenderer();
    expect(sha256((await renderer.render(href(z, x, y), new AbortController().signal))!)).toBe(hash);
    expect(server.requests.length).toBe(9);
    // Second render: decodes and 404s both come from the cache.
    expect(sha256((await renderer.render(href(z, x, y), new AbortController().signal))!)).toBe(hash);
    expect(server.requests.length).toBe(9);
    // The tile to the east shares six of its nine tiles.
    await renderer.render(href(z, x + 1, y), new AbortController().signal);
    expect(server.requests.length).toBe(12);
});

test('renderer passes tiles below the smoothing threshold through', async () => {
    stubTileServer();
    expect(await new SmoothedTerrainRenderer().render(href(12, 2224, 1222), new AbortController().signal)).toBeNull();
});

test('concurrent tiles share a neighbour fetch, and aborting one tile leaves the other intact', async () => {
    const shared = key(17, 71179, 39115);
    const server = stubTileServer();
    const expected = sha256((await new SmoothedTerrainRenderer().render(href(17, 71179, 39116), new AbortController().signal))!);
    server.requests.length = 0;
    const renderer = new SmoothedTerrainRenderer();
    server.hold(tile => tile === shared);
    const a = new AbortController();
    const first = renderer.render(href(17, 71178, 39116), a.signal);
    const second = renderer.render(href(17, 71179, 39116), new AbortController().signal);
    while (!server.requests.includes(shared)) await Bun.sleep(1);
    await Bun.sleep(1);
    a.abort();
    await expect(first).rejects.toThrow('Aborted');
    server.release();
    expect(sha256((await second)!)).toBe(expected);
    // Two 3x3 blocks offset by one column cover 12 tiles; each was fetched once.
    expect(server.requests.length).toBe(12);
    expect(new Set(server.requests).size).toBe(12);
});

test('aborting the only tile that wants a fetch aborts the fetch', async () => {
    const server = stubTileServer();
    const renderer = new SmoothedTerrainRenderer();
    server.hold();
    const controller = new AbortController();
    const pending = renderer.render(href(17, 71178, 39116), controller.signal);
    await Bun.sleep(0);
    controller.abort();
    await expect(pending).rejects.toThrow('Aborted');
    server.release();
    // The centre fetch was aborted rather than cached, so a new request fetches it again.
    await renderer.render(href(17, 71178, 39116), new AbortController().signal);
    expect(server.requests.filter(r => r === key(17, 71178, 39116)).length).toBe(2);
});
