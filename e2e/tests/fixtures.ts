import { expect, type Page } from '@playwright/test';

// Seed constants — mirror server/db/seeds/*.ts (kept in sync by hand; the
// seed is deterministic so these never change between runs).
export const TEST_USERNAME = 'marcus';
export const TEST_PASSWORD = 'test-password-123';
export const TEST_COURSE_ID = 'course-1';
/** Hole 1 is a par 4 — used for the shot-drag + apply-aim flows (has a shot). */
export const HOLE_1 = 1;
/**
 * Hole 2 is a par 3. With a preferred club set, its tee→green leg (leg index 0)
 * is a CLUBBED APPROACH — the only shape that enriches into a DECADE confidence
 * light + caddy advice, because a leg's club comes from the shot it lands on and
 * the green is never a shot (only the index-0 preferred-club fallback clubs a
 * green-landing leg). See web/src/planner/plan-overlay.ts buildHolePlan.
 */
export const HOLE_2_PAR3 = 2;
export const TEE_HOLE_1 = 'hole-1-tee-yellow';
export const TEE_HOLE_2 = 'hole-2-tee-yellow';
export const CLUB_7I = 'club-7i';

/**
 * Wait until the MapLibre map has finished loading. The editor chrome
 * (toolbar, planner overlays) is gated on MapService.ready, which flips true on
 * the map's `load` event. We read it off the QA hook the app exposes
 * (`window.__map`, see web/src/map/map.service.ts) rather than asserting on
 * pixels/tiles — WebGL canvas contents are not DOM-queryable.
 */
export async function waitForMapReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const map = (window as unknown as { __map?: { loaded: () => boolean } }).__map;
            return !!map && map.loaded();
        },
        undefined,
        { timeout: 30_000 },
    );
}

/** data-testid selector shorthand. */
export const tid = (id: string): string => `[data-testid="${id}"]`;

/**
 * Command-bar sub-mode switch (Builder redesign v2): the draw/furniture/
 * measure/analysis tool buttons live inside a popover panel opened via the
 * `submode-trigger` dropdown chip (app/command-bar.component.ts), rather than
 * being directly-clickable tabs. Opens the dropdown then clicks the requested
 * tool's `tool-btn-<id>` row — the row's own click handler closes the popover.
 */
export async function selectSubMode(page: Page, toolId: string): Promise<void> {
    await page.locator(tid('submode-trigger')).click();
    await page.locator(tid(`tool-btn-${toolId}`)).click();
}

/**
 * Open the command bar's "⋯" actions menu (Import SVG / Publish), now hidden
 * behind a popover rather than shown as direct header buttons.
 */
export async function openActionsMenu(page: Page): Promise<void> {
    await page.locator(tid('actions-menu-trigger')).click();
}

/**
 * Open the command bar's zone-2 mode dropdown (Create/Plan/Play/Review),
 * spawned via the `mode-trigger` chip (app/command-bar.component.ts) — NOT
 * to be confused with `selectSubMode`'s `submode-trigger` (zone-3 draw/
 * furniture/measure/analysis switch). Only opens the panel; the caller picks
 * a row (e.g. `course-plan-btn`) itself since navigating mode rows have side
 * effects (route change) a helper shouldn't hide.
 */
export async function openModeMenu(page: Page): Promise<void> {
    await page.locator(tid('mode-trigger')).click();
}

/**
 * Read the planner panel's enrichment counter (data-enrich-count) — the number
 * of COMPLETED DECADE enrichment passes so far. Used to prove the compute
 * cadence: flat across drag frames, +1 on release.
 */
export async function enrichCount(page: Page): Promise<number> {
    const raw = await page.locator(tid('planner-panel')).getAttribute('data-enrich-count');
    return Number(raw ?? 'NaN');
}

/**
 * Drag the shot identified by `shotId` by a screen-pixel delta, driving a REAL
 * MapLibre pointer gesture (mousedown near the marker → several mousemove
 * frames → mouseup) so the planner tool's raw drag path runs exactly as it
 * does for a user. The marker's screen position is computed from its live
 * lat/lon (reflected onto the shot row as data-lat/lon) via `__map.project`.
 *
 * Returns the number of mousemove frames dispatched (the drag-frame count the
 * cadence assertion checks the enrich counter did NOT move across).
 */
