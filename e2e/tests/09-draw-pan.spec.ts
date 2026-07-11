import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

/**
 * Draw-mode map navigation: plain left-drag on empty ground is CLAIMED by the
 * feature marquee (no pan), while ⌘-drag falls through the draw tool's meta
 * early-return (draw-tool.service.ts onMouseDown) to MapLibre's native dragPan
 * — the trackpad pan affordance. This pins the fall-through: if someone adds
 * preventDefault/dragPan.disable to the meta path, ⌘-drag stops panning and
 * trackpad users lose their only way to pan in Draw mode.
 */

async function mapCenter(page: Page): Promise<{ lng: number; lat: number }> {
    return page.evaluate(() => {
        const c = (window as unknown as { __map: { getCenter: () => { lng: number; lat: number } } }).__map.getCenter();
        return { lng: c.lng, lat: c.lat };
    });
}

async function canvasMid(page: Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const m = (window as unknown as { __map: { getCanvas: () => HTMLCanvasElement } }).__map;
        const r = m.getCanvas().getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
}

/** Real pointer drag from the canvas centre, optionally holding a key. */
async function drag(page: Page, holdKey: 'Meta' | null): Promise<void> {
    const mid = await canvasMid(page);
    if (holdKey) await page.keyboard.down(holdKey);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
        await page.mouse.move(mid.x - 20 * i, mid.y - 12 * i);
        await page.waitForTimeout(30);
    }
    await page.mouse.up();
    if (holdKey) await page.keyboard.up(holdKey);
    // Let any camera easing / marquee cleanup settle before sampling.
    await page.waitForTimeout(200);
}

const moved = (a: { lng: number; lat: number }, b: { lng: number; lat: number }): boolean =>
    Math.abs(a.lng - b.lng) > 1e-7 || Math.abs(a.lat - b.lat) > 1e-7;

test('draw mode: ⌘-drag pans the map, plain drag stays a marquee', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('submode-trigger'))).toBeVisible();
    await waitForMapReady(page);
    await selectSubMode(page, 'draw');

    // Plain drag on empty ground: feature marquee claims it — camera holds.
    const c0 = await mapCenter(page);
    await drag(page, null);
    const c1 = await mapCenter(page);
    expect(moved(c0, c1), 'plain drag must not pan (marquee owns it)').toBe(false);

    // ⌘-drag: falls through to native dragPan — camera moves.
    await drag(page, 'Meta');
    const c2 = await mapCenter(page);
    expect(moved(c1, c2), '⌘-drag must pan the map').toBe(true);
});
