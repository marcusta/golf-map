// Generates the mobile PWA icons (web/public/m/icon-192.png, icon-512.png).
//
//   bun run web/scripts/gen-pwa-icons.ts            # writes web/public/m
//   bun run web/scripts/gen-pwa-icons.ts <outDir>   # writes elsewhere
//
// There is no image dependency in this repo, so the PNG is encoded here: a
// single IDAT holding zlib-framed (RFC 1950 — NOT raw deflate) filter-0 RGBA
// scanlines. `Bun.deflateSync` emits a RAW deflate stream, which every header
// check happily accepts and no decoder can read; `node:zlib` deflateSync emits
// the 78-xx + Adler-32 framing PNG actually requires. Keep it that way — and
// see web/tests/mobile-pwa-icons.test.ts, which decodes the committed files
// pixel-for-pixel against `renderIcon` below.
//
// Design: Links & Loam — deep-green field, cream ring, copper disc, all inside
// the maskable safe zone (content within the middle 60% of the canvas).

import { deflateSync } from 'node:zlib';

/** Deep green field — matches the manifest's theme/background colour. */
export const BG: readonly [number, number, number] = [0x14, 0x28, 0x1c];
/** Cream ring. */
export const RING: readonly [number, number, number] = [0xf6, 0xf1, 0xe7];
/** Copper disc. */
export const DISC: readonly [number, number, number] = [0xbf, 0x6a, 0x3e];

export const ICON_SIZES = [192, 512] as const;

/** The icon artwork as raw RGBA pixels, row-major, `size * size * 4` bytes. */
export function renderIcon(size: number): Uint8Array {
    const px = new Uint8Array(size * size * 4);
    const c = (size - 1) / 2;
    const rDisc = size * 0.22;
    const rRing = size * 0.3;
    let p = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - c, y - c);
            const col = d <= rDisc ? DISC : d <= rRing ? RING : BG;
            px[p++] = col[0]!;
            px[p++] = col[1]!;
            px[p++] = col[2]!;
            px[p++] = 255;
        }
    }
    return px;
}

function crc32(buf: Uint8Array): number {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** Encode `size × size` RGBA pixels as an 8-bit truecolour-alpha PNG. */
export function encodePng(size: number, pixels: Uint8Array): Uint8Array {
    const stride = size * 4;
    const raw = new Uint8Array(size * (stride + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, size);
    dv.setUint32(4, size);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    // zlib datastream (0x78 header + Adler-32), never a raw deflate stream.
    const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of parts) {
        out.set(a, o);
        o += a.length;
    }
    return out;
}

export function iconPng(size: number): Uint8Array {
    return encodePng(size, renderIcon(size));
}

if (import.meta.main) {
    const out = process.argv[2] ?? new URL('../public/m', import.meta.url).pathname;
    for (const size of ICON_SIZES) {
        const path = `${out}/icon-${size}.png`;
        await Bun.write(path, iconPng(size));
        console.log(`wrote ${path}`);
    }
}
