import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, Texture } from 'three';

function hash2(x: number, y: number, seed: number): number {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable value noise with period `period` cells. */
function noise(x: number, y: number, seed: number, period: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const wrap = (v: number) => ((v % period) + period) % period;
    const a = hash2(wrap(x0), wrap(y0), seed), b = hash2(wrap(x0 + 1), wrap(y0), seed);
    const c = hash2(wrap(x0), wrap(y0 + 1), seed), d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Procedural tileable grass: layered value noise for colour patches (worn,
 * lush and dry spots) and short streaks for blades. Generated at load in the
 * page's canvas; one tile covers GRASS_TILE_M metres of ground.
 */
export const GRASS_TILE_M = 8;

export function grassTexture(size = 512, seed = 3): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        const patch = noise(u * 6, v * 6, seed, 6) * 0.6 + noise(u * 14, v * 14, seed + 1, 14) * 0.3 + noise(u * 40, v * 40, seed + 2, 40) * 0.1;
        const grain = hash2(x, y, seed + 3);
        // Blade streaks: high-frequency noise stretched along y.
        const blade = noise(u * 90, v * 12, seed + 4, 90) * 0.5 + noise(u * 180, v * 30, seed + 5, 180) * 0.5;
        const light = 0.62 + (patch - 0.5) * 0.5 + (blade - 0.5) * 0.35 + (grain - 0.5) * 0.12;
        const dry = Math.max(0, patch - 0.62) * 2.5;
        const r = light * (0.36 + dry * 0.32), g = light * (0.56 + dry * 0.06), b = light * (0.22 + dry * 0.05);
        const i = (y * size + x) * 4;
        data[i] = Math.min(255, r * 255); data[i + 1] = Math.min(255, g * 255); data[i + 2] = Math.min(255, b * 255); data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    return texture;
}
