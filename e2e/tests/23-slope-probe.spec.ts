import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * Tap-to-read-slope probe on the planner's putt slope overlay: with the slope
 * heat map up, a map click reads the interpolated slope under the cursor and
 * renders a gold dot + downhill arrow + a slope% DOM chip. Hole 1's seeded
 * green is a synthetic tilted plane (server/db/seed-e2e.ts), so the probe
 * must return its constant slope anywhere on the green.
 *
 * The probe rides the reused Green-analysis renderer, so the same layers/chip
 * also cover the editor's analysis tool.
 */

const PROBE_DOT_LAYER = 'analysis-probe-dot';
const PROBE_ARROW_LAYER = 'analysis-probe-arrow';

/** Presence of the probe layers in the live MapLibre style. */
async function probeLayers(page: Page): Promise<{ dot: boolean; arrow: boolean }> {
    return page.evaluate(([dot, arrow]) => {
        const map = (window as unknown as {
            __map?: { getLayer: (id: string) => unknown };
        }).__map!;
        return { dot: !!map.getLayer(dot), arrow: !!map.getLayer(arrow) };
    }, [PROBE_DOT_LAYER, PROBE_ARROW_LAYER] as const);
}

/** Click the map at the pixel `__map.project` maps a WGS84 point to. */
async function clickAt(page: Page, lon: number, lat: number): Promise<void> {
    const pt = await page.evaluate(({ lon, lat }) => {
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
    await page.mouse.click(pt.x, pt.y);
}

// On-green WGS84 points inside hole 1's seeded green polygon (same area the
// putt-read spec uses; both are well inside the sampled grid).
const P1 = { lon: 15.563897, lat: 58.402873 };
const P2 = { lon: 15.563638, lat: 58.402804 };
// Probe points BETWEEN the markers — a click on a placed marker is grabbed
// for a drag (the synthesized click is swallowed), so probes must land clear.
const P3 = { lon: 15.5638, lat: 58.40285 };
const P4 = { lon: 15.56372, lat: 58.402825 };

test('putt slope overlay: a map click renders the probe dot/arrow + slope% chip; height mode hides it', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    await page.locator(tid('planner-putt-mode')).click();
    await expect(page.locator(tid('planner-putt-section'))).toBeVisible();

    // Slope overlay up — heat renders, no probe yet.
    await page.locator(tid('planner-putt-overlay-slope')).click();
    await expect.poll(() => page.evaluate(() => {
        const map = (window as unknown as { __map?: { getLayer: (id: string) => unknown } }).__map!;
        return !!map.getLayer('analysis-heat');
    }), { timeout: 15_000 }).toBe(true);
    expect(await probeLayers(page)).toEqual({ dot: false, arrow: false });

    // First two clicks are claimed by the one-shot placement (ball, then
    // auto-advanced hole) — no probe while a target is armed.
    await clickAt(page, P1.lon, P1.lat);
    await clickAt(page, P2.lon, P2.lat);
    await expect(page.locator(tid('planner-putt-place-ball')))
        .toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(tid('planner-putt-place-hole')))
        .toHaveAttribute('aria-pressed', 'false');
    expect(await probeLayers(page)).toEqual({ dot: false, arrow: false });

    // Placement disarmed — now a click (clear of the markers) probes.
    await clickAt(page, P3.lon, P3.lat);
    await expect.poll(() => probeLayers(page), { timeout: 15_000 })
        .toEqual({ dot: true, arrow: true });

    // The chip carries a slope% figure. The seeded green is a tilted plane —
    // any on-green probe reads a positive slope.
    const chip = page.locator(tid('analysis-probe-label'));
    await expect(chip).toBeVisible();
    const text = await chip.textContent();
    expect(text).toMatch(/^\d+\.\d%$/);
    expect(parseFloat(text!)).toBeGreaterThan(0);

    // Another disarmed click re-probes at the new spot.
    await clickAt(page, P4.lon, P4.lat);
    await expect(chip).toBeVisible();
    await expect.poll(() => probeLayers(page)).toEqual({ dot: true, arrow: true });

    // Height mode: the probe is slope-mode only.
    await page.locator(tid('planner-putt-overlay-height')).click();
    await expect.poll(() => probeLayers(page), { timeout: 15_000 })
        .toEqual({ dot: false, arrow: false });
    await expect(chip).toHaveCount(0);

    // Back to slope: the remembered probe returns without a new click.
    await page.locator(tid('planner-putt-overlay-slope')).click();
    await expect.poll(() => probeLayers(page), { timeout: 15_000 })
        .toEqual({ dot: true, arrow: true });
});
