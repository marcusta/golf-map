// T62 — the simulate panel end to end (feature-hole-sim-and-variants §5, V8).
//
// The service tests own the invalidation state machine; what only a browser can
// prove is that the WORKER path actually produces a distribution (the module
// worker is a Vite build concern, invisible to bun tests) and that a plan edit
// greys the panel instead of silently recomputing.

import { test, expect } from '@playwright/test';
import {
    TEST_COURSE_ID,
    HOLE_1,
    TEE_HOLE_1,
    CLUB_7I,
    tid,
    openPlanner,
    seedPlanViaApi,
} from './fixtures';

const LANDING = { lat: 58.40235, lon: 15.56535 };

test('simulate produces a histogram off the main thread, and a plan edit greys it', async ({ page }) => {
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
        shots: [{ ...LANDING, clubId: CLUB_7I }],
    });
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    const section = page.locator(tid('planner-sim-section'));
    await expect(section).toBeVisible();
    // Nothing is computed until asked — distributions are NOT part of the
    // enrich cadence (V8).
    await expect(page.locator(tid('planner-sim-card'))).toHaveCount(0);

    await page.locator(tid('planner-simulate')).click();

    const card = page.locator(tid('planner-sim-card')).first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-stale', '0');
    // Five fixed par-relative buckets, a mean beside the label, and the
    // survival readout.
    await expect(card.locator(tid('planner-sim-bucket'))).toHaveCount(5);
    await expect(card.locator(tid('planner-sim-mean'))).toHaveText(/mean \d+\.\d\d/);
    await expect(card.locator(tid('planner-sim-survives'))).toHaveText(/plan survives: \d+%/);

    // Any plan edit invalidates: the card stays, dimmed, and says so — it must
    // NOT recompute itself.
    const saved = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/update') && response.request().method() === 'POST');
    await page.locator(tid('planner-shot-row')).first().locator('.shot-label').fill('sim edit');
    await page.locator(tid('planner-shot-row')).first().locator('.shot-label').press('Tab');
    await saved;
    // A label edit does not move the ball; nudge the club, which does change
    // the simulated chain.
    const clubSaved = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/update') && response.request().method() === 'POST');
    await page.locator(tid('planner-shot-row')).first().locator('.shot-club')
        .selectOption({ label: 'Driver' });
    await clubSaved;

    await expect(page.locator(tid('planner-sim-stale'))).toBeVisible();
    await expect(page.locator(tid('planner-sim-card')).first()).toHaveAttribute('data-stale', '1');

    // Asking again is what makes it fresh.
    await page.locator(tid('planner-simulate')).click();
    await expect(page.locator(tid('planner-sim-stale'))).toHaveCount(0);
    await expect(page.locator(tid('planner-sim-card')).first()).toHaveAttribute('data-stale', '0');

    // The landing-scatter toggle is off by default and turns the overlay on.
    const scatter = page.locator(tid('planner-sim-scatter'));
    await expect(scatter).not.toBeChecked();
    await scatter.check();
    await expect.poll(async () => page.evaluate(() => {
        const map = (window as unknown as { __map?: { getSource: (id: string) => unknown } }).__map;
        return !!map?.getSource('plan-sim-scatter');
    })).toBe(true);
});

// Ghost SELECTION (feature-hole-sim-and-variants §V5 "lazily, on selection"):
// hover-only preview was unusable — the corridor vanished with the pointer. A
// click pins the ghost, which is what buys it its own distribution card, its
// per-leg ellipses and leg labels on the map. Only a browser can prove the pin
// survives the pointer leaving and that the second card really comes back from
// the worker.
test('clicking a suggested line pins it, simulates it, and Escape unpins', async ({ page }) => {
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
        shots: [{ ...LANDING, clubId: CLUB_7I }],
    });
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    await page.locator(tid('planner-suggest-lines')).click();
    const rows = page.locator(tid('planner-variant-row'));
    await expect(rows.first()).toBeVisible();
    // Labels are disambiguated, so no two rows read the same.
    const labels = await rows.locator('.variant-row__label').allTextContents();
    expect(new Set(labels).size).toBe(labels.length);

    const row = rows.first();
    await row.click();
    await expect(row).toHaveAttribute('data-selected', '1');
    // The pin is state, not hover: moving the pointer away keeps it.
    await page.mouse.move(5, 5);
    await expect(row).toHaveAttribute('data-selected', '1');

    // Selecting simulates primary + ghost — two cards, the ghost's labelled
    // with its own name.
    const cards = page.locator(tid('planner-sim-card'));
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).locator(tid('planner-sim-mean'))).toHaveText(/mean \d+\.\d\d/);
    // The pinned ghost draws its dispersion ellipses / leg labels, which only
    // exist on the selected feature set. Read the source data itself rather
    // than querySourceFeatures — the latter only sees rendered tiles.
    await expect.poll(async () => page.evaluate(() => {
        const map = (window as unknown as {
            __map?: { getSource: (id: string) => { serialize?: () => unknown } | undefined };
        }).__map;
        const source = map?.getSource('plan-variants');
        const data = (source?.serialize?.() as { data?: { features?: Array<{ properties?: Record<string, unknown> }> } } | undefined)?.data;
        return (data?.features ?? []).filter(f => f.properties?.role === 'ellipse').length;
    })).toBeGreaterThan(0);

    // Escape unpins from the keyboard; the ghost list stays.
    await row.press('Escape');
    await expect(row).toHaveAttribute('data-selected', '0');
    await expect(rows.first()).toBeVisible();

    // Clicking the pinned row again toggles the pin off.
    await row.click();
    await expect(row).toHaveAttribute('data-selected', '1');
    await row.click();
    await expect(row).toHaveAttribute('data-selected', '0');
});
