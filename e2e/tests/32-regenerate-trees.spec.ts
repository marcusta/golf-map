import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, openActionsMenu } from './fixtures';

/**
 * "Regenerate trees" actions-menu row (UI face of `bun run trees:regen`).
 * The seeded e2e course has no persisted DEM or lidar, so the server job is
 * rejected up front and the UI reports why instead of hanging on a job.
 */
test('actions menu offers Regenerate trees; a course without lidar explains what is missing', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();

    await openActionsMenu(page);
    const row = page.locator(tid('course-regenerate-trees-btn'));
    await expect(row).toBeVisible();
    await expect(row).toContainText('Regenerate trees');

    await row.click();
    const dialog = page.locator('.confirm-dialog--default');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Regenerate trees?');
    await dialog.locator('.confirm-dialog__confirm').click();

    await expect(dialog).toContainText('Could not regenerate trees');
    await expect(dialog).toContainText(/No persisted DEM|No lidar files/);
    await dialog.locator('.confirm-dialog__confirm').click();
    await expect(dialog).not.toBeVisible();
});
