import { test, expect, type Page } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_1, tid, openPlanner, waitForMapReady,
} from './fixtures';

/**
 * Flow (f) — the planner putt-read (feature-putting-green-reading §5.1, tasks
 * B1/B2). Hole 1 is the ONLY hole with a green FEATURE (the DEM sample-grid
 * key); the e2e seed (server/db/seed-e2e.ts) gives that feature a real
 * EPSG:3006 polygon aligned with the hole's furniture + a synthetic `dem_cog`
 * so the read has a genuine (tilted-plane) surface — an `ok` read with a real
 * break, responsive to stimp. See the seed's putt-read block comment.
 *
 * The spec drives the FULL flow: arm putt mode → the training quiz gates the
 * read (training default ON) → Skip reveals it (verbal + numbers + confidence,
 * status ok) → changing stimp re-reads → toggling training OFF shows the read
 * directly with no gate → one Submit path that scores AND lands the sample POST
 * to /api/putt-estimates/samples.
 *
 * localStorage: training mode defaults ON but persists in
 * `golf-map.putt.trainingMode`; a prior run could have flipped it OFF. We set
 * it EXPLICITLY before load so the quiz-gate assertions are deterministic
 * regardless of prior state.
 */

const TRAINING_KEY = 'golf-map.putt.trainingMode';

/** Force the persisted training-mode flag before the app boots. */
async function setTrainingMode(page: Page, on: boolean): Promise<void> {
    // The origin must exist before we can touch its localStorage.
    if (!page.url().startsWith('http')) await page.goto('/');
    await page.evaluate(([key, val]) => localStorage.setItem(key, val),
        [TRAINING_KEY, on ? '1' : '0'] as const);
}

/**
 * Place the putt BALL by a REAL map click at a projected pixel. The tool reads
 * the click's lngLat and projects it into EPSG:3006, so we pick a WGS84 point
 * we know falls INSIDE hole 1's seeded green polygon (a few metres NW of the
 * active pin) and click the pixel `__map.project` maps it to — the same
 * project-then-drive pattern the shot-drag helper uses.
 */
