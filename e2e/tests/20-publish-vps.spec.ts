import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, openActionsMenu } from './fixtures';

/**
 * Publish-to-VPS actions-menu row (UI face of `bun run publish`). The isolated
 * e2e API deliberately has no PUBLISH_URL/PUBLISH_TOKEN, so clicking the row
 * must land in the "not configured" explainer dialog — never a network call.
 * This guards the row's presence next to Publish revision AND the unconfigured
 * guard itself.
 */
test('actions menu offers Publish to VPS; unconfigured builder explains setup', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();

    await openActionsMenu(page);
    const row = page.locator(tid('course-publish-vps-btn'));
    await expect(row).toBeVisible();
    await expect(row).toContainText('Publish to VPS');

    await row.click();
    const dialog = page.locator('.confirm-dialog--default');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Publishing is not configured');
    await expect(dialog).toContainText('PUBLISH_URL');
    await dialog.locator('.confirm-dialog__confirm').click();
    await expect(dialog).not.toBeVisible();
});
