import { decodeTerrainRgb, neighbourTilePath, parseTerrainTilePath, smoothingSigmaPixels, smoothTerrainTile, TERRAIN_TILE_SIZE as SIZE } from './terrain-smoothing';

/** Retained decodes: 64 tiles of 256 KiB elevations, 16 MiB. URLs include the dataset version. */
const CACHE_TILES = 64;

/** Below this sigma the Gaussian changes less than Terrain-RGB precision; the tile passes through. */
export const MIN_SMOOTHING_SIGMA = 0.3;

export function abortError(): DOMException {
    return new DOMException('Aborted', 'AbortError');
}

/** Resolves when `promise` does, or rejects as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

async function fetchElevations(url: string, signal: AbortSignal): Promise<Float32Array | null> {
    const response = await fetch(url, { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Terrain tile: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
        signal.throwIfAborted();
        if (bitmap.width !== SIZE || bitmap.height !== SIZE) throw new Error('Expected 256px terrain tile');
        const ctx = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        return decodeTerrainRgb(ctx.getImageData(0, 0, SIZE, SIZE).data);
    } finally {
        bitmap.close();
    }
}

interface InFlight { promise: Promise<Float32Array | null>; controller: AbortController; users: number }

/**
 * Fetches, decodes and smooths display terrain tiles. One instance runs in the
 * terrain worker; the main thread builds its own only when no worker can run.
 */
export class SmoothedTerrainRenderer {
    /** Completed decodes in LRU order; null records a 404 (outside coverage). */
    private readonly decoded = new Map<string, Float32Array | null>();
    /** Shared fetches: a neighbour needed by several tiles is fetched once. */
    private readonly inFlight = new Map<string, InFlight>();
    /** Network fetches started, for profiling. */
    fetches = 0;

    /** Aborting one caller drops its share; the fetch aborts when no caller is left. */
    private readTile(url: string, signal: AbortSignal): Promise<Float32Array | null> {
        if (signal.aborted) return Promise.reject(abortError());
        if (this.decoded.has(url)) {
            const cached = this.decoded.get(url)!;
            this.decoded.delete(url);
            this.decoded.set(url, cached);
            return Promise.resolve(cached);
        }
        let entry = this.inFlight.get(url);
        if (!entry) {
            const controller = new AbortController();
            this.fetches++;
            const promise = fetchElevations(url, controller.signal).then(heights => {
                this.decoded.set(url, heights);
                while (this.decoded.size > CACHE_TILES) this.decoded.delete(this.decoded.keys().next().value!);
                return heights;
            }).finally(() => {
                if (this.inFlight.get(url) === entry) this.inFlight.delete(url);
            });
            entry = { promise, controller, users: 0 };
            this.inFlight.set(url, entry);
            promise.catch(() => {});
        }
        const shared = entry;
        shared.users++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            if (--shared.users === 0 && this.inFlight.get(url) === shared) {
                this.inFlight.delete(url);
                shared.controller.abort();
            }
        };
        signal.addEventListener('abort', release, { once: true });
        return raceAbort(shared.promise, signal).finally(() => {
            signal.removeEventListener('abort', release);
            if (!signal.aborted) release();
        });
    }

    /**
     * Smoothed Terrain-RGB RGBA bytes for an absolute tile URL, or null when
     * the tile is below the smoothing threshold and should pass through.
     */
    async render(href: string, signal: AbortSignal): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
        const url = new URL(href);
        const tile = parseTerrainTilePath(url.pathname);
        if (!tile) throw new Error('Invalid display terrain URL');
        const sigma = smoothingSigmaPixels(tile.z, tile.y);
        if (sigma < MIN_SMOOTHING_SIGMA) return null;
        if (Math.ceil(3 * sigma) > SIZE) throw new Error('Display terrain zoom exceeds smoothing support');
        const centre = await this.readTile(url.href, signal);
        if (!centre) throw new Error('Terrain tile not found');
        const tiles: (Float32Array | null)[] = Array(9).fill(null);
        tiles[4] = centre;
        await Promise.all(tiles.map(async (_, i) => {
            if (i === 4) return;
            const path = neighbourTilePath(tile, i % 3 - 1, Math.floor(i / 3) - 1);
            if (!path) return;
            const neighbour = new URL(url);
            neighbour.pathname = path;
            tiles[i] = await this.readTile(neighbour.href, signal);
        }));
        signal.throwIfAborted();
        return smoothTerrainTile(tiles, sigma);
    }
}
