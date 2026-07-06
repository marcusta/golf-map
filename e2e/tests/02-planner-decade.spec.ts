import { test, expect } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_2_PAR3, TEE_HOLE_2, CLUB_7I, tid, openPlanner, seedPlanViaApi,
} from './fixtures';

/**
 * Flow (b) — opening the planner for a hole renders the DECADE strategy
 * readout: the per-leg confidence chip (green/yellow/red "light") and the EV
 * (expected-strokes) readout. Uses par-3 hole 2 with a preferred club so its
 * tee→green leg is a clubbed APPROACH (the enriched shape the chip + EV attach
 * to — see fixtures HOLE_2_PAR3). The plan is seeded through the real API, then
 * the planner loads + enriches it.
 */
test('planner shows DECADE light chip + EV readout for an approach', async ({ page }) => {
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_2_PAR3,
        teeId: TEE_HOLE_2,
        preferredClubId: CLUB_7I,
    });

    await openPlanner(page, TEST_COURSE_ID, HOLE_2_PAR3);

    await expect(page.locator(tid('planner-legs-section'))).toBeVisible();

    // DECADE confidence chip on the approach leg (data-light = tier).
    const light = page.locator(tid('planner-leg-light')).first();
    await expect(light).toBeVisible();
    await expect(light).toHaveAttribute('data-light', /green|yellow|red/);

    // EV (expected-strokes) readout renders for the enriched leg.
    const ev = page.locator(tid('planner-leg-ev')).first();
    await expect(ev).toBeVisible();
    await expect(ev).toContainText('EV');
});
