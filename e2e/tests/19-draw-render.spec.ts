import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

/**
 * Draw-mode RENDER invariants (regression net for two field-reported glitches
 * on maplibre-gl 5.x, whose geojson fast-update race was only fixed upstream
 * in 6.0 — maplibre-gl-js#7734):
 *
 *  1. The dashed draft line must still be visible after a rapid zoom burst
 *     mid-draw (it used to vanish until the next draft change re-sent the
 *     preview source, while the vertex circles stayed).
 *  2. Closing the ring must show the committed feature's FILL without any
 *     camera nudge (it used to stay invisible until the next pan/zoom
 *     re-tiled the features source).
 *
 * WebGL canvas contents are not DOM-queryable, so both assert by counting
 * canvas pixels of a signature color: the draft line's #ffd43b selection
 * yellow, and the bunker draw fill #ecd588 (feature-palette.ts). The canvas
 * is copied to a 2D context inside a `render` callback — the one moment a
 * non-preserved WebGL back buffer is readable.
 */

/** Count canvas pixels within `tol` (per channel) of an RGB color. */
async function countPixels(page: Page, rgb: [number, number, number], tol: number): Promise<number> {
    return page.evaluate(({ rgb, tol }) => new Promise<number>((resolve) => {
        const map = (window as unknown as {
            __map: {
                getCanvas: () => HTMLCanvasElement;
                once: (ev: string, fn: () => void) => void;
                triggerRepaint: () => void;
            };
        }).__map;
        map.once('render', () => {
            const src = map.getCanvas();
            const c = document.createElement('canvas');
            c.width = src.width;
            c.height = src.height;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(src, 0, 0);
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            let n = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (Math.abs(data[i] - rgb[0]) <= tol
                    && Math.abs(data[i + 1] - rgb[1]) <= tol
                    && Math.abs(data[i + 2] - rgb[2]) <= tol) n++;
            }
            resolve(n);
        });
        map.triggerRepaint();
    }), { rgb, tol });
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const m = (window as unknown as { __map: { getCanvas: () => HTMLCanvasElement } }).__map;
        const r = m.getCanvas().getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
}

/** Click-place a draft point at a viewport position (real pointer click). */
async function place(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
}

const DRAFT_YELLOW: [number, number, number] = [255, 212, 59]; // SELECTION_COLOR #ffd43b

/** Read one canvas pixel (canvas-space coords) inside a `render` callback. */
async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
    return page.evaluate(({ x, y }) => new Promise<[number, number, number]>((resolve) => {
        const map = (window as unknown as {
            __map: {
                getCanvas: () => HTMLCanvasElement;
                once: (ev: string, fn: () => void) => void;
                triggerRepaint: () => void;
            };
        }).__map;
        map.once('render', () => {
            const src = map.getCanvas();
            const scale = src.width / src.getBoundingClientRect().width;
            const c = document.createElement('canvas');
            c.width = src.width;
            c.height = src.height;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(src, 0, 0);
            const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
            resolve([d[0], d[1], d[2]]);
        });
        map.triggerRepaint();
    }), { x, y });
}

test('draw mode: draft line survives a zoom burst; closed ring fills without a camera nudge', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('submode-trigger'))).toBeVisible();
    await waitForMapReady(page);
    await selectSubMode(page, 'draw');

    // Arm drawing and place an open 3-point draft around the canvas centre.
    await page.keyboard.press('n');
    const mid = await canvasCenter(page);
    await place(page, mid.x - 90, mid.y + 60);
    await place(page, mid.x, mid.y - 90);
    await place(page, mid.x + 90, mid.y + 60);

    const before = await countPixels(page, DRAFT_YELLOW, 40);
    expect(before, 'draft line visible after placing points').toBeGreaterThan(0);

    // Rapid zoom burst mid-draw (wheel spam → many camera frames while the
    // preview source is being re-sent per cursor move).
    await page.mouse.move(mid.x, mid.y);
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(30);
    }
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(30);
    }
    // Wiggle the cursor OFF the draft so the rubber-band updates, then let
    // the camera settle fully.
    await page.mouse.move(mid.x + 10, mid.y + 10);
    await page.waitForTimeout(600);

    const after = await countPixels(page, DRAFT_YELLOW, 40);
    expect(after, 'draft line still visible after the zoom burst').toBeGreaterThan(0);

    // Close the ring: click back on the first vertex. The committed feature
    // (default type: bunker) must paint its fill with NO camera movement —
    // the triangle's centroid pixel must change from pre-close background
    // to the blended bunker fill.
    const canvasRect = await page.evaluate(() => {
        const m = (window as unknown as { __map: { getCanvas: () => HTMLCanvasElement } }).__map;
        const r = m.getCanvas().getBoundingClientRect();
        return { left: r.left, top: r.top };
    });
    const centroid = { x: mid.x - canvasRect.left, y: mid.y + 10 - canvasRect.top };
    const preClose = await pixelAt(page, centroid.x, centroid.y);
    await place(page, mid.x - 90, mid.y + 60);
    await expect
        .poll(async () => {
            const p = await pixelAt(page, centroid.x, centroid.y);
            return Math.abs(p[0] - preClose[0]) + Math.abs(p[1] - preClose[1]) + Math.abs(p[2] - preClose[2]);
        }, {
            message: 'committed fill repaints the ring interior without panning/zooming',
            timeout: 10_000,
        })
        .toBeGreaterThan(30);
});

