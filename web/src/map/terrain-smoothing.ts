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
