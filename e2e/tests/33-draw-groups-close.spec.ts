import { test, expect, type Page } from '@playwright/test';
import { FURNITURE_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

type Shape = { id: string; version: number; holeId: string | null; layer: string | null; type: string; geometry: { rings: { points: { corner?: boolean }[] }[] } };
type Scope = { id: string; version: number; number: number; drawingGroupName?: string | null };

async function shapes(page: Page): Promise<Shape[]> {
    return page.evaluate(async id => (await fetch('/api/features?courseId=' + id)).json(), FURNITURE_COURSE_ID);
}
async function scopes(page: Page, groups = false): Promise<Scope[]> {
    return page.evaluate(async ({ id, groups }) =>
        (await fetch('/api/holes?courseId=' + id + '&includeDrawingGroups=' + groups)).json(), { id: FURNITURE_COURSE_ID, groups });
}
async function openDraw(page: Page) {
    await page.goto('/course/' + FURNITURE_COURSE_ID);
    await waitForMapReady(page);
    await selectSubMode(page, 'draw');
}
async function openGroups(page: Page) {
    const details = page.locator('.drawing-groups');
    if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) await details.locator('summary').click();
}
async function addGroup(page: Page, name: string): Promise<Scope> {
    await openGroups(page);
    await page.locator(tid('drawing-group-name')).fill(name);
    await page.locator(tid('drawing-group-add')).click();
    await expect(page.locator(tid('draw-target-select'))).toContainText(name + ' (SVG only)');
    return (await scopes(page, true)).find(h => h.drawingGroupName === name)!;
}
async function center(page: Page) {
    return page.evaluate(() => {
        const r = (window as any).__map.getCanvas().getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
}
async function triangle(page: Page, dx = 0) {
    const mid = await center(page);
    await page.locator(tid('new-polygon-btn')).click();
    await page.mouse.click(mid.x + dx - 70, mid.y + 60);
    await page.mouse.click(mid.x + dx, mid.y - 60);
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.mouse.click(mid.x + dx + 70, mid.y + 60);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
}
async function cleanup(page: Page, before: Set<string>, original: Set<string>) {
    for (const f of (await shapes(page)).filter(f => !before.has(f.id))) {
        await page.request.post('/api/features/remove', { data: { id: f.id, version: f.version } });
    }
    for (const h of (await scopes(page, true)).filter(h => !original.has(h.id))) {
        await page.request.post('/api/holes/remove', { data: { id: h.id, version: h.version } });
    }
}

test('draw named SVG groups with forgiving close and Alt-click; rename, persist and move shapes', async ({ page }) => {
    await openDraw(page);
    const before = new Set((await shapes(page)).map(f => f.id));
    const original = new Set((await scopes(page, true)).map(h => h.id));
    const playable = await scopes(page);
    const target = page.locator(tid('draw-target-select'));
    try {
        await expect(page.locator(tid('draw-layers'))).toBeHidden();
        await expect(target).toBeVisible();
        await expect(page.locator(tid('stack-panel-scope'))).toBeVisible();
        const group = await addGroup(page, 'Clubhouse & garden');
        await expect(target).toHaveValue(group.id);
        await triangle(page, -90);
        await expect.poll(async () => (await shapes(page)).filter(f => !before.has(f.id)).length).toBe(1);
        let created = (await shapes(page)).filter(f => !before.has(f.id));
        expect(created[0].holeId).toBe(group.id);
        expect(created[0].geometry.rings[0].points).toHaveLength(3);
        expect(created[0].geometry.rings[0].points[2].corner).toBe(true);

        const mid = await center(page);
        await page.locator(tid('new-polygon-btn')).click();
        await page.mouse.click(mid.x + 30, mid.y + 65);
        await page.mouse.click(mid.x + 100, mid.y - 65);
        await page.mouse.click(mid.x + 170, mid.y + 65);
        await page.mouse.move(mid.x + 50, mid.y + 65);
        await page.screenshot({ path: 'e2e/test-results/draw-close-hover.png' });
        await page.mouse.click(mid.x + 50, mid.y + 65);
        await expect.poll(async () => (await shapes(page)).filter(f => !before.has(f.id)).length).toBe(2);
        created = (await shapes(page)).filter(f => !before.has(f.id));
        expect(created.every(f => f.geometry.rings[0].points.length === 3 && f.holeId === group.id)).toBe(true);
        await page.locator(tid('drawing-group-name')).fill('Practice garden');
        await page.locator(tid('drawing-group-rename')).click();
        await expect(target).toContainText('Practice garden (SVG only)');
        expect((await scopes(page)).map(h => h.id)).toEqual(playable.map(h => h.id));
        await page.reload();
        await waitForMapReady(page);
        await selectSubMode(page, 'draw');
        await target.selectOption(group.id);
        await openGroups(page);
        await expect(page.locator(tid('drawing-group-name'))).toHaveValue('Practice garden');
        await expect(page.locator(tid('drawing-group-remove'))).toBeDisabled();
        await page.locator(tid('stack-row')).first().click();
        await page.locator(tid('draw-move-hole')).selectOption('');
        await expect.poll(async () => (await shapes(page)).filter(f => f.holeId === group.id).length).toBe(1);
    } finally {
        await cleanup(page, before, original);
    }
});

test('one layer list moves groups across holes and reorders hole layers; Roughs stays fixed at the bottom', async ({ page }) => {
    await openDraw(page);
    const before = new Set((await shapes(page)).map(f => f.id));
    const original = new Set((await scopes(page, true)).map(h => h.id));
    const playable = await scopes(page);
    const layers = page.locator(tid('draw-layers'));
    const target = page.locator(tid('draw-target-select'));
    const scope = page.locator(tid('stack-panel-scope'));
    const edit = page.locator(tid('layer-order-edit'));
    const done = page.locator(tid('layer-order-done'));
    const up = page.locator(tid('layer-up'));
    const down = page.locator(tid('layer-down'));
    const values = () => layers.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value));
    const holeIds = [...playable].sort((a, b) => b.number - a.number).map(h => h.id);
    const keys = () => page.evaluate(() => Object.fromEntries(
        (window as any).__drawTool.features.geojson.get().features.map((f: any) => [f.id, f.properties.stackKey])));
    try {
        const a = await addGroup(page, 'Layer A');
        const b = await addGroup(page, 'Layer B');
        await edit.click();
        await expect(page.getByText('No features in this scope.', { exact: true })).toBeHidden();
        await expect.poll(values).toEqual(['', b.id, a.id, ...holeIds, '__roughs']);
        await layers.selectOption(a.id);
        // Move down once per hole: the same buttons cross hole boundaries.
        for (let i = 0; i < holeIds.length; i++) {
            const saved = (await scopes(page, true)).find(h => h.id === a.id)!.version;
            await down.click();
            await expect.poll(async () => (await scopes(page, true)).find(h => h.id === a.id)!.version).toBeGreaterThan(saved);
        }
        await expect.poll(values).toEqual(['', b.id, ...holeIds, a.id, '__roughs']);
        await expect(down).toBeDisabled();
        // Playable holes are selectable layers and can move too, without renumbering.
        const bottomHole = holeIds[holeIds.length - 1];
        await layers.selectOption(bottomHole);
        await down.click();
        const holesAbove = holeIds.filter(id => id !== bottomHole);
        await expect.poll(values).toEqual(['', b.id, ...holesAbove, a.id, bottomHole, '__roughs']);
        expect((await scopes(page)).map(h => [h.id, h.number])).toEqual(playable.map(h => [h.id, h.number]));
        await layers.selectOption('');
        await expect(up).toBeDisabled();
        await expect(down).toBeDisabled();
        await layers.selectOption('__roughs');
        await expect(up).toBeDisabled();
        await expect(down).toBeDisabled();

        await done.click();
        for (const group of [a, b]) {
            await target.selectOption(group.id);
            await triangle(page);
            await expect.poll(async () => (await shapes(page)).filter(f => f.holeId === group.id).length).toBe(1);
        }
        const created = (await shapes(page)).filter(f => !before.has(f.id));
        const shapeA = created.find(f => f.holeId === a.id)!;
        const shapeB = created.find(f => f.holeId === b.id)!;
        await expect.poll(async () => (await keys())[shapeB.id] > (await keys())[shapeA.id]).toBe(true);
        // Browsing a layer and selecting its contents is independent of the draw target.
        await scope.selectOption(a.id);
        const rowA = page.locator(tid('stack-row') + `[data-feature-id="${shapeA.id}"]`);
        await rowA.click();
        await expect(target).toHaveValue(b.id);
        await edit.click();
        await expect(page.locator(tid('stack-panel-rows'))).toBeHidden();
        await expect(page.getByTitle('Raise (PageUp)', { exact: true })).toBeHidden();
        await layers.selectOption(a.id);
        for (let i = 0; i < holesAbove.length + 1; i++) {
            const saved = (await scopes(page, true)).find(h => h.id === a.id)!.version;
            await up.click();
            await expect.poll(async () => (await scopes(page, true)).find(h => h.id === a.id)!.version).toBeGreaterThan(saved);
        }
        await expect.poll(async () => (await keys())[shapeA.id] > (await keys())[shapeB.id]).toBe(true);
        const ordered = await values();
        const remoteKeys = await page.evaluate(async courseId => {
            const json = await (await fetch('/api/features.geojson?courseId=' + courseId)).json();
            return Object.fromEntries(json.features.map((f: any) => [f.id, f.properties.stackKey]));
        }, FURNITURE_COURSE_ID);
        expect((await keys())[shapeA.id]).toBe(remoteKeys[shapeA.id]);
        await layers.selectOption(b.id);
        await done.click();
        await expect(layers).toBeHidden();
        await expect(scope).toHaveValue(a.id);
        await expect(target).toHaveValue(b.id);
        await expect(rowA).toBeVisible();
        await expect(rowA).toHaveClass(/selected/);
        await expect(page.locator(tid('draw-move-hole'))).toBeVisible();
        await page.screenshot({ path: 'e2e/test-results/drawing-layer-contents.png' });
        await page.reload();
        await waitForMapReady(page);
        await selectSubMode(page, 'draw');
        await expect(layers).toBeHidden();
        await edit.click();
        await expect.poll(values).toEqual(ordered);
        await layers.selectOption(b.id);
        await down.click();
        await expect.poll(values).not.toEqual(ordered);
        await page.screenshot({ path: 'e2e/test-results/drawing-layers.png' });

        await done.click();
        await target.selectOption('__roughs');
        await triangle(page);
        await expect.poll(async () => (await shapes(page)).filter(f => !before.has(f.id) && f.layer === 'roughs').length).toBe(1);
        const rough = (await shapes(page)).find(f => !before.has(f.id) && f.layer === 'roughs')!;
        expect(rough.holeId).toBeNull();
        expect(rough.type).toBe('rough');
        await page.keyboard.press('Control+z');
        await expect.poll(async () => (await shapes(page)).some(f => f.id === rough.id)).toBe(false);
        await page.keyboard.press('Control+Shift+z');
        await expect.poll(async () => (await shapes(page)).filter(f => !before.has(f.id) && f.layer === 'roughs').length).toBe(1);
        await expect(layers.locator('option').last()).toHaveText('Roughs (fixed bottom)');
    } finally {
        await cleanup(page, before, original);
    }
});
