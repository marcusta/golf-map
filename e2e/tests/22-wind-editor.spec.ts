import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_1, tid, openPlanner } from './fixtures';

/**
 * The iOS-parity wind editor (dial + slider + scope, replacing the old raw
 * number inputs): dragging the dial sets the direction, the slider sets the
 * speed (both commit on release), the scope picker migrates the value between
 * the plan wind and a hole override, and Clear returns the plan to calm.
 * Serial-suite hygiene: the spec ends with the plan wind cleared so later
 * specs still see a calm course.
 */
test('wind editor: dial + slider write the plan wind; scope migrates; clear calms', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, HOLE_1);

    const section = page.locator(tid('planner-wind-section'));
    await section.scrollIntoViewIfNeeded();
    const effective = page.locator(tid('planner-wind-effective'));
    await expect(effective).toContainText('calm');

    // Drag the dial's knob to due EAST of centre. All-holes scope renders
    // north-up, and the knob marks where the wind blows TO — so east means
    // the wind comes FROM the west (270°).
    const dial = page.locator(tid('planner-wind-dial'));
    const box = (await dial.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx + box.width * 0.3, cy);
    await page.mouse.down();
    await page.mouse.up();
    await expect(effective).toContainText('from 270°');

    // Slider: keyboard steps fire input+change (0 → 1.0 m/s in 0.5 steps).
    const slider = page.locator(tid('planner-wind-speed'));
    await slider.focus();
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    await expect(effective).toContainText('1.0 m/s');

    // Scope → this hole migrates the current values into a hole override.
    await page.locator(tid('planner-wind-scope-hole')).click();
    await expect(page.locator(tid('planner-wind-scope-hole'))).toHaveAttribute('aria-pressed', 'true');
    const clearBtn = page.locator(tid('planner-wind-clear'));
    await expect(clearBtn).toContainText('override');
    await expect(effective).toContainText('1.0 m/s');

    // Clearing the override falls back to the (identical) plan wind…
    await clearBtn.click();
    await expect(page.locator(tid('planner-wind-scope-all'))).toHaveAttribute('aria-pressed', 'true');
    await expect(effective).toContainText('1.0 m/s');

    // …and clearing at all-holes scope returns the course to calm.
    await clearBtn.click();
    await expect(effective).toContainText('calm');
});