/**
 * Zoom >= 19 is where the terrain drape used to go stale for good: the
 * features source (geojson maxzoom 18) is overscaled to the same overscaledZ
 * as the render-to-texture tile drawing it, and maplibre's per-tile
 * `freeRtt(tileID)` (equals/isChildOf on OverscaledTileID) matches nothing.
 * MapService frees by canonical overlap instead.
 *
 * The stale texture only survives while the style renders as ONE draped
 * stack (a visible circle/symbol layer between draped layers makes maplibre
 * re-render every draped tile every frame, hiding the bug). The furniture
 * overlay's circles/symbols sit between the features and draw layers, so
 * hide them first — the field case where nothing splits the stack — and
 * assert the single stack before drawing so the test cannot pass vacuously.
 * Then draw and close a ring at zoom 19.5 and require the fill with no
 * camera movement.
 */
test('draw mode at zoom 19.5: closed ring fills without a camera nudge', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('submode-trigger'))).toBeVisible();
    await waitForMapReady(page);
    await page.evaluate(() => {
        const m = (window as unknown as { __map: { jumpTo: (o: { zoom: number }) => void } }).__map;
        m.jumpTo({ zoom: 19.5 });
    });
    await page.waitForTimeout(800);
    await selectSubMode(page, 'draw');
    // Single draped stack: hide the furniture circles/symbols (see above).
    const stacks = await page.evaluate(async () => {
        type StyleLayer = { id: string; type: string };
        const m = (window as unknown as {
            __map: {
                getStyle: () => { layers: StyleLayer[] };
                setLayoutProperty: (id: string, name: string, value: string) => void;
                triggerRepaint: () => void;
                once: (ev: string, cb: () => void) => void;
                painter: { renderToTexture: { _stacks: string[][] } };
            };
        }).__map;
        for (const layer of m.getStyle().layers) {
            if (layer.id.startsWith('furniture-') && (layer.type === 'circle' || layer.type === 'symbol')) {
                m.setLayoutProperty(layer.id, 'visibility', 'none');
            }
        }
        await new Promise<void>(resolve => { m.once('render', () => resolve()); m.triggerRepaint(); });
        await new Promise<void>(resolve => { m.once('render', () => resolve()); m.triggerRepaint(); });
        return m.painter.renderToTexture._stacks.length;
    });
    expect(stacks, 'precondition: one render-to-texture stack (otherwise the drape re-renders every frame and the test proves nothing)').toBe(1);
    await page.keyboard.press('n');
    const mid = await canvasCenter(page);
    await place(page, mid.x - 90, mid.y + 60);
    await place(page, mid.x, mid.y - 90);
    await place(page, mid.x + 90, mid.y + 60);
    const canvasRect = await page.evaluate(() => {
        const m = (window as unknown as { __map: { getCanvas: () => HTMLCanvasElement } }).__map;
        const r = m.getCanvas().getBoundingClientRect();
        return { left: r.left, top: r.top };
    });
    const centroid = { x: mid.x - canvasRect.left, y: mid.y + 10 - canvasRect.top };
    const preClose = await pixelAt(page, centroid.x, centroid.y);
    await place(page, mid.x - 90, mid.y + 60);
    await expect
        .poll(async () => {
            const p = await pixelAt(page, centroid.x, centroid.y);
            return Math.abs(p[0] - preClose[0]) + Math.abs(p[1] - preClose[1]) + Math.abs(p[2] - preClose[2]);
        }, {
            message: 'committed fill repaints the ring interior at zoom 19.5 without panning/zooming',
            timeout: 10_000,
        })
        .toBeGreaterThan(30);
});
