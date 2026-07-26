import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, waitForMapReady, openModeMenu } from './fixtures';

/**
 * Map GESTURES survive a Create↔Plan mode switch. Pins the owner-document trap
 * documented in map.service.ts `init`: MapLibre binds a drag's continuation
 * (document-level mousemove/mouseup) to `container.ownerDocument` at
 * construction time, so a map built while its host was still inside a detached
 * template clone had those listeners bound to an inert about:blank document —
 * clicks kept working, every drag (pan, marker drags, marquee) was dead. Only a
 * MODE SWITCH hit it: on a cold load the tile manifest arrives async (host
 * already inserted), while a switch replays a cached manifest synchronously
 * from the detached render pass. 09/10-*-pan cover the per-mode gesture
 * conventions on a cold load; this one covers the switch.
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

/**
 * Assert a real pointer drag from the canvas centre pans the camera. `holdKey`
 * is the per-mode pan affordance: Plan pans on a plain drag from empty ground,
 * Create claims that for the feature marquee and pans on ⌘-drag (09-draw-pan).
 */
async function expectPans(page: Page, label: string, holdKey: 'Meta' | null): Promise<void> {
    const mid = await canvasMid(page);
    const before = await mapCenter(page);
    if (holdKey) await page.keyboard.down(holdKey);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
        await page.mouse.move(mid.x - 20 * i, mid.y - 12 * i);
        await page.waitForTimeout(30);
    }
    await page.mouse.up();
    if (holdKey) await page.keyboard.up(holdKey);
    await page.waitForTimeout(250);
    const after = await mapCenter(page);
    const moved = Math.abs(before.lng - after.lng) > 1e-7 || Math.abs(before.lat - after.lat) > 1e-7;
    expect(moved, `${label} must pan the map`).toBe(true);
}

test('map drags keep working across Create↔Plan mode switches', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('submode-trigger'))).toBeVisible();
    await waitForMapReady(page);
    await expectPans(page, 'create mode ⌘-drag (cold load)', 'Meta');

    // Create → Plan.
    await openModeMenu(page);
    await page.locator(tid('course-plan-btn')).click();
    await expect(page).toHaveURL(/\/planner\//);
    await waitForMapReady(page);
    await expectPans(page, 'plan mode drag (after switch)', null);

    // Plan → Create.
    await openModeMenu(page);
    await page.getByRole('menuitemradio', { name: /Create/ }).click();
    await expect(page).toHaveURL(/\/course\//);
    await waitForMapReady(page);
    await expectPans(page, 'create mode ⌘-drag (after switch back)', 'Meta');

    // A cached-manifest planner load reached from elsewhere hits the same
    // synchronous-init path as the switch.
    await page.goto(`/planner/${TEST_COURSE_ID}?hole=${HOLE_1}`);
    await waitForMapReady(page);
    await expectPans(page, 'plan mode drag (direct load)', null);
});
