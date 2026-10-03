/** Display-only smoothing. Sigma is in ground metres, independent of tile zoom. */
export const TERRAIN_SMOOTHING_METRES = 1.5;
export const TERRAIN_SMOOTHING_PROTOCOL = 'smooth-terrain';

export function smoothingSigmaPixels(z: number, y: number, tileSize = 256): number {
    const mercatorY = Math.PI * (1 - 2 * (y + 0.5) / 2 ** z);
    const metresPerPixel = 40075016.68557849 / (2 ** z * tileSize * Math.cosh(mercatorY));
    return TERRAIN_SMOOTHING_METRES / metresPerPixel;
}

/** Separable Gaussian on a halo-padded elevation grid; returns the centre tile.
 * The halo must contain neighbouring tiles, not repeated tile-edge pixels.
 * Only coverage boundaries use edge replication. Heights, never RGB channels,
 * are averaged so Terrain-RGB channel carries cannot create elevation spikes.
 */
export function smoothElevations(input: Float32Array, size: number, sigma: number): Float32Array {
    const radius = Math.ceil(3 * sigma);
    const width = size + 2 * radius;
    if (input.length !== width * width || !(sigma > 0)) throw new Error('Invalid smoothing grid');
    const weights = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
    const sum = weights.reduce((a, b) => a + b, 0);
    weights.forEach((v, i) => { weights[i] = v / sum; });
    const horizontal = new Float64Array(width * size);
    for (let y = 0; y < width; y++) {
        for (let x = 0; x < size; x++) {
            let value = 0;
            for (let k = 0; k < weights.length; k++) value += input[y * width + x + k] * weights[k];
            horizontal[y * size + x] = value;
        }
    }
    const output = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let value = 0;
            for (let k = 0; k < weights.length; k++) value += horizontal[(y + k) * size + x] * weights[k];
            output[y * size + x] = value;
        }
    }
    return output;
}

export const TERRAIN_TILE_SIZE = 256;

/** Terrain-RGB (mapbox encoding) RGBA bytes to elevations in metres. */
export function decodeTerrainRgb(pixels: ArrayLike<number>, size = TERRAIN_TILE_SIZE): Float32Array {
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i++) {
        heights[i] = -10000 + (pixels[i * 4] * 65536 + pixels[i * 4 + 1] * 256 + pixels[i * 4 + 2]) * 0.1;
    }
    return heights;
}

/** Elevations to opaque Terrain-RGB RGBA bytes, clamped to the encodable range. */
export function encodeTerrainRgb(heights: Float32Array): Uint8ClampedArray<ArrayBuffer> {
    const pixels = new Uint8ClampedArray(heights.length * 4);
    for (let i = 0; i < heights.length; i++) {
        const value = Math.max(0, Math.min(16777215, Math.round((heights[i] + 10000) * 10)));
        pixels[i * 4] = value >> 16;
        pixels[i * 4 + 1] = (value >> 8) & 255;
        pixels[i * 4 + 2] = value & 255;
        pixels[i * 4 + 3] = 255;
    }
    return pixels;
}

/**
 * Halo-padded grid for smoothElevations. `tiles` is the 3x3 neighbourhood in
 * row order, index (dy + 1) * 3 + (dx + 1); the centre (index 4) is required.
 * A missing neighbour is filled by replicating the centre tile's nearest edge.
 */
export function assembleHaloGrid(tiles: readonly (Float32Array | null)[], sigma: number, size = TERRAIN_TILE_SIZE): Float32Array {
    const centre = tiles[4];
    if (!centre) throw new Error('Centre terrain tile required');
    const radius = Math.ceil(3 * sigma);
    if (radius > size) throw new Error('Display terrain zoom exceeds smoothing support');
    const width = size + 2 * radius;
    // Per grid column: neighbour column (0..2) and source pixel column.
    const tileColumn = new Int32Array(width), sourceColumn = new Int32Array(width), clampedColumn = new Int32Array(width);
    for (let px = 0; px < width; px++) {
        const gx = px - radius;
        tileColumn[px] = Math.floor(gx / size) + 1;
        sourceColumn[px] = (gx + size) % size;
        clampedColumn[px] = Math.max(0, Math.min(size - 1, gx));
    }
    const grid = new Float32Array(width * width);
    for (let py = 0; py < width; py++) {
        const gy = py - radius;
        const tileRow = Math.floor(gy / size) + 1;
        const sourceRow = ((gy + size) % size) * size;
        const clampedRow = Math.max(0, Math.min(size - 1, gy)) * size;
        const out = py * width;
        for (let px = 0; px < width; px++) {
            const tile = tiles[tileRow * 3 + tileColumn[px]];
            grid[out + px] = tile ? tile[sourceRow + sourceColumn[px]] : centre[clampedRow + clampedColumn[px]];
        }
    }
    return grid;
}

/** The whole CPU body of a smoothed display tile: 3x3 elevations in, RGBA out. */
export function smoothTerrainTile(tiles: readonly (Float32Array | null)[], sigma: number, size = TERRAIN_TILE_SIZE): Uint8ClampedArray<ArrayBuffer> {
    return encodeTerrainRgb(smoothElevations(assembleHaloGrid(tiles, sigma, size), size, sigma));
}

export interface TerrainTileAddress { prefix: string; z: number; x: number; y: number }

/** Parses `.../terrain/{z}/{x}/{y}.png` from a URL pathname. */
export function parseTerrainTilePath(pathname: string): TerrainTileAddress | null {
    const match = /^(.*\/terrain\/)(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
    if (!match) return null;
    return { prefix: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

/** Neighbour tile pathname, wrapping x and returning null beyond the poles. */
export function neighbourTilePath({ prefix, z, x, y }: TerrainTileAddress, dx: number, dy: number): string | null {
    if (y + dy < 0 || y + dy >= 2 ** z) return null;
    return `${prefix}${z}/${(x + dx + 2 ** z) % 2 ** z}/${y + dy}.png`;
}
