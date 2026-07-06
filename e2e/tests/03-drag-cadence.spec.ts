import { test, expect } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_1, TEE_HOLE_1, CLUB_7I, HOLE_1_AIM,
    tid, openPlanner, seedPlanViaApi, enrichCount, dragShotByPixels,
} from './fixtures';

/**
 * Flow (c) — the compute-cadence proof (DECADE §4.5). Dragging a shot must NOT
 * re-run strategy enrichment per frame: the per-frame path is pure geometry,
 * and enrichment re-runs exactly ONCE on release. We assert this for REAL by
 * driving an actual MapLibre pointer drag (mousedown → N mousemove frames →
 * mouseup) and watching data-enrich-count on the planner panel: it must not
 * advance beyond +1 for the whole gesture (no per-frame bumps), settling at
 * exactly before+1 after release. The clubbed tee→S1 leg's EV survives the drag.
 */
test('dragging a shot keeps enrichment flat across frames and bumps once on release', async ({ page }) => {
    // Par-4 hole 1 with one clubbed shot near the seeded aim point → a
    // draggable S1 marker whose tee→S1 leg is enriched (has EV).
    const { shotIds } = await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
        shots: [{ lat: HOLE_1_AIM.lat, lon: HOLE_1_AIM.lon, clubId: CLUB_7I }],
    });
    const shotId = shotIds[0];
    expect(shotId).toBeTruthy();

    await openPlanner(page, TEST_COURSE_ID, HOLE_1);
    await expect(page.locator(tid('planner-shot-row')).first()).toBeVisible();
    await expect(page.locator(tid('planner-leg-ev')).first()).toBeVisible();

    // Select the shot so the drag hit-tests it.
    await page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`).click();

    // Let any selection-triggered enrichment settle, then snapshot the counter.
    await page.waitForTimeout(400);
    const before = await enrichCount(page);
    // At least one enrichment already ran (load/seed) — so the +1 we assert
    // below is a genuine second pass, not a first-ever one. Guards the counter
    // wiring against being stuck at 0 (which would make the test vacuous).
    expect(before).toBeGreaterThanOrEqual(1);

    // Drive a real multi-frame drag. Poll the counter across the frames to
    // prove it NEVER exceeds before+1 (no per-frame re-enrichment).
    let maxDuring = before;
    const frames = await dragShotByPixels(page, shotId, 45, 30, 8, async () => {
        const c = await enrichCount(page);
        if (c > maxDuring) maxDuring = c;
    });
    expect(frames).toBeGreaterThanOrEqual(8);
    // The per-frame path must not have re-enriched (at most the release which
    // may already have landed by the last sample).
    expect(maxDuring).toBeLessThanOrEqual(before + 1);

    // Exactly one enrichment for the whole gesture, after release settles.
    await expect
        .poll(async () => enrichCount(page), { timeout: 10_000 })
        .toBe(before + 1);

    // The DECADE readout survived the drag (EV still present, re-computed).
    await expect(page.locator(tid('planner-leg-ev')).first()).toBeVisible();
});
