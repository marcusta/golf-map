import { test, expect, type Page } from '@playwright/test';
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

/**
 * Tap a WGS84 point by projecting it through the live map (same
 * project-then-drive pattern as the desktop putt spec). `page.mouse.click`
 * rather than `tap()`: the green screen listens to the map's pointer events,
 * and a synthetic tap without a touch sequence does not produce one.
 */
async function tapMapAt(page: Page, lon: number, lat: number): Promise<void> {
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

// An on-green WGS84 point inside hole 1's seeded green polygon (the same point
// the desktop putt spec places the ball at — EPSG:3006 ≈ (532956, 6473703)),
// offset from the active pin so the ball→hole line has real length + break.
const BALL_LAT = 58.402873;
const BALL_LON = 15.563897;
// A SECOND on-green point ~17 m away (also borrowed from the desktop spec) —
// far enough that dragging the ball there is unmistakably a different putt.
const BALL2_LAT = 58.402804;
const BALL2_LON = 15.563638;

/** Screen position of a WGS84 point on the live map. */
async function screenPoint(page: Page, lon: number, lat: number): Promise<{ x: number; y: number }> {
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

/** The green screen's presentation-tier status hook. */
async function greenStatus(page: Page): Promise<string | null> {
    return page.locator(tid('m-green')).getAttribute('data-putt-status');
}

test('green screen: tap the ball, snap the hole to the pin, and a read renders', async ({ page }) => {
    await page.goto(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}`);
    await expect(page.locator(tid('m-hole'))).toBeVisible();
    await waitForMapReady(page);

    // Entry from the hole sheet — the URL keeps the /green suffix (route-key.ts
    // rewrites it only for $swap dispatch).
    await page.locator(tid('m-hole-green-link')).click();
    await expect(page).toHaveURL(new RegExp(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}/green$`));
    await expect(page.locator(tid('m-green'))).toBeVisible();
    await waitForMapReady(page);

    // Defaults: slope overlay armed, stimp 10 ft, waiting for the ball.
    await expect(page.locator(tid('m-green-mode-slope'))).toHaveClass(/active/);
    await expect(page.locator(tid('m-green-stimp'))).toHaveText('10 ft');
    await expect.poll(() => greenStatus(page), { timeout: 20_000 }).toBe('place');

    // Tap the ball on the green, then snap the hole to the active pin. The
    // read settles to `ok` on the seeded tilted-plane surface.
    await tapMapAt(page, BALL_LON, BALL_LAT);
    await page.locator(tid('m-green-at-pin')).click();
    await expect.poll(() => greenStatus(page), { timeout: 20_000 }).toBe('ok');

    // The Tour Read verbal line renders (aim + pace), with the confidence
    // provenance beside it.
    await expect(page.locator(tid('m-green-aim'))).not.toHaveText('');
    await expect(page.locator(tid('m-green-pace'))).not.toHaveText('');
    await expect(page.locator(tid('m-green-confidence'))).toContainText('Green data');

    // Placement is one-shot: the ball tap consumed the armed 'ball' target
    // (advancing to hole), and "at pin" disarmed it — so a fresh tap now
    // reads the slope instead of moving a marker. The sheet row reads a
    // positive slope% on the seeded tilted plane. The readout is slope-mode
    // only — Height hides it, and switching back restores the remembered
    // probe without a new tap.
    const probeRow = page.locator(tid('m-green-probe'));
    // (Probe away from the markers — a tap on one grabs it for a drag.)
    await expect(probeRow).not.toHaveClass(/show/); // no probe from placement taps
    await tapMapAt(page, BALL2_LON, BALL2_LAT);
    await expect(probeRow).toHaveClass(/show/);
    await expect(probeRow).toContainText(/Slope here: \d+\.\d%/);
    await page.locator(tid('m-green-mode-height')).click();
    await expect(probeRow).not.toHaveClass(/show/);
    await page.locator(tid('m-green-mode-slope')).click();
    await expect(probeRow).toHaveClass(/show/);

    // Stimp is a live input: a faster green re-reads (status stays ok).
    await page.locator(tid('m-green-stimp-up')).click();
    await expect(page.locator(tid('m-green-stimp'))).toHaveText('11 ft');
    await expect.poll(() => greenStatus(page), { timeout: 20_000 }).toBe('ok');

    // Drag the ball ~17 m to a different lie: grabbing the marker moves the
    // read (not the camera), and the release commits a NEW read.
    const before = await page.locator(tid('m-green-pace')).textContent();
    const from = await screenPoint(page, BALL_LON, BALL_LAT);
    const to = await screenPoint(page, BALL2_LON, BALL2_LAT);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => greenStatus(page), { timeout: 20_000 }).toBe('ok');
    await expect(page.locator(tid('m-green-pace'))).not.toHaveText(before ?? '');
});

test('the hole strip switches holes', async ({ page }) => {
    await page.goto(`/m/course/${TEST_COURSE_ID}/hole/${HOLE_1}`);
    await expect(page.locator(tid('m-hole'))).toBeVisible();
    await waitForMapReady(page);

    await page.locator(`${tid('m-hole-strip')} .m-strip__btn[data-hole="2"]`).click();

    await expect(page).toHaveURL(new RegExp(`/m/course/${TEST_COURSE_ID}/hole/2$`));
    await expect(page.locator(`${tid('m-hole-strip')} .m-strip__btn.active`)).toHaveText('2');
});
