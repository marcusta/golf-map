import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * Flow (g) — the green-book decorations on the reused Green-analysis overlay:
 * a 1×1 m white reference grid + 2 cm elevation contours (index lines every
 * 10 cm). In the planner's putt view they ride the HEIGHT overlay mode only —
 * slope mode keeps its fall-line arrows uncluttered. Hole 1's seeded green is
 * a synthetic tilted plane (see server/db/seed-e2e.ts), so contours MUST come
 * out as parallel straight lines at exact 2 cm level multiples.
 *
 * Asserts against the live MapLibre style (window.__map): layer presence per
 * overlay mode, and the contour source's GeoJSON levels.
 */

const GRID_LAYER = 'analysis-meter-grid-line';
const CONTOUR_LAYER = 'analysis-contours-line';
const HEAT_LAYER = 'analysis-heat';

/** Presence of the decoration layers in the live map style. */
async function overlayLayers(page: Page): Promise<{ grid: boolean; contours: boolean; heat: boolean }> {
    return page.evaluate(([grid, contours, heat]) => {
        const map = (window as unknown as {
            __map?: { getLayer: (id: string) => unknown };
        }).__map!;
        return {
            grid: !!map.getLayer(grid),
            contours: !!map.getLayer(contours),
            heat: !!map.getLayer(heat),
        };
    }, [GRID_LAYER, CONTOUR_LAYER, HEAT_LAYER] as const);
}

test('putt height overlay draws the 1 m grid + 2 cm contours; slope mode does not', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    // Arm putt mode on the seeded green.
    await page.locator(tid('planner-putt-mode')).click();
    await expect(page.locator(tid('planner-putt-section'))).toBeVisible();

    // Height mode → heat + contours + grid all render.
    await page.locator(tid('planner-putt-overlay-height')).click();
    await expect.poll(() => overlayLayers(page), { timeout: 15_000 })
        .toEqual({ grid: true, contours: true, heat: true });

    // The contour source carries one MultiLineString per 2 cm level.
    const levels = await page.evaluate(async () => {
        const map = (window as unknown as {
            __map?: { getSource: (id: string) => { getData: () => Promise<GeoJSON.FeatureCollection> } };
        }).__map!;
        const data = await map.getSource('analysis-contours').getData();
        return data.features.map(f => ({
            level: f.properties!.level as number,
            index: f.properties!.index as boolean,
            type: f.geometry.type,
        }));
    });
    expect(levels.length).toBeGreaterThan(3);
    for (const l of levels) {
        expect(l.type).toBe('MultiLineString');
        const k = Math.round(l.level / 0.02);
        expect(l.level).toBeCloseTo(k * 0.02, 9);
        expect(l.index).toBe(k % 5 === 0);
    }

    // Slope mode keeps the heat map but drops the green-book decorations.
    await page.locator(tid('planner-putt-overlay-slope')).click();
    await expect.poll(() => overlayLayers(page), { timeout: 15_000 })
        .toEqual({ grid: false, contours: false, heat: true });

    // Off removes everything.
    await page.locator(tid('planner-putt-overlay-none')).click();
    await expect.poll(() => overlayLayers(page), { timeout: 15_000 })
        .toEqual({ grid: false, contours: false, heat: false });
});
