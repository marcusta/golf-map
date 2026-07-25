import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { BG, DISC, ICON_SIZES, RING, iconPng, renderIcon } from '../scripts/gen-pwa-icons';

/**
 * The PWA icons are hand-encoded (no image dependency in this repo), so these
 * tests DECODE the committed files rather than sniffing their headers — a PNG
 * whose IDAT holds a raw deflate stream instead of a zlib datastream passes
 * every header check (`file`, naturalWidth, `sips -g`) and still renders blank
 * everywhere. Inflate, unfilter, compare pixels.
 */
const ICON_DIR = join(import.meta.dir, '..', 'public', 'm');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk { type: string; data: Uint8Array }

function chunks(png: Uint8Array): Chunk[] {
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const out: Chunk[] = [];
    let i = 8;
    while (i + 8 <= png.length) {
        const len = dv.getUint32(i);
        const type = String.fromCharCode(...png.subarray(i + 4, i + 8));
        out.push({ type, data: png.subarray(i + 8, i + 8 + len) });
        i += 12 + len;
    }
    return out;
}

/** Inflate + unfilter an 8-bit RGBA PNG into raw pixels. Throws on anything else. */
function decodeRgba(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const parsed = chunks(png);
    const ihdr = parsed.find(c => c.type === 'IHDR');
    if (!ihdr) throw new Error('no IHDR');
    const hdr = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    const width = hdr.getUint32(0);
    const height = hdr.getUint32(4);
    expect(ihdr.data[8]).toBe(8);  // bit depth
    expect(ihdr.data[9]).toBe(6);  // colour type: truecolour + alpha

    const idatParts = parsed.filter(c => c.type === 'IDAT').map(c => Buffer.from(c.data));
    expect(idatParts.length).toBeGreaterThan(0);
    const idat = Buffer.concat(idatParts);

    // RFC 1950 framing: CM = 8 (deflate) and the two-byte header is a multiple
    // of 31. A raw deflate stream fails both — this is exactly the bug that
    // shipped blank icons once.
    expect(idat[0]! & 0x0f).toBe(8);
    expect(((idat[0]! << 8) | idat[1]!) % 31).toBe(0);

    const raw = new Uint8Array(inflateSync(idat));
    const stride = width * 4;
    expect(raw.length).toBe(height * (stride + 1));

    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        if (filter !== 0) throw new Error(`unexpected filter ${filter} on row ${y}`);
        pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
    }
    return { width, height, pixels };
}

const rgbaAt = (px: Uint8Array, size: number, x: number, y: number): number[] =>
    [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

describe('mobile PWA icons', () => {
    for (const size of ICON_SIZES) {
        const file = join(ICON_DIR, `icon-${size}.png`);

        test(`icon-${size}.png decodes to ${size}×${size} real pixels`, () => {
            const decoded = decodeRgba(new Uint8Array(readFileSync(file)));
            expect(decoded.width).toBe(size);
            expect(decoded.height).toBe(size);
            // Every pixel opaque, and the artwork is actually drawn (a blank or
            // transparent icon would fail these three probes).
            const c = Math.round((size - 1) / 2);
            expect(rgbaAt(decoded.pixels, size, c, c)).toEqual([...DISC, 255]);
            expect(rgbaAt(decoded.pixels, size, 0, 0)).toEqual([...BG, 255]);
            const ringX = c + Math.round(size * 0.26); // between the disc and ring radii
            expect(rgbaAt(decoded.pixels, size, ringX, c)).toEqual([...RING, 255]);
        });

        test(`icon-${size}.png matches the committed generator output`, () => {
            const onDisk = new Uint8Array(readFileSync(file));
            // Byte-identical to a fresh encode: the committed art is reproducible
            // with `bun run web/scripts/gen-pwa-icons.ts`.
            expect([...onDisk]).toEqual([...iconPng(size)]);
            expect([...decodeRgba(onDisk).pixels]).toEqual([...renderIcon(size)]);
        });
    }

    test('the manifest points at both icons with maskable purpose', () => {
        const manifest = JSON.parse(readFileSync(join(ICON_DIR, 'manifest.webmanifest'), 'utf8'));
        expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
        for (const icon of manifest.icons) {
            expect(icon.purpose).toContain('maskable');
            expect(icon.type).toBe('image/png');
        }
    });
});
