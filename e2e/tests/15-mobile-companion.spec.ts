import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, waitForMapReady } from './fixtures';

/**
 * Flow (T61) — the Mobile Companion (`/m/*`, a second Vite entry served by the
 * mobileSpaFallback dev plugin). A read-only, touch-first on-course view: the
 * course list, the framed hole screen, and the live GPS distance readouts.
 *
 * The seeded DB has one course, "Linkan" (course-1, 2 holes — hole 1 par 4).
 * Geolocation is mocked at the course so the geolocation.service watch resolves
 * a fix without real hardware; localhost is a secure context, so the service
 * never trips its `insecure` guard. WebGL map readiness is read off the QA hook
 * (`window.__map`) exactly as the desktop smoke suite does — the mobile hole
 * screen inits the same MapService.
 *
 * A phone viewport + granted geolocation near the seeded green.
 */
test.use({
    viewport: { width: 390, height: 844 }, // iPhone 12/13/14 logical size
    geolocation: { latitude: 58.4014, longitude: 15.5664, accuracy: 5 },
    permissions: ['geolocation'],
    isMobile: true,
    hasTouch: true,
});

test('course list renders and a row navigates into the hole screen', async ({ page }) => {
    await page.goto('/m');

    const list = page.locator(tid('m-courses'));
    await expect(list).toBeVisible();

    // Target the seeded course by id — the DB also seeds the course-2
    // mutation sandbox (server/db/seed-e2e.ts), so "first row" is ambiguous.
    const row = page.locator(`${tid('m-course-row')}[data-course-id="${TEST_COURSE_ID}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Linkan');

    await row.click();

    // The hole screen mounts at /m/course/:id/hole/1.
    await expect(page).toHaveURL(new RegExp(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}$`));
    await expect(page.locator(tid('m-hole'))).toBeVisible();
});

test('hole screen frames the map, renders the strip + sheet, and reads a live GPS fix', async ({ page }) => {
    await page.goto(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}`);

    await expect(page.locator(tid('m-hole'))).toBeVisible();
    await waitForMapReady(page);

    // Top hole strip: one button per hole (2 seeded), the current one active.
    const strip = page.locator(tid('m-hole-strip'));
    await expect(strip).toBeVisible();
    await expect(strip.locator('.m-strip__btn')).toHaveCount(2);
    await expect(strip.locator('.m-strip__btn.active')).toHaveText(String(HOLE_1));

    // Bottom sheet with the title (par) + the three green-distance cells.
    const sheet = page.locator(tid('m-hole-sheet'));
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.m-hole__title')).toContainText('Par');
    await expect(page.locator(tid('m-hole-greens'))).toBeVisible();

    // The geolocation.service watch resolved the mocked fix → the sheet's GPS
    // line reports an accuracy readout (proves WGS84→SWEREF + secure-context
    // path end-to-end, not just the unit test).
    await expect(sheet.locator('.m-hole__gps')).toContainText('GPS ±', { timeout: 20_000 });

    // With a fix present, the middle-green big number resolves to a distance
    // (not the placeholder em dash).
    await expect(page.locator(tid('m-hole-greens')).locator('.m-hole__green-val').nth(1))
        .toHaveText(/^\d+$/, { timeout: 20_000 });
});

test('the hole strip switches holes', async ({ page }) => {
    await page.goto(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}`);
    await expect(page.locator(tid('m-hole'))).toBeVisible();
    await waitForMapReady(page);

    await page.locator(`${tid('m-hole-strip')} .m-strip__btn[data-hole="2"]`).click();

    await expect(page).toHaveURL(new RegExp(`/m/course/${TEST_COURSE_ID}/hole/2$`));
    await expect(page.locator(`${tid('m-hole-strip')} .m-strip__btn.active`)).toHaveText('2');
});
