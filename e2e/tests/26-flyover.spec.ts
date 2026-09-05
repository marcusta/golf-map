import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, FURNITURE_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * Hole flyover (planner "Hole setup" → Flyover). The flight eases from the
 * overhead view to a 5 m eye pitched past MapLibre's default 60° cap and, on
 * a lidar course, swaps the 3D terrain to the `surface` DSM for the duration.
 * The canopy ("Trees") raster is left exactly as the user had it. Escape
 * stops the flight and restores camera and terrain source. Course-1's seed
 * manifest has no lidar layers, so its flight leaves the terrain source
 * alone. Camera/terrain state is read off the `window.__map` QA hook
 * (WebGL-side, not DOM-queryable).
 *
 * The seeded courses serve no real terrain tiles (the sandbox manifest only
 * DECLARES the layers), so the elevation samples fall back to ground = 0 and
 * the camera maths runs over a flat plane.
 */

const CANOPY_LAYER = 'course-canopy-color';
const GROUND_SOURCE = 'course-terrain';
const SURFACE_SOURCE = 'course-surface';

type MapHook = {
    getLayer: (id: string) => unknown;
    getLayoutProperty: (id: string, name: string) => string | undefined;
    getTerrain: () => { source: string; exaggeration: number } | null;
    getPitch: () => number;
    getBearing: () => number;
    getZoom: () => number;
    getCenter: () => { lng: number; lat: number };
    getMaxPitch: () => number;
    getCenterClampedToGround: () => boolean;
};

function readMap(page: Page) {
    return page.evaluate(({ canopyLayer }) => {
        const map = (window as unknown as { __map: MapHook }).__map;
        const c = map.getCenter();
        return {
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            zoom: map.getZoom(),
            center: { lng: c.lng, lat: c.lat },
            maxPitch: map.getMaxPitch(),
            clamped: map.getCenterClampedToGround(),
            terrainSource: map.getTerrain()?.source ?? null,
            canopyVisibility: map.getLayer(canopyLayer)
                ? (map.getLayoutProperty(canopyLayer, 'visibility') ?? 'visible')
                : null,
        };
    }, { canopyLayer: CANOPY_LAYER });
}

const SCREENSHOT = '/private/tmp/claude-501/-Users-marcust-dev-github-opcd-caddie/e7ba0367-34aa-418f-b025-c34c54e3f1cb/scratchpad/flyover-web.png';

test('lidar course: flyover pitches the camera, flies over the DSM with the Trees toggle untouched, Escape restores everything', async ({ page }) => {
    await openPlanner(page, FURNITURE_COURSE_ID, HOLE_1);

    const btn = page.locator(tid('planner-flyover'));
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeEnabled();

    const before = await readMap(page);
    expect(before.terrainSource).toBe(GROUND_SOURCE);
    expect(before.canopyVisibility).toBe('none');
    expect(before.pitch).toBeLessThan(60);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    await expect.poll(async () => (await readMap(page)).pitch, { timeout: 5_000 }).toBeGreaterThan(60);
    await expect.poll(() => readMap(page)).toMatchObject({
        terrainSource: SURFACE_SOURCE,
        clamped: false,
    });
    const midFlight = await readMap(page);
    expect(midFlight.maxPitch).toBeGreaterThanOrEqual(midFlight.pitch);
    // The flight does not switch the canopy raster on; the user's toggle stands.
    expect(midFlight.canopyVisibility).toBe('none');

    await page.screenshot({ path: SCREENSHOT });

    await page.keyboard.press('Escape');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');

    // A cancel snaps the camera straight back (jumpTo), so the pose is exact.
    await expect.poll(() => readMap(page)).toMatchObject({
        terrainSource: GROUND_SOURCE,
        canopyVisibility: 'none',
        clamped: before.clamped,
        maxPitch: before.maxPitch,
    });
    const after = await readMap(page);
    expect(after.pitch).toBeCloseTo(before.pitch, 3);
    expect(after.bearing).toBeCloseTo(before.bearing, 3);
    expect(after.zoom).toBeCloseTo(before.zoom, 3);
    expect(after.center.lng).toBeCloseTo(before.center.lng, 6);
    expect(after.center.lat).toBeCloseTo(before.center.lat, 6);
});

test('course without lidar layers: flyover runs with the terrain source unchanged', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    const btn = page.locator(tid('planner-flyover'));
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeEnabled();

    const before = await readMap(page);
    expect(before.terrainSource).toBe(GROUND_SOURCE);
    expect(before.canopyVisibility).toBeNull();

    await btn.click();
    await expect.poll(async () => (await readMap(page)).pitch, { timeout: 5_000 }).toBeGreaterThan(60);
    const midFlight = await readMap(page);
    expect(midFlight.terrainSource).toBe(GROUND_SOURCE);
    expect(midFlight.canopyVisibility).toBeNull();

    await page.keyboard.press('Escape');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => readMap(page)).toMatchObject({ terrainSource: GROUND_SOURCE });
    const after = await readMap(page);
    expect(after.pitch).toBeCloseTo(before.pitch, 3);
});
