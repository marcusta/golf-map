import { test, expect } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_2_PAR3, TEE_HOLE_2, CLUB_7I, tid, openPlanner, seedPlanViaApi,
} from './fixtures';

/**
 * Flow (e) — the caddy advice list renders at least one card for an approach
 * leg. Par-3 hole 2 with a preferred club gives a clubbed tee→green approach
 * (see fixtures HOLE_2_PAR3); that approach feeds the caddy rule set, which the
 * panel renders as ranked cards.
 */
test('caddy advice renders at least one item on an approach leg', async ({ page }) => {
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_2_PAR3,
        teeId: TEE_HOLE_2,
        preferredClubId: CLUB_7I,
    });

    await openPlanner(page, TEST_COURSE_ID, HOLE_2_PAR3);

    // The caddy section reveals itself only when there's advice; assert ≥1 card.
    await expect(page.locator(tid('planner-caddy-section'))).toBeVisible();
    const cards = page.locator(tid('planner-caddy-card'));
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
});
