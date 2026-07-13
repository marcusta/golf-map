import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid } from './fixtures';

/**
 * Flow (k) — the Courses list screen (redesign: course-list.component.ts,
 * courses.service.ts query/sortBy/groupBy). The seeded DB has exactly one
 * course, "Linkan" (course-1, draft, 2 holes — server/db/seeds/course.ts),
 * belonging to the "E2E Site" site (server/db/seed-e2e.ts) — so these specs
 * only need to prove the row renders correctly and that the toolbar
 * (search/sort/group) wiring works, not multi-course ordering.
 */

const ROW = `${tid('course-row')}[data-course-id="${TEST_COURSE_ID}"]`;

test('renders the seeded course row: name, metrics, status pill, thumbnail', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator(tid('courses'))).toBeVisible();

    const row = page.locator(ROW);
    await expect(row).toBeVisible();
    await expect(row.locator('.course-row__name')).toHaveText('Linkan');

    // Metric cluster: HOLES is the first metric — 2 holes seeded.
    await expect(row.locator('.course-row__metric').first().locator('.course-row__metric-value')).toHaveText('2');

    // Status pill — the seeded course is a draft.
    await expect(row.locator('.course-row__status')).toHaveText('Draft');
    await expect(row.locator('.course-row__status')).toHaveClass(/draft/);

    // Schematic thumbnail renders an svg.
    await expect(row.locator(`${tid('course-thumb')} svg`)).toHaveCount(1);
});

test('search filters rows by name/site; clearing restores them', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(ROW)).toBeVisible();

    await page.locator(tid('courses-search')).fill('zzz-no-such-course');

    await expect(page.locator(tid('course-row'))).toHaveCount(0);
    await expect(page.getByText('No courses match')).toBeVisible();

    await page.locator(tid('courses-search')).fill('');

    await expect(page.locator(ROW)).toBeVisible();
    await expect(page.getByText('No courses match')).not.toBeVisible();
});

test('sort popover opens with menu items and persists the selection (aria-checked)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(ROW)).toBeVisible();

    const trigger = page.locator(tid('courses-sort-trigger'));
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const panel = page.locator('.popover__panel.is-open');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'Name' })).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'Updated' })).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'Progress' })).toBeVisible();
    // Default sort is "Name" — its item starts checked.
    await expect(panel.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute('aria-checked', 'true');

    // Selecting an option closes the popover.
    await panel.getByRole('menuitemradio', { name: 'Updated' }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Reopen and confirm the choice persisted as the checked item.
    await trigger.click();
    const reopened = page.locator('.popover__panel.is-open');
    await expect(reopened.getByRole('menuitemradio', { name: 'Updated' })).toHaveAttribute('aria-checked', 'true');
    await expect(reopened.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute('aria-checked', 'false');
});

test('group popover opens with menu items and persists the selection (aria-checked)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(ROW)).toBeVisible();

    const trigger = page.locator(tid('courses-group-trigger'));
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const panel = page.locator('.popover__panel.is-open');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'Site' })).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'Status' })).toBeVisible();
    await expect(panel.getByRole('menuitemradio', { name: 'None' })).toBeVisible();
    // Default group is "None" (sites are 1:1 backfills of courses today) —
    // a fresh browser context has no persisted choice, so its item starts
    // checked. See courses.service.ts readStored(GROUP_KEY, GROUPS, 'none').
    await expect(panel.getByRole('menuitemradio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');

    await panel.getByRole('menuitemradio', { name: 'Status' }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    const reopened = page.locator('.popover__panel.is-open');
    await expect(reopened.getByRole('menuitemradio', { name: 'Status' })).toHaveAttribute('aria-checked', 'true');
    await expect(reopened.getByRole('menuitemradio', { name: 'None' })).toHaveAttribute('aria-checked', 'false');
});

test('clicking a course row navigates to its detail page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(ROW)).toBeVisible();

    await page.locator(ROW).click();

    await expect(page).toHaveURL(new RegExp(`/course/${TEST_COURSE_ID}$`));
    await expect(page.locator(tid('course-detail'))).toBeVisible();
});
