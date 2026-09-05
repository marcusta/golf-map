import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, FURNITURE_COURSE_ID, tid, waitForMapReady } from './fixtures';

/**
 * Lidar tile layers (canopy-color raster + surface DSM). The Layers popover
 * shows the "Trees (lidar)" toggle and the "3D ground / surface" switch ONLY
 * when the course's tile manifest carries the layers: course-1's seed
 * manifest has none, the sandbox course-2's has all three
 * (server/db/seed-e2e.ts tileManifestJson). Map state is read off the
 * `window.__map` QA hook — layer visibility and the active terrain source are
 * WebGL-side, not DOM-queryable.
 */

const CANOPY_LAYER = 'course-canopy-color';
const GROUND_SOURCE = 'course-terrain';
const SURFACE_SOURCE = 'course-surface';

type MapHook = {
    getLayer: (id: string) => unknown;
    getLayoutProperty: (id: string, name: string) => string | undefined;
    getSource: (id: string) => unknown;
    getTerrain: () => { source: string; exaggeration: number } | null;
};

function readMap(page: Page) {
    return page.evaluate(() => {
        const map = (window as unknown as { __map: MapHook }).__map;
        return {
            hasCanopyLayer: !!map.getLayer('course-canopy-color'),
            canopyVisibility: map.getLayer('course-canopy-color')
                ? (map.getLayoutProperty('course-canopy-color', 'visibility') ?? 'visible')
                : null,
            hasSurfaceSource: !!map.getSource('course-surface'),
            terrain: map.getTerrain(),
        };
    });
}

test('course without lidar layers: no trees toggle, no terrain-mode switch, ground terrain', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await waitForMapReady(page);

    await page.locator(tid('map-layers-btn')).click();
    await expect(page.locator(tid('layers-canopy-row'))).toBeHidden();
    await expect(page.locator(tid('layers-terrain-mode-row'))).toBeHidden();

    await expect.poll(() => readMap(page)).toMatchObject({
        hasCanopyLayer: false,
        hasSurfaceSource: false,
        terrain: { source: GROUND_SOURCE },
    });
});

test('lidar course: trees toggle shows the canopy raster, 3D switch swaps the terrain DEM', async ({ page }) => {
    await page.goto(`/course/${FURNITURE_COURSE_ID}`);
    await waitForMapReady(page);

    // Style declares the layer hidden + the DSM source; terrain starts on ground.
    await expect.poll(() => readMap(page)).toMatchObject({
        hasCanopyLayer: true,
        canopyVisibility: 'none',
        hasSurfaceSource: true,
        terrain: { source: GROUND_SOURCE },
    });

    await page.locator(tid('map-layers-btn')).click();
    const canopyToggle = page.locator(tid('layers-canopy-toggle'));
    await expect(page.locator(tid('layers-canopy-row'))).toBeVisible();
    await expect(page.locator(tid('layers-terrain-mode-row'))).toBeVisible();
    await expect(canopyToggle).toHaveAttribute('aria-checked', 'false');

    await canopyToggle.click();
    await expect(canopyToggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await readMap(page)).canopyVisibility).toBe('visible');

    await canopyToggle.click();
    await expect.poll(async () => (await readMap(page)).canopyVisibility).toBe('none');

    // 3D: ground → surface keeps the exaggeration, swaps the raster-dem source.
    const before = (await readMap(page)).terrain!;
    await page.locator(tid('layers-terrain-surface')).click();
    await expect(page.locator(tid('layers-terrain-surface'))).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await readMap(page)).terrain).toMatchObject({
        source: SURFACE_SOURCE,
        exaggeration: before.exaggeration,
    });

    await page.locator(tid('layers-terrain-ground')).click();
    await expect.poll(async () => (await readMap(page)).terrain).toMatchObject({ source: GROUND_SOURCE });
});
