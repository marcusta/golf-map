import { test, expect } from 'bun:test';
import {
    ElevationService,
    LruCache,
    decodeTerrainRgb,
    bilinearElevation,
    lngLatToTilePixel,
    type DecodedTile,
    type TileFetcher,
} from '../src/map/elevation.service';

// ── Synthetic tile construction (no network, raw RGBA arrays) ─────────────

/** Encode a height (m) into Terrain-RGB [r, g, b]. */
function encodeHeight(height: number): [number, number, number] {
    const v = Math.round((height + 10000) / 0.1);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Build a DecodedTile where pixel (x, y) has height heightAt(x, y). */
function syntheticTile(width: number, height: number, heightAt: (x: number, y: number) => number): DecodedTile {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = encodeHeight(heightAt(x, y));
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

// ── decodeTerrainRgb ──────────────────────────────────────────────────────

test('decodeTerrainRgb implements -10000 + (R*65536 + G*256 + B) * 0.1', () => {
    expect(decodeTerrainRgb(0, 0, 0)).toBe(-10000);
    expect(decodeTerrainRgb(1, 134, 160)).toBeCloseTo(-10000 + (65536 + 134 * 256 + 160) * 0.1, 6);
    // round-trip a realistic Landeryd height
    const [r, g, b] = encodeHeight(72.4);
    expect(decodeTerrainRgb(r, g, b)).toBeCloseTo(72.4, 1);
});

// ── bilinearElevation ─────────────────────────────────────────────────────

test('bilinear interpolation blends the 4 neighboring pixels', () => {
    // 2x2 tile: heights 10 20 / 30 40 (pixel centers at 0.5, 1.5)
    const tile = syntheticTile(2, 2, (x, y) => 10 + x * 10 + y * 20);
    // dead center of the tile → average of all four
    expect(bilinearElevation(tile, 1, 1)).toBeCloseTo(25, 6);
    // exactly on a pixel center → that pixel's value
    expect(bilinearElevation(tile, 0.5, 0.5)).toBeCloseTo(10, 6);
    expect(bilinearElevation(tile, 1.5, 1.5)).toBeCloseTo(40, 6);
    // halfway between the two top pixels
    expect(bilinearElevation(tile, 1, 0.5)).toBeCloseTo(15, 6);
});

test('bilinear interpolation clamps at tile edges', () => {
    const tile = syntheticTile(2, 2, (x, y) => 10 + x * 10 + y * 20);
    expect(bilinearElevation(tile, 0, 0)).toBeCloseTo(10, 6); // beyond top-left center
    expect(bilinearElevation(tile, 2, 2)).toBeCloseTo(40, 6); // beyond bottom-right center
});

// ── lngLatToTilePixel ─────────────────────────────────────────────────────

test('lngLatToTilePixel maps lng/lat to XYZ tile + fractional pixel', () => {
    // Null island at z1 sits exactly at the corner of tile (1, 1)
    const p = lngLatToTilePixel(0, 0, 1);
    expect(p.tileX).toBe(1);
    expect(p.tileY).toBe(1);
    expect(p.px).toBeCloseTo(0, 6);
    expect(p.py).toBeCloseTo(0, 6);

    // Landeryd at z17 lands in a plausible tile (Sweden: x ~ half-way east, y northern third)
    const q = lngLatToTilePixel(15.7222, 58.3571, 17);
    expect(q.tileX).toBe(Math.floor(((15.7222 + 180) / 360) * 2 ** 17));
    expect(q.px).toBeGreaterThanOrEqual(0);
    expect(q.px).toBeLessThan(256);
    expect(q.py).toBeGreaterThanOrEqual(0);
    expect(q.py).toBeLessThan(256);
});

// ── LruCache ──────────────────────────────────────────────────────────────

test('LruCache evicts the least recently used entry past capacity', () => {
    const lru = new LruCache<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a'); // refresh a — b is now oldest
    lru.set('c', 3);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.size).toBe(2);
});

// ── ElevationService ──────────────────────────────────────────────────────

const CONFIG = { mapKey: 'c1', zoom: 17, version: 'V1' };

function fakeFetcher(heightAt: (x: number, y: number) => number, opts?: { missing?: boolean; fail?: boolean }) {
    const urls: string[] = [];
    const fetchTile: TileFetcher = async (url: string) => {
        urls.push(url);
        if (opts?.fail) throw new Error('network down');
        if (opts?.missing) return null;
        return syntheticTile(256, 256, heightAt);
    };
    return { fetchTile, urls };
}

test('elevationAt fetches the right versioned tile URL and decodes heights', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 72.4);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);

    const elevation = await svc.elevationAt({ lng: 15.7222, lat: 58.3571 });

    expect(elevation).toBeCloseTo(72.4, 1);
    const { tileX, tileY } = lngLatToTilePixel(15.7222, 58.3571, 17);
    expect(urls).toEqual([`/tiles/c1/terrain/17/${tileX}/${tileY}.png?v=V1`]);
});

