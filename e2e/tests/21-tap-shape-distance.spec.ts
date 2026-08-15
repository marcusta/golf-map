import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, openPlanner, waitForMapReady } from './fixtures';

/**
 * Tap-a-shape distances: clicking/tapping INSIDE a course shape (bunker /
 * water / green / trees) answers with the shape's near ("front") and far
 * ("carry") distances measured along the play line from the current origin —
 * desktop planner browse mode and the mobile companion's tap pill.
 *
 * The only seeded feature with real geometry is hole 1's green polygon (a
 * ~50 m square aligned with its furniture — see server/db/seed-e2e.ts), and
 * the green is a tappable ring (shared TAPPABLE_RING_TYPES), so both flows
 * click a point inside it. The clicks are retried via `toPass`: the feature
 * store loads async after the map, and until it lands the click legitimately
 * falls back to the plain point readout.
 */

// Inside hole 1's seeded green polygon (borrowed from the putt-read specs).
const GREEN_LAT = 58.402873;
const GREEN_LON = 15.563897;

/** Screen position of a WGS84 point via the live map's QA hook. */
async function mapScreenPoint(page: Page, lon: number, lat: number): Promise<{ x: number; y: number }> {
    return page.evaluate(({ lon, lat }) => {
        const map = (window as unknown as {
            __map?: {
                project: (ll: [number, number]) => { x: number; y: number };
                getCanvas: () => HTMLCanvasElement;
            };
        }).__map!;
        const p = map.project([lon, lat]);
        const rect = map.getCanvas().getBoundingClientRect();
        return { x: rect.left + p.x, y: rect.top + p.y };
    }, { lon, lat });
}

/** Click a WGS84 point by projecting it through the live map's QA hook. */
async function clickMapAt(page: Page, lon: number, lat: number): Promise<void> {
    const pt = await mapScreenPoint(page, lon, lat);
    await page.mouse.click(pt.x, pt.y);
}

test('planner browse: clicking the green shape shows its front/carry extent', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    const detail = page.locator(tid('planner-browse-detail'));
    await expect(async () => {
        await clickMapAt(page, GREEN_LON, GREEN_LAT);
        await expect(detail).toContainText('Green', { timeout: 1_000 });
        await expect(detail).toContainText(/front \d+ m( \(plays \d+\))? · carry \d+ m( \(plays \d+\))?/, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });

    // Visual feedback: the two edge figures render as DOM markers on the map,
    // and the browse overlay carries the ring highlight + edge dots. Each
    // figure may carry a "plays N" second line once the DEM samples resolve.
    const edgeLabels = page.locator('.browse-edge-label');
    await expect(edgeLabels).toHaveCount(2);
    await expect(edgeLabels.first()).toHaveText(/^\d+(plays \d+)?$/);
    await expect(async () => {
        const ringCount = await page.evaluate(() => {
            const map = (window as unknown as {
                __map?: { queryRenderedFeatures: (opts: { layers: string[] }) => unknown[] };
            }).__map!;
            return map.queryRenderedFeatures({ layers: ['plan-browse-feature-fill'] }).length;
        });
        expect(ringCount).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    // Browse-to composition: inspect a plain point first (open ground ~90 m
    // short of the green — the only shape in the seeded DB is the green
    // polygon), then click the green — the point is KEPT (target dot on the
    // chosen line) and the shape window measures along origin → point.
    await clickMapAt(page, GREEN_LON, GREEN_LAT - 0.0008);
    await expect(detail).toContainText('Selected point');
    // Point inspection prints its actual (+ plays) figure at the target too.
    await expect(page.locator('.browse-inspect-label')).toHaveText(/^\d+ m/);
    await clickMapAt(page, GREEN_LON, GREEN_LAT);
    await expect(detail).toContainText('Green');
    await expect(detail).toContainText(/front \d+ m( \(plays \d+\))? · carry \d+ m( \(plays \d+\))?/);
    await expect(page.locator('.browse-edge-label')).toHaveCount(2);
    await expect(page.locator('.browse-inspect-label')).toHaveCount(0);
    await expect(async () => {
        const keptTarget = await page.evaluate(() => {
            const map = (window as unknown as {
                __map?: { queryRenderedFeatures: (opts: { layers: string[] }) => unknown[] };
            }).__map!;
            return map.queryRenderedFeatures({ layers: ['plan-browse-target'] }).length;
        });
        expect(keptTarget).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    // Two-stage tap: clicking INSIDE the already-inspected green converts to
    // a point inspect — the aim-at-a-spot-on-the-green flow.
    await clickMapAt(page, GREEN_LON, GREEN_LAT);
    await expect(detail).toContainText('Selected point');

    // Double-click = "browse from here" (desktop shortcut, any surface):
    // the transient origin moves to the double-clicked point.
    const dbl = await mapScreenPoint(page, GREEN_LON, GREEN_LAT - 0.0008);
    await page.mouse.dblclick(dbl.x, dbl.y);
    await expect(page.locator('.browse-from')).toContainText('From selected map point');
});

test.describe('mobile companion', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        geolocation: { latitude: 58.4014, longitude: 15.5664, accuracy: 5 },
        permissions: ['geolocation'],
        isMobile: true,
        hasTouch: true,
    });

    test('tapping the green shape shows a front/carry pill', async ({ page }) => {
        await page.goto(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}`);
        await expect(page.locator(tid('m-hole'))).toBeVisible();
        await waitForMapReady(page);

        const pill = page.locator('.m-hole__tap-pill');
        await expect(async () => {
            await clickMapAt(page, GREEN_LON, GREEN_LAT);
            await expect(pill).toHaveText(/Green \d+ \/ \d+ m/, { timeout: 1_000 });
        }).toPass({ timeout: 20_000 });

        // Visual feedback: the two edge figures render as DOM markers.
        const edgeLabels = page.locator('.m-tap-edge-label');
        await expect(edgeLabels).toHaveCount(2);
        await expect(edgeLabels.first()).toHaveText(/^\d+$/);

        // Two-stage tap: tapping inside the same green again converts to the
        // plain point readout ("aim here"), and the edge markers clear.
        await clickMapAt(page, GREEN_LON, GREEN_LAT);
        await expect(pill).toHaveText(/Point \d+ m/);
        await expect(edgeLabels).toHaveCount(0);
    });
});
