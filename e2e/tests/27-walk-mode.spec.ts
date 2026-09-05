import { test, expect, type Page } from '@playwright/test';
import { FURNITURE_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * Ground-level walk mode (planner "Hole setup" → Walk, or Alt+click on the
 * map). Entering eases the camera down to a 2 m eye pitched past MapLibre's
 * default 60° cap; WASD moves the eye; Escape eases back to the saved
 * overhead camera. Camera state is read off the `window.__map` QA hook.
 *
 * The seeded course serves no terrain tiles, so ground = 0 and the walk runs
 * over a flat plane; the surface-terrain switch (Trees toggle untouched) is
 * covered by 26-flyover, which shares the rule.
 */

type MapHook = {
    getPitch: () => number;
    getBearing: () => number;
    getZoom: () => number;
    getCenter: () => { lng: number; lat: number };
    getMaxPitch: () => number;
    getCenterClampedToGround: () => boolean;
    dragPan: { isEnabled: () => boolean };
    scrollZoom: { isEnabled: () => boolean };
};

function readMap(page: Page) {
    return page.evaluate(() => {
        const map = (window as unknown as { __map: MapHook }).__map;
        const c = map.getCenter();
        return {
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            zoom: map.getZoom(),
            center: { lng: c.lng, lat: c.lat },
            maxPitch: map.getMaxPitch(),
            clamped: map.getCenterClampedToGround(),
            dragPan: map.dragPan.isEnabled(),
            scrollZoom: map.scrollZoom.isEnabled(),
        };
    });
}

async function expectRestored(page: Page, before: Awaited<ReturnType<typeof readMap>>): Promise<void> {
    // The exit eases home over 1.5 s, then drops the pitch cap on moveend.
    await expect.poll(() => readMap(page), { timeout: 10_000 }).toMatchObject({
        maxPitch: before.maxPitch,
        clamped: before.clamped,
        dragPan: before.dragPan,
        scrollZoom: before.scrollZoom,
    });
    const after = await readMap(page);
    expect(after.pitch).toBeCloseTo(before.pitch, 2);
    expect(after.bearing).toBeCloseTo(before.bearing, 2);
    expect(after.zoom).toBeCloseTo(before.zoom, 2);
    expect(after.center.lng).toBeCloseTo(before.center.lng, 5);
    expect(after.center.lat).toBeCloseTo(before.center.lat, 5);
}

test('Alt+click enters walk mode, W walks forward, Escape restores the camera', async ({ page }) => {
    await openPlanner(page, FURNITURE_COURSE_ID, HOLE_1);
    const hud = page.locator(tid('walk-hud'));
    await expect(hud).toHaveCount(0);

    const before = await readMap(page);
    expect(before.pitch).toBeLessThan(60);
    expect(before.dragPan).toBe(true);

    const canvas = page.locator('.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 }, modifiers: ['Alt'] });

    await expect(hud).toBeVisible();
    await expect(hud).toContainText('Walk mode');
    await expect(page.locator(tid('walk-hud-height'))).toContainText('2.0 m');
    await expect(page.locator(tid('planner-walk'))).toHaveText('Stop walk');
    await expect.poll(async () => (await readMap(page)).pitch, { timeout: 5_000 }).toBeGreaterThan(60);
    await expect.poll(() => readMap(page)).toMatchObject({ clamped: false, dragPan: false, scrollZoom: false });
    const settled = await readMap(page);
    expect(settled.maxPitch).toBeGreaterThanOrEqual(settled.pitch);

    // Let the enter transition finish, then walk forward for half a second.
    await page.waitForTimeout(1_700);
    const standing = await readMap(page);
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    await expect.poll(async () => {
        const m = await readMap(page);
        return Math.hypot(m.center.lng - standing.center.lng, m.center.lat - standing.center.lat);
    }).toBeGreaterThan(1e-6);
    const walked = await readMap(page);
    expect(walked.pitch).toBeCloseTo(standing.pitch, 1);
    expect(walked.bearing).toBeCloseTo(standing.bearing, 1);

    // Q raises the eye; the HUD tracks it.
    await page.keyboard.down('q');
    await page.waitForTimeout(400);
    await page.keyboard.up('q');
    const heightText = await page.locator(tid('walk-hud-height')).textContent();
    expect(Number(heightText?.match(/([\d.]+) m/)?.[1])).toBeGreaterThan(2.5);

    await page.keyboard.press('Escape');
    await expect(hud).toHaveCount(0);
    await expect(page.locator(tid('planner-walk'))).toHaveText('Walk');
    await expectRestored(page, before);
});

test('Walk button arms a one-shot click; Escape disarms; a map click enters and the button exits', async ({ page }) => {
    await openPlanner(page, FURNITURE_COURSE_ID, HOLE_1);
    const btn = page.locator(tid('planner-walk'));
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeEnabled();
    const before = await readMap(page);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(tid('planner-walk')).locator('..')).toContainText('Click a spot');
    await page.keyboard.press('Escape');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(tid('walk-hud'))).toHaveCount(0);

    await btn.click();
    const canvas = page.locator('.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.locator(tid('walk-hud'))).toBeVisible();
    await expect(btn).toHaveText('Stop walk');
    await expect.poll(async () => (await readMap(page)).pitch, { timeout: 5_000 }).toBeGreaterThan(60);

    await btn.click();
    await expect(page.locator(tid('walk-hud'))).toHaveCount(0);
    await expectRestored(page, before);
});
