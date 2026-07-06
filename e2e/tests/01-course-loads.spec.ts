import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady } from './fixtures';
import { EDITOR_TOOL_IDS } from './tool-ids';

/**
 * Flow (a) — the seam. Authenticated load of the seeded course renders the
 * detail chrome, and once the map is ready the editor toolbar + EVERY tool
 * button is present. This directly guards the transient "toolbar disappeared"
 * regression: the toolbar is gated on MapService.ready, so a broken map-boot
 * or a lost tool registration surfaces here.
 */
test('course detail loads with toolbar and all tool buttons', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);

    // Detail page + course name (seeded "Linkan") render before the map.
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await expect(page.locator(tid('course-name'))).toHaveText('Linkan');

    // The toolbar only shows once the map is ready.
    await waitForMapReady(page);
    await expect(page.locator(tid('editor-toolbar'))).toBeVisible();

    // Every registered tool has its button.
    for (const toolId of EDITOR_TOOL_IDS) {
        await expect(
            page.locator(tid(`tool-btn-${toolId}`)),
            `tool button for "${toolId}" should be present`,
        ).toBeVisible();
    }

    // Header actions (Plan / Import SVG) are present.
    await expect(page.locator(tid('course-plan-btn'))).toBeVisible();
    await expect(page.locator(tid('course-import-svg-btn'))).toBeVisible();
});
