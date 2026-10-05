// Ortho crop composition shared by the SAM and clean tools.
//
// Both tools send a square crop of the ortho photo to the local sidecar.
// They build it the same way: fetch the tiles that `planCrop`
// (sam/sam-crop.ts) lists, draw each at its offset on a black
// OffscreenCanvas, and encode. A tile that 404s (outside coverage) or fails
// to fetch is skipped and leaves black pixels; the sidecar works on what
// arrived.
//
// Canvas and createImageBitmap do not exist under bun test's happy-dom, so
// the tools keep these behind their constructor seams (SamCropSource,
// CleanImaging) and tests inject fakes.

import { fillTileUrl, type CropPlan } from '../sam/sam-crop';

/** One tile of a crop: its resolved URL and its draw offset in crop px. */
export interface CropTile {
    url: string;
    dx: number;
    dy: number;
}

/** The plan's tiles with URLs filled from a `{z}/{x}/{y}` template. */
export function cropTiles(plan: CropPlan, template: string): CropTile[] {
    return plan.tiles.map(t => ({ url: fillTileUrl(template, plan.zoom, t.x, t.y), dx: t.dx, dy: t.dy }));
}

/** Fetch `tiles` and composite them onto a black `size` x `size` canvas. */
export async function composeCropCanvas(tiles: CropTile[], size: number): Promise<OffscreenCanvas> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    await Promise.all(tiles.map(async tile => {
        try {
            const res = await fetch(tile.url);
            if (!res.ok) return; // out-of-coverage tile: keep the background
            const bitmap = await createImageBitmap(await res.blob());
            ctx.drawImage(bitmap, tile.dx, tile.dy);
            bitmap.close();
        } catch {
            // One tile failed to fetch: compose the rest.
        }
    }));
    return canvas;
}

/** Blob to base64 (no data-URL prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** Encode a canvas to base64 (no data-URL prefix). */
export async function canvasToBase64(
    canvas: OffscreenCanvas,
    type: 'image/png' | 'image/jpeg',
    quality?: number,
): Promise<string> {
    const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    return blobToBase64(blob);
}
