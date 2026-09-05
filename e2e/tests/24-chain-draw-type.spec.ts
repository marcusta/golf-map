import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

/**
 * Chain-draw type picking. Every `create()` selects the new shape, so while
 * the + button stays armed there is always a selection: the previous shape.
 * A type pick (palette button or bare digit) while armed must apply to the
 * NEXT shape and leave the previous one alone. Field report: picking a type
 * mid-chain retyped the previous shape and the next shape came out as bunker.
 */

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const m = (window as unknown as { __map: { getCanvas: () => HTMLCanvasElement } }).__map;
        const r = m.getCanvas().getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
}

async function place(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
}

/** Place a closed triangle around (cx, cy) with the given half-size. */
async function drawTriangle(page: Page, cx: number, cy: number, r: number): Promise<void> {
    await place(page, cx - r, cy + r);
    await place(page, cx, cy - r);
    await place(page, cx + r, cy + r);
    await place(page, cx - r, cy + r); // close on the first vertex
}

/** id → type for every feature of the test course (order is stack order, not creation order). */
async function featureTypes(page: Page): Promise<Record<string, string>> {
    return page.evaluate(async (courseId) => {
        const r = await fetch(`/api/features?courseId=${encodeURIComponent(courseId)}`);
        const list = await r.json() as { id: string; type: string }[];
        return Object.fromEntries(list.map(f => [f.id, f.type]));
    }, TEST_COURSE_ID);
}

const newIds = (before: Record<string, string>, now: Record<string, string>): string[] =>
    Object.keys(now).filter(id => !(id in before));

test('armed chain-draw: a type digit applies to the next shape, not the previous one', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('submode-trigger'))).toBeVisible();
    await waitForMapReady(page);
    await selectSubMode(page, 'draw');
    const before = await featureTypes(page);

    // Arm via the + button and draw the first shape (default type bunker).
    await page.locator(tid('new-polygon-btn')).click();
    await expect(page.locator(tid('new-polygon-btn'))).toHaveAttribute('aria-pressed', 'true');
    const mid = await canvasCenter(page);
    await drawTriangle(page, mid.x - 120, mid.y, 50);
    await expect.poll(async () => newIds(before, await featureTypes(page)).length).toBe(1);
    const [firstId] = newIds(before, await featureTypes(page));

    // Still armed (chain-draw), the new shape is selected. Pick green.
    await expect(page.locator(tid('new-polygon-btn'))).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('3');
    await drawTriangle(page, mid.x + 120, mid.y, 50);
    await expect.poll(async () => newIds(before, await featureTypes(page)).length).toBe(2);

    const now = await featureTypes(page);
    const [secondId] = newIds(before, now).filter(id => id !== firstId);
    expect(now[firstId], 'first shape keeps bunker').toBe('bunker');
    expect(now[secondId], 'second shape is green').toBe('green');
});