async function placeBallAt(page: Page, lon: number, lat: number): Promise<void> {
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

// A WGS84 point inside hole 1's seeded green polygon, offset from the active
// pin (the default hole) so the ball→hole line has real length + break.
// (Projects to ≈ EPSG:3006 (532956, 6473703); pin ≈ (532962, 6473706).)
const BALL_LAT = 58.402873;
const BALL_LON = 15.563897;
// A SECOND on-green point, ~7 m from the first (projects to EPSG:3006
// (532950, 6473700)) — a clearly distinct pixel so re-placing the ball is a
// new putt signature (resets the quiz gate).
const BALL2_LAT = 58.402848;
const BALL2_LON = 15.563793;

const section = () => tid('planner-putt-section');

/** Read the presentation-tier hook off the putt section. */
async function puttStatus(page: Page): Promise<string | null> {
    return page.locator(section()).getAttribute('data-putt-status');
}
async function puttQuizGate(page: Page): Promise<string | null> {
    return page.locator(section()).getAttribute('data-putt-quiz');
}

test('putt read: quiz gate, skip reveal, stimp re-read, training-off, and a scored submit POST', async ({ page }) => {
    await setTrainingMode(page, true); // deterministic: default ON, forced ON.

    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    // Arm putt mode — the read section reveals (it is display:none otherwise).
    await page.locator(tid('planner-putt-mode')).click();
    await expect(page.locator(section())).toBeVisible();

    // Both points are user-placed now. Tap to drop the ball (the first tap;
    // the selector auto-advances to the hole), then snap the hole to the active
    // pin with "At pin". Status settles to `ok` once both markers are on the
    // seeded confident tilted-plane surface.
    await placeBallAt(page, BALL_LON, BALL_LAT);
    await page.locator(tid('planner-putt-hole-at-pin')).click();
    await expect.poll(() => puttStatus(page), { timeout: 15_000 }).toBe('ok');

    // ── Training ON: the quiz gate withholds the read ──────────────────────
    await expect.poll(() => puttQuizGate(page)).toBe('active');
    await expect(page.locator(tid('planner-putt-est-slope'))).toBeVisible();
    await expect(page.locator(tid('planner-putt-est-side'))).toBeVisible();
    // The read + verbal are WITHHELD while the quiz gates it.
    await expect(page.locator(tid('planner-putt-verbal'))).toHaveText('');
    await expect(page.locator(tid('planner-putt-read'))).toHaveText('');

    // ── Skip reveals the read WITHOUT recording ────────────────────────────
    await page.locator(tid('planner-putt-est-skip')).click();
    await expect.poll(() => puttQuizGate(page)).toBe('off');

    // Verbal, exact-read numbers and confidence provenance all render non-empty.
    await expect(page.locator(tid('planner-putt-verbal'))).not.toHaveText('');
    await expect(page.locator(tid('planner-putt-read'))).toContainText('plays');
    await expect(page.locator(tid('planner-putt-read'))).toContainText('aim');
    await expect(page.locator(tid('planner-putt-confidence'))).toContainText('Green data');
    // Skip records nothing — no scored block appears.
    await expect(page.locator(tid('planner-putt-score'))).toHaveText('');
    // Status stays a shown read (ok on this surface, soft if ever degraded).
    expect(['ok', 'soft']).toContain(await puttStatus(page));

    // ── Changing stimp re-reads (the read updates) ─────────────────────────
    const readBefore = await page.locator(tid('planner-putt-read')).textContent();
    const stimp = page.locator(tid('planner-putt-stimp'));
    await stimp.fill('14');
    await stimp.blur();
    // A new putt signature resets the quiz gate (estimate-first again).
    await expect.poll(() => puttQuizGate(page)).toBe('active');
    // Reveal the re-read and assert its numbers moved (faster green → longer play).
    await page.locator(tid('planner-putt-est-skip')).click();
    await expect.poll(() => puttQuizGate(page)).toBe('off');
    await expect
        .poll(async () => page.locator(tid('planner-putt-read')).textContent(), { timeout: 10_000 })
        .not.toBe(readBefore);

    // ── Training OFF: the read shows directly, no quiz gate ─────────────────
    await page.locator(tid('planner-putt-training-toggle')).uncheck();
    await expect.poll(() => puttQuizGate(page)).toBe('off');
    await expect(page.locator(tid('planner-putt-est-slope'))).toBeHidden();
    await expect(page.locator(tid('planner-putt-read'))).toContainText('plays');

    // ── Submit path: score + record the sample (POST lands) ────────────────
    // Re-enable training to surface the estimate form, then submit a guess and
    // assert BOTH the scored block renders AND the sample POST reaches the API.
    await page.locator(tid('planner-putt-training-toggle')).check();
    // A fresh putt resets the gate: re-target the ball (the selector is on the
    // hole after the initial placement), then move it to a distinct on-green
    // point — a new putt signature — and the estimate form is offered again.
    await page.locator(tid('planner-putt-place-ball')).click();
    await placeBallAt(page, BALL2_LON, BALL2_LAT);
    await expect.poll(() => puttQuizGate(page), { timeout: 15_000 }).toBe('active');

    await page.locator(tid('planner-putt-est-slope')).fill('2');
    await page.locator(tid('planner-putt-est-side')).selectOption('left');
    await page.locator(tid('planner-putt-est-aim')).fill('40');
    await page.locator(tid('planner-putt-est-pace')).fill('9');

    const samplePost = page.waitForResponse(
        r => r.url().includes('/api/putt-estimates/samples') && r.request().method() === 'POST',
        { timeout: 15_000 },
    );
    await page.locator(tid('planner-putt-est-submit')).click();
    const res = await samplePost;
    expect(res.ok()).toBeTruthy();

    // The reveal now shows the scored block AND the read.
    await expect(page.locator(tid('planner-putt-score'))).toContainText('Score');
    await expect(page.locator(tid('planner-putt-read'))).toContainText('plays');
    await expect.poll(() => puttQuizGate(page)).toBe('off');
});

/**
 * Flow (f2) — honest degraded path: hole 2 has NO green feature drawn (only
 * hole 1 does in the seed), so arming putt mode yields the no-surface state,
 * the warn hint fires, and the quiz is never offered. Proves the entry + the
 * "nothing to read" branch a user actually hits on an undrawn green.
 */
test('putt read: no green feature on the hole surfaces the no-read notice, no quiz', async ({ page }) => {
    await setTrainingMode(page, true);

    // Hole 2 (par 3) has furniture but no green COURSE FEATURE in the seed.
    await page.goto(`/planner/${TEST_COURSE_ID}?hole=2`);
    await expect(page.locator(tid('planner'))).toBeVisible();
    await waitForMapReady(page);
    await expect(page.locator(tid('planner-panel'))).toBeVisible();

    await page.locator(tid('planner-putt-mode')).click();
    await expect(page.locator(section())).toBeVisible();

    // No green feature → the tool deactivates the read (status `inactive`, the
    // context-null branch of PuttReadService.display). The quiz gate never
    // activates and no estimate form is offered — the honest "nothing to read"
    // path a user hits on an undrawn green.
    await expect.poll(() => puttStatus(page), { timeout: 15_000 }).toBe('inactive');
    await expect.poll(() => puttQuizGate(page)).toBe('off');
    await expect(page.locator(tid('planner-putt-est-slope'))).toBeHidden();
});
