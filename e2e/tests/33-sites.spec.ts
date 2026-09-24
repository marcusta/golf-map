import { test, expect } from '@playwright/test';
import { tid } from './fixtures';

/**
 * Site setup (web/src/sites/, new-course wizard site step). The seeded DB has
 * two sites, "E2E Site" (course-1) and "E2E Sandbox Site" (course-2). These tests only add new
 * courses and rename or detach the ones they added, so course-1 and the
 * course-2 sandbox keep their seeded shape.
 */

test('sites page: add a course on an existing site, rename it, detach it', async ({ page }) => {
    await page.goto('/');
    await page.locator(tid('courses-sites')).click();
    await expect(page.locator(tid('sites'))).toBeVisible();

    // Cards re-render on every write, so resolve the card and its rows fresh each time.
    const card = () => page.locator(`${tid('site-card')}:has(${tid('site-name')}[data-site="E2E Site"])`);
    const names = () => card().locator(tid('site-course-name'))
        .evaluateAll(els => els.map(el => (el as HTMLInputElement).value));

    await expect(card()).toHaveCount(1);
    // A site with courses cannot be deleted.
    await expect(card().getByRole('button', { name: 'Delete site' })).toBeDisabled();

    await card().locator(tid('site-add-name')).fill('Sites spec course');
    await card().locator(tid('site-add-course')).click();
    await expect.poll(names).toContain('Sites spec course');

    // Rename through the row input.
    const input = card().locator(tid('site-course-name')).nth((await names()).indexOf('Sites spec course'));
    await input.fill('Sites spec renamed');
    await input.blur();
    await expect.poll(names).toContain('Sites spec renamed');
    expect(await names()).not.toContain('Sites spec course');

    // Detach: the course moves to "Courses without a site".
    await card().locator(tid('site-course')).nth((await names()).indexOf('Sites spec renamed'))
        .getByRole('button', { name: 'Detach' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Detach' }).click();
    await expect.poll(names).not.toContain('Sites spec renamed');
    await expect(page.getByText('Courses without a site')).toBeVisible();

    // The course list picks the change up without a page reload.
    await page.getByRole('button', { name: 'Courses', exact: true }).click();
    await expect(page.locator('.course-row__name', { hasText: 'Sites spec renamed' })).toBeVisible();
});

test('new-course wizard: a course on an existing site is created without a build', async ({ page }) => {
    await page.goto('/new');

    await expect(page.locator(tid('wizard-new-site'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(tid('wizard-site-name'))).toBeVisible();

    await page.locator(tid('wizard-existing-site')).click();
    await expect(page.locator(tid('wizard-site-name'))).toBeHidden();
    const create = page.getByRole('button', { name: 'Create course' });
    await expect(create).toBeDisabled();

    await page.locator(tid('wizard-site-select')).selectOption({ label: 'E2E Site' });
    await page.locator(tid('wizard-course-name')).fill('Wizard spec course');
    await expect(create).toBeEnabled();
    await create.click();

    await expect(page).toHaveURL(/\/course\/[^/]+$/);

    await page.goto('/sites');
    await expect(page.locator(`${tid('site-course-name')}`).evaluateAll(
        els => els.map(el => (el as HTMLInputElement).value),
    )).resolves.toContain('Wizard spec course');
});

test('new-course wizard: the course name follows the site name until it is edited', async ({ page }) => {
    await page.goto('/new');
    await page.locator(tid('wizard-site-name')).fill('Ekerum Resort');
    await expect(page.locator(tid('wizard-course-name'))).toHaveValue('Ekerum Resort');

    await page.locator(tid('wizard-course-name')).fill('Långe Erik');
    await page.locator(tid('wizard-site-name')).fill('Ekerum');
    await expect(page.locator(tid('wizard-course-name'))).toHaveValue('Långe Erik');
});