export async function dragShotByPixels(
    page: Page,
    shotId: string,
    dx: number,
    dy: number,
    frames = 6,
    onFrame?: () => Promise<void>,
): Promise<number> {
    const row = page.locator(`${tid('planner-shot-row')}[data-shot-id="${shotId}"]`);
    const lat = Number(await row.getAttribute('data-lat'));
    const lon = Number(await row.getAttribute('data-lon'));

    // Project the shot's geo position to canvas pixels, offset by the canvas's
    // page origin so we get viewport coordinates for the mouse API.
    const origin = await page.evaluate(
        ({ lat, lon }) => {
            const map = (window as unknown as {
                __map?: {
                    project: (ll: [number, number]) => { x: number; y: number };
                    getCanvas: () => HTMLCanvasElement;
                };
            }).__map!;
            const p = map.project([lon, lat]);
            const rect = map.getCanvas().getBoundingClientRect();
            return { x: rect.left + p.x, y: rect.top + p.y };
        },
        { lat, lon },
    );

    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    // Step the pointer across `frames` intermediate positions — each triggers
    // MapLibre's mousemove → the tool's per-frame patch (geometry only). The
    // optional onFrame lets a caller sample state (e.g. the enrich counter)
    // mid-drag to prove nothing re-enriched per frame.
    for (let i = 1; i <= frames; i++) {
        const t = i / frames;
        await page.mouse.move(origin.x + dx * t, origin.y + dy * t);
        if (onFrame) await onFrame();
    }
    await page.mouse.up();
    return frames;
}

/** Navigate to the planner for a hole and wait for the map + panel to be live. */
export async function openPlanner(page: Page, courseId: string, hole: number): Promise<void> {
    await page.goto(`/planner/${courseId}?hole=${hole}`);
    await expect(page.locator(tid('planner'))).toBeVisible();
    await waitForMapReady(page);
    await expect(page.locator(tid('planner-panel'))).toBeVisible();
}

export interface SeededPlan {
    planId: string;
    holeId: string;
    /** Ids of the shots created (in order), empty for a shot-less approach. */
    shotIds: string[];
}

/**
 * Seed a game plan for one hole THROUGH THE REAL API from the page's session
 * (upsert plan → set-hole → add shots). This is legitimate test setup — the
 * same endpoints the app uses — done via fetch because the client's own
 * plan-creation path (PlanService.ensurePlan → set-hole) currently mis-sends an
 * empty planId on first edit (see docs/reports/T20-report.md "open concerns");
 * driving the API directly keeps these flows testing the DECADE/caddy RENDER +
 * enrichment seams rather than that unrelated create bug.
 *
 * Call BEFORE navigating to the planner; the planner then loads this plan.
 */
export async function seedPlanViaApi(
    page: Page,
    opts: {
        courseId: string;
        holeNumber: number;
        teeId?: string;
        preferredClubId?: string;
        /** Landing points for shots (each with a club so its leg enriches). */
        shots?: Array<{ lat: number; lon: number; elevation?: number | null; clubId?: string }>;
    },
): Promise<SeededPlan> {
    // Ensure we have a session on this origin before hitting the API.
    if (!page.url().startsWith('http')) await page.goto('/');
    return page.evaluate(async (o) => {
        const post = async (path: string, body: unknown) => {
            const r = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
            return r.json();
        };
        const tryPost = async (path: string, body: unknown) => {
            const r = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
        };
        // Idempotent: the plan is per-course. upsert CREATES on the first call
        // and 409s (version conflict) once it exists. The by-course GET can't
        // disambiguate (it serializes a null "no plan" as {ok:true}), so:
        // upsert first; on 409, read the now-existing plan tree.
        const up = await tryPost('/api/game-plans/upsert', { courseId: o.courseId });
        let plan: { id: string; holes?: Array<{ holeNumber: number; version: number }> };
        if (up.ok) {
            plan = up.json;
        } else {
            const r = await fetch(`/api/game-plans/by-course?courseId=${encodeURIComponent(o.courseId)}`);
            plan = await r.json();
        }

        // set-hole is idempotent too, but needs the current version once the
        // hole row exists (optimistic locking) — reuse the version from the plan
        // tree we already fetched.
        const existingHole = (plan.holes ?? []).find(
            (h: { holeNumber: number }) => h.holeNumber === o.holeNumber,
        );
        const hole = await post('/api/game-plans/set-hole', {
            planId: plan.id,
            holeNumber: o.holeNumber,
            ...(existingHole ? { version: existingHole.version } : {}),
            ...(o.teeId ? { teeId: o.teeId } : {}),
            ...(o.preferredClubId ? { preferredClubId: o.preferredClubId } : {}),
        });
        const shotIds: string[] = [];
        for (const s of o.shots ?? []) {
            const shot = await post('/api/game-plans/shots/add', {
                gamePlanHoleId: hole.id,
                lat: s.lat,
                lon: s.lon,
                elevation: s.elevation ?? null,
                ...(s.clubId ? { clubId: s.clubId } : {}),
            });
            shotIds.push(shot.id);
        }
        return { planId: plan.id, holeId: hole.id, shotIds };
    }, opts);
}

/** The seeded hole-1 aim point (server/db/seeds/course.ts) — a fairway landing. */
export const HOLE_1_AIM = { lat: 58.4014 + 0.001, lon: 15.5664 - 0.001 };
