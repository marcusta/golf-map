import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, openActionsMenu } from './fixtures';

/**
 * "Export to GSPro" actions-menu row and its panel: the folder is a
 * server-side setting kept per course, so this covers the journey that matters
 * — open the panel, see the default (the OS Downloads folder), set a folder,
 * and find it still there next time. The seed course has no map area, so the
 * inner/outer terrain squares (and the DEM / outer-ortho exports over them)
 * are shown as unavailable rather than failing the panel.
 *
 * The SVG export button is clicked only to make the folder stick: running it
 * shells out to the pipeline's Python, which the isolated e2e API has no venv
 * for. The exporters are pinned by pipeline/tests/test_gspro*.py and the
 * server's decisions by server/services/gspro-export.service.test.ts. The
 * orthophoto export needs a built site's source GeoTIFFs, which the e2e seed
 * has none of — so the panel must say so rather than offer an empty picker.
 */
test('actions menu exports to GSPro; the folder is per course and remembered', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();

    await openActionsMenu(page);
    const row = page.locator(tid('course-export-gspro-btn'));
    await expect(row).toBeVisible();
    await expect(row).toContainText('Export to GSPro');
    await row.click();

    // The export is a dialog over the page: header (folder, terrains), one
    // tab per group of files, a status footer.
    const panel = page.locator(tid('gspro-dialog'));
    await expect(panel).toBeVisible();
    const dir = panel.locator(tid('gspro-dir'));

    // Untouched course: blank field, the default offered as the placeholder
    // and named in the hint.
    await expect(dir).toHaveValue('');
    expect(await dir.getAttribute('placeholder')).toMatch(/Downloads/);
    await expect(panel).toContainText('Leave blank for the default');

    // No persisted orthophoto for the seed course: the picker stays hidden,
    // the hint explains, and the JPEG buttons cannot be pressed.
    await panel.locator(tid('gspro-tab-textures')).click();
    await expect(panel).toContainText('build its map first');
    await expect(panel.locator(tid('gspro-ortho-source'))).toBeHidden();
    await expect(panel.locator('.gspro-export__run-ortho')).toBeDisabled();
    await expect(panel.locator('.gspro-export__run-outer-ortho')).toBeDisabled();

    // No map area either: the two terrain squares cannot be laid out, the
    // panel says so in place (not as a panel-level error) and the DEM
    // exports stay off — while the folder and SVG export keep working.
    await expect(panel).toContainText('Inner terrain');
    await expect(panel).toContainText('Outer terrain');
    await expect(panel).toContainText('Terrains unavailable');
    await expect(panel).toContainText('no map area');
    await expect(panel.locator('.gspro-export__run-inner-dem')).toBeDisabled();
    await expect(panel.locator('.gspro-export__run-outer-dem')).toBeDisabled();
    await expect(panel.locator('.error')).toBeHidden();

    // Export saves the typed folder before it runs; the run itself fails here
    // (no pipeline in the isolated API), which is what surfaces the error.
    await dir.fill('D:/gspro_courses/e2e/opcd');
    await panel.locator(tid('gspro-tab-course')).click();
    await panel.locator(tid('gspro-run-svg')).click();
    await expect(panel.locator('.error')).toBeVisible();

    // The SVG test variants are a narrow panel beside the map, not part of
    // the dialog: the features they list are picked and shown on the map.
    await panel.locator(tid('gspro-open-svg')).click();
    await expect(panel).toBeHidden();
    await expect(page.locator(tid('gspro-svg-panel'))).toBeVisible();
    await page.locator(tid('gspro-svg-back')).click();
    await expect(panel).toBeVisible();

    await panel.locator('.gspro-export__header button').click();
    await expect(panel).not.toBeVisible();

    await openActionsMenu(page);
    await page.locator(tid('course-export-gspro-btn')).click();
    await expect(panel).toBeVisible();
    await expect(dir).toHaveValue('D:/gspro_courses/e2e/opcd');
    await expect(panel).toContainText('used every time you export it');
});
