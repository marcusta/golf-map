import { test, expect } from 'bun:test';
import {
    CanopyService,
    decodeCanopyHeight,
    bilinearCanopyHeight,
} from '../src/map/canopy.service';
import { lngLatToTilePixel, type DecodedTile, type TileFetcher } from '../src/map/elevation.service';

// ── Synthetic tile construction (no network, raw RGBA arrays) ─────────────

/** Encode a height (m) into Terrain-RGB [r, g, b] — the pipeline's canopy encoding. */
function encodeHeight(height: number): [number, number, number] {
    const v = Math.round((height + 10000) / 0.1);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

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

// ── decodeCanopyHeight ────────────────────────────────────────────────────

test('decodeCanopyHeight decodes Terrain-RGB and treats 0 m as no canopy', () => {
    // 0 m canopy is the standard Terrain-RGB zero pixel.
    expect(decodeCanopyHeight(1, 134, 160)).toBeCloseTo(0, 6);
    const [r, g, b] = encodeHeight(18.5);
    expect(decodeCanopyHeight(r, g, b)).toBeCloseTo(18.5, 1);
});

test('decodeCanopyHeight clamps nodata (black → -10000) to 0', () => {
    expect(decodeCanopyHeight(0, 0, 0)).toBe(0);
});

// ── bilinearCanopyHeight ──────────────────────────────────────────────────

test('bilinearCanopyHeight blends crown into ground and never goes negative', () => {
    // Left column 20 m crown, right column bare ground.
    const tile = syntheticTile(2, 2, x => (x === 0 ? 20 : 0));
    expect(bilinearCanopyHeight(tile, 0.5, 1)).toBeCloseTo(20, 6);
    expect(bilinearCanopyHeight(tile, 1, 1)).toBeCloseTo(10, 6);
    expect(bilinearCanopyHeight(tile, 1.5, 1)).toBeCloseTo(0, 6);

    // Nodata black pixels decode far below zero; the helper floors at 0.
    const black: DecodedTile = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) };
    expect(bilinearCanopyHeight(black, 0.5, 0.5)).toBe(0);
});

// ── CanopyService ─────────────────────────────────────────────────────────

const CONFIG = { mapKey: 'c1', zoom: 17, version: 'V1' };

function fakeFetcher(heightAt: (x: number, y: number) => number, opts?: { missing?: boolean }) {
    const urls: string[] = [];
    const fetchTile: TileFetcher = async (url: string) => {
        urls.push(url);
        if (opts?.missing) return null;
        return syntheticTile(256, 256, heightAt);
    };
    return { fetchTile, urls };
}

test('heightAt fetches the versioned canopy tile (not terrain) and decodes height', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 14.2);
    const svc = new CanopyService(fetchTile);
    svc.configure(CONFIG);

    const h = await svc.heightAt({ lng: 15.7222, lat: 58.3571 });

    expect(h).toBeCloseTo(14.2, 1);
    const { tileX, tileY } = lngLatToTilePixel(15.7222, 58.3571, 17);
    expect(urls).toEqual([`/tiles/c1/canopy/17/${tileX}/${tileY}.png?v=V1`]);
    expect(svc.available).toBe(true);
});

test('unconfigured service (course without lidar) answers null without fetching', async () => {
    const { fetchTile, urls } = fakeFetcher(() => 9);
    const svc = new CanopyService(fetchTile);

    expect(svc.available).toBe(false);
    expect(await svc.heightAt({ lng: 15.7222, lat: 58.3571 })).toBeNull();
    expect(svc.heightAtSync({ lng: 15.7222, lat: 58.3571 })).toBeNull();
    expect(urls).toEqual([]);

    svc.configure(CONFIG);
    svc.configure(null);
    expect(svc.available).toBe(false);
    expect(await svc.heightAt({ lng: 15.7222, lat: 58.3571 })).toBeNull();
    expect(urls).toEqual([]);
});

test('missing canopy tiles (404) return null; heightAtSync answers after the fetch lands', async () => {
    const missing = new CanopyService(fakeFetcher(() => 5, { missing: true }).fetchTile);
    missing.configure(CONFIG);
    expect(await missing.heightAt({ lng: 15.7222, lat: 58.3571 })).toBeNull();

    const { fetchTile, urls } = fakeFetcher(() => 7.5);
    const svc = new CanopyService(fetchTile);
    svc.configure(CONFIG);
    const p = { lng: 15.7222, lat: 58.3571 };
    expect(svc.heightAtSync(p)).toBeNull(); // cache miss → kicks the fetch
    await svc.heightAt(p);
    expect(svc.heightAtSync(p)).toBeCloseTo(7.5, 1);
    expect(urls).toHaveLength(1);
});

test('sampleLine reports canopy height per point, floored at 0', async () => {
    const { fetchTile } = fakeFetcher(() => 3);
    const svc = new CanopyService(fetchTile);
    svc.configure(CONFIG);
    const samples = await svc.sampleLine({ lng: 15.7222, lat: 58.3571 }, { lng: 15.7223, lat: 58.3571 }, 3);
    expect(samples).toHaveLength(3);
    expect(samples[0].lng).toBeCloseTo(15.7222, 6);
    expect(samples[2].lng).toBeCloseTo(15.7223, 6);
    for (const s of samples) expect(s.height).toBeCloseTo(3, 1);
});
