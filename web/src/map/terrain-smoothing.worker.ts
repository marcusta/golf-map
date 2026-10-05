// Display terrain smoothing off the main thread: neighbour fetches, PNG decode,
// Gaussian blur and Terrain-RGB packing. One worker serves every map; its
// decode cache is shared across tiles. Protocol: terrain-smoothing-protocol.ts.
import { SmoothedTerrainRenderer } from './terrain-smoothing-loader';
import type { TerrainWorkerReply, TerrainWorkerRequest } from './terrain-smoothing-protocol';

// The client tsconfig has DOM types only; this is the slice of the worker scope used here.
const scope = self as unknown as {
    postMessage(message: TerrainWorkerReply, transfer: Transferable[]): void;
    onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null;
};
const renderer = new SmoothedTerrainRenderer();
const pending = new Map<number, AbortController>();

function supported(): boolean {
    try {
        return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
            && new OffscreenCanvas(1, 1).getContext('2d') !== null;
    } catch {
        return false;
    }
}
const canRender = supported();

function reply(message: TerrainWorkerReply, transfer: Transferable[] = []): void {
    scope.postMessage(message, transfer);
}

async function render(id: number, href: string): Promise<void> {
    const controller = new AbortController();
    pending.set(id, controller);
    try {
        const pixels = await renderer.render(href, controller.signal);
        if (!pixels) throw new Error('Terrain tile below smoothing threshold');
        controller.signal.throwIfAborted();
        try {
            const bitmap = await createImageBitmap(new ImageData(pixels, 256, 256));
            reply({ id, bitmap }, [bitmap]);
        } catch {
            // ImageData-to-bitmap failed in this worker: hand over the bytes.
            reply({ id, pixels: pixels.buffer }, [pixels.buffer]);
        }
    } catch (error) {
        if (!controller.signal.aborted) reply({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
        pending.delete(id);
    }
}

scope.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
    const message = event.data;
    if (message.type === 'abort') {
        pending.get(message.id)?.abort();
        pending.delete(message.id);
    } else if (!canRender) {
        reply({ id: message.id, unsupported: true });
    } else {
        void render(message.id, message.href);
    }
};
