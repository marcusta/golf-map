import { test, expect, type Page } from '@playwright/test';
import {
    TEST_COURSE_ID,
    HOLE_1,
    TEE_HOLE_1,
    tid,
    openPlanner,
    seedPlanViaApi,
} from './fixtures';

const DRIVER_LANDING = { lat: 58.40235, lon: 15.56535 };
const DRIVER_CONTINUATION = { lat: 58.40282, lon: 15.56415 };
const IRON_LANDING = { lat: 58.40205, lon: 15.56615 };
const IRON_CONTINUATION = { lat: 58.40262, lon: 15.56475 };

async function clickMapAt(page: Page, point: { lat: number; lon: number }): Promise<void> {
    const screen = await page.evaluate(({ lat, lon }) => {
        const map = (window as unknown as {
            __map: {
                project: (ll: [number, number]) => { x: number; y: number };
                getCanvas: () => HTMLCanvasElement;
            };
        }).__map;
        const projected = map.project([lon, lat]);
        const rect = map.getCanvas().getBoundingClientRect();
        return { x: rect.left + projected.x, y: rect.top + projected.y };
    }, point);
    await page.mouse.click(screen.x, screen.y);
}

async function placeShot(
    page: Page,
    point: { lat: number; lon: number },
    expectedCount: number,
): Promise<void> {
    const saved = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/add') && response.request().method() === 'POST');
    await clickMapAt(page, point);
    await saved;
    await expect(page.locator(tid('planner-shot-row'))).toHaveCount(expectedCount);
}

async function updateClub(page: Page, row: ReturnType<Page['locator']>, label: string): Promise<void> {
    const saved = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/update') && response.request().method() === 'POST');
    await row.locator('.shot-club').selectOption({ label });
    await saved;
}

async function updateLabel(page: Page, row: ReturnType<Page['locator']>, label: string): Promise<void> {
    const saved = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/update') && response.request().method() === 'POST');
    const input = row.locator('.shot-label');
    await input.fill(label);
    await input.press('Tab');
    await saved;
}

async function clearHoleShots(page: Page, holeNumber: number): Promise<void> {
    await page.evaluate(async ({ courseId, number }) => {
        const planResponse = await fetch(
            `/api/game-plans/by-course?courseId=${encodeURIComponent(courseId)}`,
        );
        if (!planResponse.ok) throw new Error(`load plan → ${planResponse.status}`);
        const plan = await planResponse.json() as {
            holes?: Array<{
                holeNumber: number;
                shots: Array<{
                    id: string;
                    parentShotId: string | null;
                    version: number;
                }>;
            }>;
        };
        const roots = plan.holes
            ?.find(hole => hole.holeNumber === number)
            ?.shots.filter(shot => shot.parentShotId === null) ?? [];
        for (const shot of roots) {
            const response = await fetch('/api/game-plans/shots/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: shot.id, version: shot.version, mode: 'cascade' }),
            });
            if (!response.ok) throw new Error(`clear shot ${shot.id} → ${response.status}`);
        }
    }, { courseId: TEST_COURSE_ID, number: holeNumber });
}

test('author driver vs 4-iron options with continuations, promote one, and survive reload', async ({ page }) => {
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_1,
        teeId: TEE_HOLE_1,
    });
    // The E2E suite is deliberately serial and shares one plan. Start this
    // authoring journey from an empty hole without relying on file order.
    await clearHoleShots(page, HOLE_1);
    const fourIron = await page.evaluate(async () => {
        const response = await fetch('/api/clubs/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '4i', carryM: 174, dispersionM: 34 }),
        });
        if (!response.ok) throw new Error(`create 4i → ${response.status}`);
        return response.json() as Promise<{ id: string }>;
    });

    await openPlanner(page, TEST_COURSE_ID, HOLE_1);
    await page.locator(tid('planner-add-shot')).click();

    await placeShot(page, DRIVER_LANDING, 1);
    let rows = page.locator(tid('planner-shot-row'));
    const driverId = await rows.nth(0).getAttribute('data-shot-id');
    expect(driverId).toBeTruthy();
    const driver = page.locator(`${tid('planner-shot-row')}[data-shot-id="${driverId}"]`);
    await updateClub(page, driver, 'Driver');
    await updateLabel(page, driver, 'attack line');

    // Add-shot keeps the created shot selected, so the next point is its continuation.
    await placeShot(page, DRIVER_CONTINUATION, 2);
    const driverContinuationId = await rows.nth(1).getAttribute('data-shot-id');
    expect(await rows.nth(1).getAttribute('data-parent-shot-id')).toBe(driverId);
    await updateClub(page, rows.nth(1), 'PW');

    // Select the driver decision, arm one-shot alternative placement, then
    // continue from the newly-created 4-iron option.
    await driver.click();
    await page.locator(tid('planner-add-alternative')).click();
    await placeShot(page, IRON_LANDING, 3);
    rows = page.locator(tid('planner-shot-row'));
    const ironId = await rows.nth(2).getAttribute('data-shot-id');
    expect(ironId).toBeTruthy();
    const iron = page.locator(`${tid('planner-shot-row')}[data-shot-id="${ironId}"]`);
    expect(await iron.getAttribute('data-parent-shot-id')).toBe('');
    await updateClub(page, iron, '4i');
    await updateLabel(page, iron, 'safe line');

    await placeShot(page, IRON_CONTINUATION, 4);
    const ironContinuation = page.locator(
        `${tid('planner-shot-row')}[data-parent-shot-id="${ironId}"]`,
    );
    await expect(ironContinuation).toHaveCount(1);
    await updateClub(page, ironContinuation, '7i');

    // The 4-iron root starts as rank 1. Promote it and verify both root ranks
    // before the reload.
    const promoted = page.waitForResponse(response =>
        response.url().includes('/api/game-plans/shots/set-primary') && response.request().method() === 'POST');
    await iron.locator(tid('planner-set-primary')).click();
    await promoted;
    await expect(iron).toHaveAttribute('data-sort-order', '0');
    await expect(driver).toHaveAttribute('data-sort-order', '1');

    await page.reload();
    await expect(page.locator(tid('planner-panel'))).toBeVisible();
    await expect(page.locator(tid('planner-shot-row'))).toHaveCount(4);

    const reloadedDriver = page.locator(`${tid('planner-shot-row')}[data-shot-id="${driverId}"]`);
    const reloadedIron = page.locator(`${tid('planner-shot-row')}[data-shot-id="${ironId}"]`);
    await expect(reloadedDriver.locator('.shot-label')).toHaveValue('attack line');
    await expect(reloadedIron.locator('.shot-label')).toHaveValue('safe line');
    await expect(reloadedIron.locator('.shot-club')).toHaveValue(fourIron.id);
    await expect(reloadedIron).toHaveAttribute('data-sort-order', '0');
    await expect(reloadedDriver).toHaveAttribute('data-sort-order', '1');
    await expect(page.locator(
        `${tid('planner-shot-row')}[data-shot-id="${driverContinuationId}"]`,
    )).toHaveAttribute('data-parent-shot-id', driverId!);
    await expect(page.locator(
        `${tid('planner-shot-row')}[data-parent-shot-id="${ironId}"]`,
    )).toHaveCount(1);
});
