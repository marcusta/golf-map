import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, openActionsMenu, openModeMenu } from './fixtures';
import { EDITOR_TOOL_IDS } from './tool-ids';

/**
 * Flow (a) — the seam. Authenticated load of the seeded course renders the
 * detail chrome, and once the map is ready the editor toolbar + EVERY tool
 * button is present. This directly guards the transient "toolbar disappeared"
 * regression: the toolbar is gated on MapService.ready, so a broken map-boot
 * or a lost tool registration surfaces here.
 *
 * Command-bar redesign (Builder v2): the tool buttons now live inside the
 * sub-mode dropdown popover (`submode-trigger`), Plan lives inside the zone-2
 * mode dropdown (`mode-trigger`), and Import SVG lives inside the "⋯" actions
 * menu (`actions-menu-trigger`) — all three must be opened first. The
 * `editor-toolbar` element itself is now a `display:contents` lifecycle
 * controller with no visible box (editor/toolbar.component.ts) — it never
 * renders chrome, so the contextual right dock is the visible proof the
 * toolbar/tools actually mounted.
 */
test('course detail loads with toolbar and all tool buttons', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);

    // Detail page + course name (seeded "Linkan") render before the map.
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await expect(page.locator(tid('course-name'))).toHaveText('Linkan');

    // The toolbar only shows once the map is ready. It renders no box of its
    // own (display:contents) — assert on the contextual dock it drives instead.
    await waitForMapReady(page);
    await expect(page.locator(tid('feature-dock'))).toBeVisible();

    // Every registered tool has its button, inside the sub-mode dropdown.
    await page.locator(tid('submode-trigger')).click();
    for (const toolId of EDITOR_TOOL_IDS) {
        await expect(
            page.locator(tid(`tool-btn-${toolId}`)),
            `tool button for "${toolId}" should be present`,
        ).toBeVisible();
    }

    // Header actions: Plan is a row inside the mode dropdown (opening it also
    // closes the sub-mode dropdown still open above — only one popover open at
    // a time, see ui/popover.component.ts); Import SVG is behind the "⋯" menu.
    // Deliberately don't click the Plan row — it navigates to /planner, which
    // would break the Import SVG assertion below (Create-mode only).
    await openModeMenu(page);
    await expect(page.locator(tid('course-plan-btn'))).toBeVisible();
    await openActionsMenu(page);
    await expect(page.locator(tid('course-import-svg-btn'))).toBeVisible();
});
