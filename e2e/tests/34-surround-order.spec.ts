import { test, expect } from '@playwright/test';
import { FURNITURE_COURSE_ID, TEST_USERNAME, TEST_PASSWORD, tid, waitForMapReady, selectSubMode } from './fixtures';

test('Surround with inserts directly below its source and keeps the order through undo, redo and reload', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { username: TEST_USERNAME, password: TEST_PASSWORD } });
    expect(login.ok()).toBe(true);
    type Shape = { id: string; version: number; holeId: string | null; layer: string | null; type: string; sortOrder: number };
    const list = async (): Promise<Shape[]> => {
        const response = await page.request.get('/api/features', { params: { courseId: FURNITURE_COURSE_ID } });
        return response.json();
    };
    const before = new Set((await list()).map(f => f.id));
    try {
        const sources: Shape[] = [];
        for (const type of ['green', 'green', 'rough']) {
            const response = await page.request.post('/api/features/create', { data: {
                courseId: FURNITURE_COURSE_ID, type,
                geometry: { crs: 'EPSG:3006', rings: [{ points: [
                    { x: 533000, y: 6470000 }, { x: 533020, y: 6470000 },
                    { x: 533020, y: 6470020 }, { x: 533000, y: 6470020 },
                ] }] },
            } });
            expect(response.ok()).toBe(true);
            sources.push(await response.json());
        }
        const peers = (await list()).filter(f => !f.holeId && !f.layer && before.has(f.id));
        const reorder = await page.request.post('/api/course-features/reorder', { data: {
            courseId: FURNITURE_COURSE_ID, orderedIds: [...peers.map(f => f.id), ...sources.map(f => f.id)],
        } });
        expect(reorder.ok()).toBe(true);

        await page.goto('/course/' + FURNITURE_COURSE_ID);
        await waitForMapReady(page);
        await selectSubMode(page, 'draw');
        await page.locator(tid('stack-panel-scope')).selectOption('');
        await page.locator(`${tid('stack-row')}[data-feature-id="${sources[1].id}"]`).click();
        await page.getByRole('button', { name: /^Surround with Fairway/i }).click();
        const order = async () => (await list()).filter(f => !before.has(f.id)).map(f => f.type);
        const checkRows = async () => {
            const ids = (await list()).filter(f => !before.has(f.id)).map(f => f.id).reverse();
            const rows = page.locator(tid('stack-row'));
            await expect.poll(async () => (await rows.evaluateAll(elements =>
                elements.map(el => (el as HTMLElement).dataset.featureId)))
                .filter(id => ids.includes(id!))).toEqual(ids);
        };
        await expect.poll(order).toEqual(['green', 'fairway', 'green', 'rough']);
        await checkRows();
        await page.screenshot({ path: 'e2e/test-results/surround-order.png' });
        await page.keyboard.press('Control+z');
        await expect.poll(order).toEqual(['green', 'green', 'rough']);
        await page.keyboard.press('Control+Shift+z');
        await expect.poll(order).toEqual(['green', 'fairway', 'green', 'rough']);
        await checkRows();
        await page.reload();
        await waitForMapReady(page);
        await selectSubMode(page, 'draw');
        await page.locator(tid('stack-panel-scope')).selectOption('');
        await checkRows();
    } finally {
        for (const f of (await list()).filter(f => !before.has(f.id))) {
            await page.request.post('/api/features/remove', { data: { id: f.id, version: f.version } });
        }
    }
});