test('decoded tiles are cached — repeated samples in one tile fetch once', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 60);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);

    await svc.elevationAt({ lng: 15.7222, lat: 58.3571 });
    await svc.elevationAt({ lng: 15.72221, lat: 58.35711 }); // same tile
    expect(urls.length).toBe(1);
});

test('concurrent samples of one tile share a single in-flight fetch', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 60);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);

    const [a, b] = await Promise.all([
        svc.elevationAt({ lng: 15.7222, lat: 58.3571 }),
        svc.elevationAt({ lng: 15.7222, lat: 58.3571 }),
    ]);
    expect(a).toBeCloseTo(60, 1);
    expect(b).toBeCloseTo(60, 1);
    expect(urls.length).toBe(1);
});

test('elevationAtSync returns null on cache miss, kicks a fetch, then answers', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 85.2);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);
    const pos = { lng: 15.7222, lat: 58.3571 };

    expect(svc.elevationAtSync(pos)).toBeNull(); // miss — background fetch kicked
    expect(urls.length).toBe(1);

    await svc.elevationAt(pos); // settles the same in-flight fetch
    expect(svc.elevationAtSync(pos)).toBeCloseTo(85.2, 1);
    expect(urls.length).toBe(1); // still just one fetch
});

test('missing tiles (404 → null) return null and are cached as permanent misses', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 0, { missing: true });
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);
    const pos = { lng: 15.7222, lat: 58.3571 };

    expect(await svc.elevationAt(pos)).toBeNull();
    expect(await svc.elevationAt(pos)).toBeNull();
    expect(urls.length).toBe(1); // no refetch storm for out-of-coverage tiles
    expect(svc.elevationAtSync(pos)).toBeNull();
});

test('transient fetch failures are not cached — the next sample retries', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 0, { fail: true });
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);
    const pos = { lng: 15.7222, lat: 58.3571 };

    expect(await svc.elevationAt(pos)).toBeNull();
    expect(await svc.elevationAt(pos)).toBeNull();
    expect(urls.length).toBe(2); // retried
});

test('unconfigured service answers null without fetching', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 60);
    const svc = new ElevationService(fetchTile);

    expect(await svc.elevationAt({ lng: 15.7222, lat: 58.3571 })).toBeNull();
    expect(svc.elevationAtSync({ lng: 15.7222, lat: 58.3571 })).toBeNull();
    expect(urls.length).toBe(0);
});

test('configure(null) tears down and clears the cache', async () => {
    const { fetchTile } = fakeFetcher(() => 60);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);
    const pos = { lng: 15.7222, lat: 58.3571 };
    await svc.elevationAt(pos);

    svc.configure(null);
    expect(svc.elevationAtSync(pos)).toBeNull();
    expect(await svc.elevationAt(pos)).toBeNull();
});

test('sampleLine returns n evenly spaced samples inclusive of endpoints', async () => {
    // Height varies with pixel x so the line has a gradient
    const { fetchTile } = fakeFetcher(x => 50 + x / 25.6);
    const svc = new ElevationService(fetchTile);
    svc.configure(CONFIG);

    const a = { lng: 15.7222, lat: 58.3571 };
    const b = { lng: 15.7230, lat: 58.3575 };
    const samples = await svc.sampleLine(a, b, 5);

    expect(samples.length).toBe(5);
    expect(samples[0].lng).toBeCloseTo(a.lng, 10);
    expect(samples[0].lat).toBeCloseTo(a.lat, 10);
    expect(samples[4].lng).toBeCloseTo(b.lng, 10);
    expect(samples[4].lat).toBeCloseTo(b.lat, 10);
    expect(samples[2].lng).toBeCloseTo((a.lng + b.lng) / 2, 10);
    for (const s of samples) {
        expect(s.elevation).not.toBeNull();
        expect(s.elevation!).toBeGreaterThan(49);
        expect(s.elevation!).toBeLessThan(61);
    }
});
