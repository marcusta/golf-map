import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * Elevation profile (iOS profile-sheet port) — the planner panel's
 * "Elevation profile" section samples the terrain along the hole route
 * (tee → shots → green) through ElevationService.
 *
 * The e2e harness serves NO terrain tiles (seed-e2e's manifest is metadata
 * only, tile fetches 404 — deliberate, see seed-e2e.ts), so the profile
 * deterministically settles in the "no terrain data" state here: the route
 * exists (markers/path resolve), sampling runs, every sample comes back
 * null. That still proves the full wiring — panel section mounts, the
 * service re-samples off the debounced holePlan effect, and the loading
 * state resolves rather than sticking. Chart pixels are covered by unit
 * tests on the pure builders (web/tests/elevation-profile*.test.ts).
 */
test('planner shows the elevation-profile section and settles sampling', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    const section = page.locator(tid('planner-profile-section'));
    await expect(section).toBeVisible();
    await expect(section.locator('.section-title')).toHaveText('Elevation profile');

    // Hole 1 has a seeded route (tee → shot → green), so sampling runs and —
    // with no terrain tiles in the harness — must settle on the no-data
    // message (NOT "no route", NOT a stuck "Sampling terrain…").
    const empty = page.locator(tid('elevation-profile-empty'));
    await expect(empty).toHaveText('No terrain data along this line.');

    // No phantom chart or stats without elevations.
    await expect(page.locator(tid('elevation-profile-stats'))).not.toBeVisible();
    await expect(page.locator(`${tid('elevation-profile')} svg`)).not.toBeVisible();
});
