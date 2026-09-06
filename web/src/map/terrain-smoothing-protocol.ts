import type { AddProtocolAction } from 'maplibre-gl';
import { smoothElevations, smoothingSigmaPixels, TERRAIN_SMOOTHING_PROTOCOL } from './terrain-smoothing';

const SIZE = 256;
// Completed decodes only: aborting one tile must not cancel another tile's fetch.
// URLs include the dataset version. Cap retained elevations at 16 MiB.
const decoded = new Map<string, Float32Array>();

async function readTile(url: string, signal: AbortSignal): Promise<Float32Array | null> {
    signal.throwIfAborted();
    const cached = decoded.get(url);
    if (cached) {
        decoded.delete(url);
        decoded.set(url, cached);
        return cached;
    }
    const response = await fetch(url, { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Terrain tile: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    try {
        signal.throwIfAborted();
        if (bitmap.width !== SIZE || bitmap.height !== SIZE) throw new Error('Expected 256px terrain tile');
        const ctx = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
        const heights = new Float32Array(SIZE * SIZE);
        for (let i = 0; i < heights.length; i++) {
            heights[i] = -10000 + (pixels[i * 4] * 65536 + pixels[i * 4 + 1] * 256 + pixels[i * 4 + 2]) * 0.1;
        }
        decoded.set(url, heights);
        while (decoded.size > 64) decoded.delete(decoded.keys().next().value!);
        return heights;
    } finally {
        bitmap.close();
    }
}

/** MapLibre alone uses this protocol; ElevationService keeps the original URL. */
export const loadSmoothedTerrain: AddProtocolAction = async (request, controller) => {
    const signal = controller.signal;
    const url = new URL(request.url.slice(`${TERRAIN_SMOOTHING_PROTOCOL}://`.length), document.baseURI);
    const match = /^(.*\/terrain\/)(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
    if (!match) throw new Error('Invalid display terrain URL');
    const [, prefix, zoom, column, row] = match;
    const z = Number(zoom), x = Number(column), y = Number(row);
    // Below this threshold the Gaussian changes less than Terrain-RGB precision.
    const sigma = smoothingSigmaPixels(z, y);
    if (sigma < 0.3) {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Terrain tile: HTTP ${response.status}`);
        return { data: await response.arrayBuffer() };
    }
    const radius = Math.ceil(3 * sigma);
    if (radius > SIZE) throw new Error('Display terrain zoom exceeds smoothing support');
    const centre = await readTile(url.href, signal);
    if (!centre) throw new Error('Terrain tile not found');
    const tiles = new Map<string, Float32Array>([['0,0', centre]]);
    await Promise.all(Array.from({ length: 9 }, async (_, i) => {
        const dx = i % 3 - 1, dy = Math.floor(i / 3) - 1;
        if (dx === 0 && dy === 0) return;
        if (y + dy < 0 || y + dy >= 2 ** z) return;
        const neighbour = new URL(url);
        neighbour.pathname = `${prefix}${z}/${(x + dx + 2 ** z) % 2 ** z}/${y + dy}.png`;
        const heights = await readTile(neighbour.href, signal);
        if (heights) tiles.set(`${dx},${dy}`, heights);
    }));
    signal.throwIfAborted();
    const width = SIZE + 2 * radius;
    const grid = new Float32Array(width * width);
    for (let py = 0; py < width; py++) {
        for (let px = 0; px < width; px++) {
            const gx = px - radius, gy = py - radius;
            const dx = Math.floor(gx / SIZE), dy = Math.floor(gy / SIZE);
            const tile = tiles.get(`${dx},${dy}`);
            grid[py * width + px] = tile
                ? tile[((gy + SIZE) % SIZE) * SIZE + (gx + SIZE) % SIZE]
                : centre[Math.max(0, Math.min(SIZE - 1, gy)) * SIZE + Math.max(0, Math.min(SIZE - 1, gx))];
        }
    }
    const heights = smoothElevations(grid, SIZE, sigma);
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < heights.length; i++) {
        const value = Math.max(0, Math.min(16777215, Math.round((heights[i] + 10000) * 10)));
        pixels.data[i * 4] = value >> 16;
        pixels.data[i * 4 + 1] = (value >> 8) & 255;
        pixels.data[i * 4 + 2] = value & 255;
        pixels.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    signal.throwIfAborted();
    return { data: await blob.arrayBuffer() };
};
