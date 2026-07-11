import { test, expect, type Page } from '@playwright/test';
import {
    TEST_COURSE_ID,
    HOLE_1,
    HOLE_1_AIM,
    CLUB_7I,
    TEE_HOLE_1,
    tid,
    openPlanner,
    seedPlanViaApi,
} from './fixtures';

/**
 * Planner map navigation: ⌘-drag is the guaranteed pan escape hatch (same
 * convention as the draw tool). A plain drag starting on a shot marker grabs
 * and MOVES the shot (03-drag-cadence covers that); ⌘-drag from the very same
 * pixel must fall through the planner's onMouseDown meta guard to MapLibre's
 * native dragPan — panning the camera and leaving the shot where it was.
 */

async function mapCenter(page: Page): Promise<{ lng: number; lat: number }> {
    return page.evaluate(() => {
        const c = (window as unknown as { __map: { getCenter: () => { lng: number; lat: number } } }).__map.getCenter();
        return { lng: c.lng, lat: c.lat };
    });
}

/** Viewport position of a shot marker, projected from its live lat/lon. */
async function shotScreenPos(page: Page, shotId: string): Promise<{ x: number; y: number }> {
    const row = page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`);
    const lat = Number(await row.getAttribute('data-lat'));
    const lon = Number(await row.getAttribute('data-lon'));
    return page.evaluate(([lat, lon]) => {
        const map = (window as unknown as {
            __map: {
                project: (ll: [number, number]) => { x: number; y: number };
                getCanvas: () => HTMLCanvasElement;
            };
        }).__map;
        const p = map.project([lon, lat]);
        const rect = map.getCanvas().getBoundingClientRect();
        return { x: rect.left + p.x, y: rect.top + p.y };
    }, [lat, lon]);
}

async function shotGeo(page: Page, shotId: string): Promise<{ lat: number; lon: number }> {
    const row = page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`);
    return {
        lat: Number(await row.getAttribute('data-lat')),
        lon: Number(await row.getAttribute('data-lon')),
    };
}

test('planner: ⌘-drag from a shot marker pans the map, shot stays put', async ({ page }) => {
    const seeded = await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
        shots: [{ lat: HOLE_1_AIM.lat, lon: HOLE_1_AIM.lon, clubId: CLUB_7I }],
    });
    const shotId = seeded.shotIds[0];
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);
    await expect(page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`)).toBeVisible();

    const start = await shotScreenPos(page, shotId);
    const geo0 = await shotGeo(page, shotId);
    const c0 = await mapCenter(page);

    await page.keyboard.down('Meta');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
        await page.mouse.move(start.x - 20 * i, start.y - 12 * i);
        await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.keyboard.up('Meta');
    await page.waitForTimeout(200);

    const c1 = await mapCenter(page);
    const geo1 = await shotGeo(page, shotId);

    expect(
        Math.abs(c1.lng - c0.lng) > 1e-7 || Math.abs(c1.lat - c0.lat) > 1e-7,
        '⌘-drag from a marker must pan the camera',
    ).toBe(true);
    expect(geo1.lat, 'shot latitude must not change').toBeCloseTo(geo0.lat, 9);
    expect(geo1.lon, 'shot longitude must not change').toBeCloseTo(geo0.lon, 9);
});
