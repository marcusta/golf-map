import { test as setup, expect } from '@playwright/test';
import { E2E_STORAGE_STATE } from '../playwright.config';
import { TEST_USERNAME, TEST_PASSWORD } from './fixtures';

/**
 * Authenticate once and persist the session cookie to storageState. Runs as
 * the `setup` project dependency, so it executes after the webServers are up
 * but before any smoke test. Logs in through the SAME login endpoint the app
 * uses (POST /api/auth/login, proxied by vite to the isolated API) and sets
 * the httpOnly `session` cookie on the browser context.
 */
setup('authenticate as the seed user', async ({ page, context, baseURL }) => {
    const res = await context.request.post(`${baseURL}/api/auth/login`, {
        data: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.ok(), `login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.username).toBe(TEST_USERNAME);

    // Confirm the session cookie actually stuck before persisting it.
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === 'session')).toBeTruthy();

    await context.storageState({ path: E2E_STORAGE_STATE });
    // Sanity: the authenticated app renders (not bounced to /login).
    await page.goto(`${baseURL}/`);
    await expect(page).not.toHaveURL(/\/login$/);
});
