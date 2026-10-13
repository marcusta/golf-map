import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, openActionsMenu } from './fixtures';

/**
 * The "GSPro…" actions-menu row and its dialog — the status board: one row per
 * target (terrain, photo, course shapes, meshes, vegetation, trees, buildings,
 * creeks, course file) with "last updated / what changed since / Update", and
 * every single-file export behind the row's "…" details toggle.
 *
 * What this covers is the journey that matters: open the board, see what the
 * server says about a course it cannot build yet, and the export folder — a
 * server-side setting kept per course — set once and still there next time.
 * The seed course has no map area and no orthophoto, so the terrain and photo
 * rows come back BLOCKED with the reason in place and their Update off, rather
 * than failing the dialog.
 *
 * No Update is clicked: an update shells out to the pipeline's Python and the
 * local Unity editor, which the isolated e2e API has neither of. The server's
 * decisions are pinned by server/services/gspro-sync.service.test.ts, the
 * client's by web/tests/gspro-sync.service.test.ts and the dialog's by
 * web/tests/gspro-export-panel.render.test.ts. The SVG export button in the
 * Course shapes row IS clicked, to make the typed folder stick — the run
 * itself fails here (no venv), which is what surfaces the error.
 */
test('actions menu opens the GSPro board; the folder is per course and remembered', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();

    await openActionsMenu(page);
    const row = page.locator(tid('course-export-gspro-btn'));
    await expect(row).toBeVisible();
    await expect(row).toContainText('GSPro');
    await row.click();

    // The board is a dialog over the page: header (Unity chip), folder and
    // "Update all stale", the update job when there is one, then the rows.
    const panel = page.locator(tid('gspro-dialog'));
    await expect(panel).toBeVisible();
    await expect(panel.locator('h3')).toHaveText('GSPro');
    const dir = panel.locator(tid('gspro-dir'));

    // Untouched course: blank field, the default offered as the placeholder
    // and named in the hint.
    await expect(dir).toHaveValue('');
    expect(await dir.getAttribute('placeholder')).toMatch(/Downloads/);
    await expect(panel).toContainText('Leave blank for the default');

    // One row per target, in board order, each with its own Update.
    for (const target of ['terrain', 'photo', 'shapes', 'meshes', 'vegetation', 'trees', 'buildings', 'creeks', 'course-file']) {
        await expect(panel.locator(tid(`gspro-row-${target}`))).toBeVisible();
    }
    await expect(panel.locator(tid('gspro-update-stale'))).toContainText('Update all stale');

    // No map area and no orthophoto: those two rows say why in place and
    // cannot be updated. Course shapes names the Blender step that follows it.
    await expect(panel.locator(tid('gspro-blocked-terrain'))).toContainText('no map area');
    await expect(panel.locator(tid('gspro-update-terrain'))).toBeDisabled();
    await expect(panel.locator(tid('gspro-blocked-photo'))).toContainText('Build the map first');
    await expect(panel.locator(tid('gspro-update-photo'))).toBeDisabled();
    await expect(panel.locator(tid('gspro-manual-shapes'))).toContainText('then: Build the SVG in Blender');
    // Nothing of this course is open in Unity on the e2e box.
    await expect(panel.locator(tid('gspro-unity-chip'))).toContainText('Unity: not open for this course');
    // A blocked row is not a dialog-level failure.
    await expect(panel.locator('.error')).toBeHidden();

    // The Photo row's "…" holds what the Textures tab used to: no persisted
    // orthophoto for the seed course, so the picker stays hidden, the hint
    // explains and the JPEG buttons cannot be pressed.
    await panel.locator(tid('gspro-details-photo')).click();
    const photo = panel.locator(tid('gspro-panel-photo'));
    await expect(photo).toBeVisible();
    await expect(photo).toContainText('build its map first');
    await expect(photo.locator(tid('gspro-ortho-source'))).toBeHidden();
    await expect(photo.locator('.gspro-export__run-ortho')).toBeDisabled();
    await expect(photo.locator('.gspro-export__run-outer-ortho')).toBeDisabled();

    // The Terrain row's: the two terrain squares cannot be laid out, so the
    // heightmap exports stay off — while the folder and the SVG keep working.
    await panel.locator(tid('gspro-details-terrain')).click();
    const terrain = panel.locator(tid('gspro-panel-terrain'));
    await expect(terrain).toContainText('Inner terrain');
    await expect(terrain).toContainText('Outer terrain');
    await expect(terrain).toContainText('Terrains unavailable');
    await expect(terrain).toContainText('no map area');
    await expect(terrain.locator('.gspro-export__run-inner-dem')).toBeDisabled();
    await expect(terrain.locator('.gspro-export__run-outer-dem')).toBeDisabled();

    // Exporting one file saves the typed folder before it runs; the run itself
    // fails here (no pipeline in the isolated API), which surfaces the error.
    await dir.fill('D:/gspro_courses/e2e/opcd');
    await panel.locator(tid('gspro-details-shapes')).click();
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
