import { test, expect } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_1, TEE_HOLE_1, CLUB_7I, HOLE_1_AIM,
    tid, openPlanner, seedPlanViaApi,
} from './fixtures';

/**
 * Flow (d) — "Apply recommended aim" moves the selected shot to its leg's
 * recommended (ghost) landing point and the panel reflects the change. The
 * button only appears when the selected shot's leg is an enriched approach with
 * a ghost aim; clicking it re-persists the shot at the ghost position. We assert
 * the shot row's reflected landing point (data-lat/lon) actually changes.
 */
test('apply recommended aim moves the selected shot and the panel reflects it', async ({ page }) => {
    const { shotIds } = await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
        shots: [{ lat: HOLE_1_AIM.lat, lon: HOLE_1_AIM.lon, clubId: CLUB_7I }],
    });
    const shotId = shotIds[0];

    await openPlanner(page, TEST_COURSE_ID, HOLE_1);
    const shotRow = page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`);
    await expect(shotRow).toBeVisible();
    await expect(page.locator(tid('planner-leg-ev')).first()).toBeVisible();

    // Select the shot so its ghost-aim "apply" affordance surfaces.
    await shotRow.click();

    // The button is display:none until there's a ghost aim — visibility is the
    // signal that the selected shot's leg is an enriched approach.
    const applyBtn = page.locator(tid('planner-apply-aim'));
    await expect(applyBtn).toBeVisible();

    const before = `${await shotRow.getAttribute('data-lat')},${await shotRow.getAttribute('data-lon')}`;

    await applyBtn.click();

    // The reflected landing point changes once the shot snaps to the ghost aim.
    await expect
        .poll(async () =>
            `${await shotRow.getAttribute('data-lat')},${await shotRow.getAttribute('data-lon')}`,
        { timeout: 10_000 })
        .not.toBe(before);
});
