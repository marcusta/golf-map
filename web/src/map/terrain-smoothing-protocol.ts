import type { AddProtocolAction } from 'maplibre-gl';
import { parseTerrainTilePath, smoothingSigmaPixels, TERRAIN_SMOOTHING_PROTOCOL } from './terrain-smoothing';
import { abortError, MIN_SMOOTHING_SIGMA, SmoothedTerrainRenderer } from './terrain-smoothing-loader';

export type TerrainWorkerRequest = { type: 'render'; id: number; href: string } | { type: 'abort'; id: number };
export type TerrainWorkerReply =
    | { id: number; bitmap: ImageBitmap }
    | { id: number; pixels: ArrayBuffer }
    | { id: number; error: string }
    | { id: number; unsupported: true };

interface Pending { href: string; signal: AbortSignal; resolve: (bitmap: ImageBitmap) => void; reject: (error: unknown) => void }

/**
 * Main-thread side of the terrain worker: a request id map and nothing else.
 * One worker, not a pool: a z17 tile costs a few ms of worker CPU, and one
 * worker keeps one decode cache, so a neighbour decoded for one tile serves
 * the next tile instead of being fetched and decoded again in a second worker.
 */
class TerrainWorkerClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    /** Set when no worker can run (no Worker, script failed, or no OffscreenCanvas in workers). */
    private fallback: SmoothedTerrainRenderer | null = null;

    render(href: string, signal: AbortSignal): Promise<ImageBitmap> {
        if (signal.aborted) return Promise.reject(abortError());
        if (this.fallback || !this.start()) return this.renderHere(href, signal);
        return new Promise<ImageBitmap>((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { href, signal, resolve, reject });
            signal.addEventListener('abort', () => {
                if (!this.pending.delete(id)) return;
                this.worker?.postMessage({ type: 'abort', id } satisfies TerrainWorkerRequest);
                reject(abortError());
            }, { once: true });
            this.worker!.postMessage({ type: 'render', id, href } satisfies TerrainWorkerRequest);
        });
    }

    private start(): boolean {
        if (this.worker) return true;
        if (typeof Worker === 'undefined') return false;
        try {
            this.worker = new Worker(new URL('./terrain-smoothing.worker.ts', import.meta.url), { type: 'module' });
        } catch {
            return false;
        }
        this.worker.onmessage = (event: MessageEvent<TerrainWorkerReply>) => this.onReply(event.data);
        this.worker.onerror = () => this.useFallback();
        return true;
    }

    private onReply(message: TerrainWorkerReply): void {
        const request = this.pending.get(message.id);
        if (!request) {
            if ('bitmap' in message) message.bitmap.close();
            return;
        }
        if ('unsupported' in message) {
            this.useFallback();
            return;
        }
        this.pending.delete(message.id);
        if ('bitmap' in message) request.resolve(message.bitmap);
        else if ('pixels' in message) createImageBitmap(new ImageData(new Uint8ClampedArray(message.pixels), 256, 256)).then(request.resolve, request.reject);
        else request.reject(new Error(message.error));
    }

    /** Moves every pending request onto the main thread for the rest of the session. */
    private useFallback(): void {
        this.fallback ??= new SmoothedTerrainRenderer();
        this.worker?.terminate();
        this.worker = null;
        const requests = [...this.pending.values()];
        this.pending.clear();
        for (const request of requests) this.renderHere(request.href, request.signal).then(request.resolve, request.reject);
    }

    private async renderHere(href: string, signal: AbortSignal): Promise<ImageBitmap> {
        this.fallback ??= new SmoothedTerrainRenderer();
        const pixels = await this.fallback.render(href, signal);
        if (!pixels) throw new Error('Terrain tile below smoothing threshold');
        return createImageBitmap(new ImageData(pixels, 256, 256));
    }
}

let client: TerrainWorkerClient | null = null;

/**
 * MapLibre alone uses this protocol; ElevationService keeps the original URL.
 * Returns an ImageBitmap: MapLibre transfers it to its own worker as is, so
 * the smoothed tile is never PNG-encoded and decoded again.
 */
export const loadSmoothedTerrain: AddProtocolAction = async (request, controller) => {
    const signal = controller.signal;
    const url = new URL(request.url.slice(`${TERRAIN_SMOOTHING_PROTOCOL}://`.length), document.baseURI);
    const tile = parseTerrainTilePath(url.pathname);
    if (!tile) throw new Error('Invalid display terrain URL');
    if (smoothingSigmaPixels(tile.z, tile.y) < MIN_SMOOTHING_SIGMA) {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Terrain tile: HTTP ${response.status}`);
        return { data: await response.arrayBuffer() };
    }
    client ??= new TerrainWorkerClient();
    return { data: await client.render(url.href, signal) };
};
