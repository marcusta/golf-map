import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

interface CourseFeatureRow {
    id: string;
    holeId: string | null;
    sortOrder: number;
}

interface HoleRow {
    id: string;
    number: number;
}

async function allFeatures(page: Page): Promise<CourseFeatureRow[]> {
    return page.evaluate(async (courseId) => {
        const r = await fetch(`/api/features?courseId=${courseId}`);
        if (!r.ok) throw new Error(`features -> ${r.status} ${await r.text()}`);
        return r.json();
    }, TEST_COURSE_ID);
}

async function courseLevelFeatures(page: Page): Promise<CourseFeatureRow[]> {
    return (await allFeatures(page)).filter(f => f.holeId === null);
}

async function holes(page: Page): Promise<HoleRow[]> {
    return page.evaluate(async (courseId) => {
        const r = await fetch(`/api/holes?courseId=${courseId}`);
        if (!r.ok) throw new Error(`holes -> ${r.status} ${await r.text()}`);
        return r.json();
    }, TEST_COURSE_ID);
}

/** Click a point offset from the map viewport's center, in screen pixels. */
async function clickMapViewport(page: Page, dx: number, dy: number): Promise<void> {
    const p = await page.evaluate(
        ({ dx, dy }) => {
            const map = (window as unknown as { __map?: { getCanvas: () => HTMLCanvasElement } }).__map!;
            const rect = map.getCanvas().getBoundingClientRect();
            return { x: rect.left + rect.width / 2 + dx, y: rect.top + rect.height / 2 + dy };
        },
        { dx, dy },
    );
    await page.mouse.click(p.x, p.y);
}

/**
 * Rightward bias for all map clicks in this file. The floating draw-panel
 * (editor-toolbar's per-tool panel) sits top-left over the map canvas at
 * OVERLAY_INSET (20px) + OVERLAY_W.standard (340px) = 360px from the canvas's
 * left edge (web/src/css.ts), and grows tall once a feature is selected —
 * which, with the permanent hole/feature docks now narrowing the canvas
 * (Builder redesign v2), puts the canvas's own horizontal CENTER only ~14px
 * clear of the panel's right edge. Anchoring square/point clicks here instead
 * of at dead-center keeps every click safely right of the panel regardless of
 * its current height.
 *
 * This is a dx OFFSET FROM CANVAS CENTER (clickMapViewport's own frame), not
 * an absolute canvas-relative x. Canvas center sits ~374px from the canvas's
 * left edge (canvas width 748px ÷ 2, per the redesign's docked layout), so
 * dx=180 lands ~554px from the left edge — comfortably clear of the panel's
 * right edge (360px) and, with the largest halfSize used here (120), still
 * well inside the canvas's right edge (748px).
 */
const SAFE_DX = 180;

/**
 * Arm the polygon tool if it isn't already. Chain-draw (draw-tool.service.ts
 * `closeDraft`) deliberately keeps the tool ARMED after a ring closes, so for
 * every square after the first the same toolbar button reads "Cancel drawing"
 * with aria-pressed=true (command-bar.component.ts `newPoly`) — clicking it
 * blindly would DISARM the tool and turn the next corner clicks into
 * selection clicks.
 */
async function armDraw(page: Page): Promise<void> {
    const btn = page.getByRole('button', { name: /New polygon|Cancel drawing/ });
    await expect(btn).toBeVisible();
    if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
}

/**
 * Leave draw mode. Needed before any map click meant to SELECT: chain-draw
 * re-arms the tool after each close, and an armed tool treats a map click as
 * the first point of the next polygon, not a hit-test.
 */
async function disarmDraw(page: Page): Promise<void> {
    const btn = page.getByRole('button', { name: /New polygon|Cancel drawing/ });
    if ((await btn.getAttribute('aria-pressed')) === 'true') await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
}

/** Draw a closed square (course-level, default draw type) via real clicks: 4 corners, then re-click the first to close the ring. */
async function drawSquare(page: Page, halfSize: number): Promise<void> {
    await armDraw(page);
    const corners: Array<[number, number]> = [
        [SAFE_DX - halfSize, -halfSize],
        [SAFE_DX + halfSize, -halfSize],
        [SAFE_DX + halfSize, halfSize],
        [SAFE_DX - halfSize, halfSize],
    ];
    for (const [dx, dy] of corners) await clickMapViewport(page, dx, dy);
    await clickMapViewport(page, ...corners[0]!); // re-click first point closes the ring
}

function rowIds(page: Page): Promise<string[]> {
    return page.locator(tid('stack-row')).evaluateAll(
        els => els.map(el => (el as HTMLElement).dataset.featureId!),
    );
}

/**
 * T25 smoke (acceptance-scenario spirit, D27 interaction conventions): draw
 * two overlapping course-level shapes, confirm the stack panel lists them
 * topmost-first, reorder the bottom one to the top via the panel button, and
 * confirm both the row order and map<->panel selection stay in sync.
 */
test('feature-stack panel reorders and stays selection-synced with the map', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await waitForMapReady(page);

    await selectSubMode(page, 'draw');
    await expect(page.locator(tid('stack-panel'))).toBeVisible();

    const before = (await courseLevelFeatures(page)).length;
    await drawSquare(page, 120); // A — drawn first, ends up at the bottom
    await expect.poll(async () => (await courseLevelFeatures(page)).length).toBe(before + 1);
    await drawSquare(page, 50); // B — drawn second, fully inside A, ends up on top
    await expect.poll(async () => (await courseLevelFeatures(page)).length).toBe(before + 2);
    // Done drawing — the map clicks below are hit-tests, not new points.
    await disarmDraw(page);

    const rows = await courseLevelFeatures(page);
    const [featureA, featureB] = [...rows].sort((a, b) => a.sortOrder - b.sortOrder).slice(-2);
    expect(featureA!.sortOrder).toBeLessThan(featureB!.sortOrder);

    // Panel lists topmost-first (D27): B (top) before A (bottom).
    await expect.poll(() => rowIds(page)).toEqual([featureB!.id, featureA!.id]);

    // Selecting A's row selects it (bidirectional): the row highlights...
    await page.locator(`${tid('stack-row')}[data-feature-id="${featureA!.id}"]`).click();
    await expect(page.locator(`${tid('stack-row')}[data-feature-id="${featureA!.id}"]`)).toHaveClass(/selected/);

    // ...raising it to the top flips the row order...
    await page.getByRole('button', { name: /Top/ }).click();
    await expect.poll(() => rowIds(page)).toEqual([featureA!.id, featureB!.id]);

    // ...and clicking A on the map (now the topmost, covering B's whole area)
    // re-selects it via the map's own hit-test, syncing back to the panel row.
    await page.locator(`${tid('stack-row')}[data-feature-id="${featureB!.id}"]`).click();
    await expect(page.locator(`${tid('stack-row')}[data-feature-id="${featureB!.id}"]`)).toHaveClass(/selected/);
    await clickMapViewport(page, SAFE_DX, 0); // shapes are centred at SAFE_DX, not viewport dead-center
    await expect(page.locator(`${tid('stack-row')}[data-feature-id="${featureA!.id}"]`)).toHaveClass(/selected/);
});

test('draw target follows selected hole and selected features can move to course level', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}?hole=2`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await waitForMapReady(page);
    const hole2 = (await holes(page)).find(h => h.number === 2)!;

    await selectSubMode(page, 'draw');
    await expect(page.locator(tid('draw-target'))).toContainText('Hole 2');
    await expect(page.locator(tid('stack-panel-scope'))).toHaveValue(hole2.id);

    const beforeIds = new Set((await allFeatures(page)).map(f => f.id));
    await drawSquare(page, 70);
    await expect.poll(async () =>
        (await allFeatures(page)).find(f => !beforeIds.has(f.id) && f.holeId === hole2.id)?.id ?? null,
    ).not.toBeNull();
    const created = (await allFeatures(page)).find(f => !beforeIds.has(f.id) && f.holeId === hole2.id)!;

    const moveSelect = page.locator(tid('draw-move-hole'));
    await expect(moveSelect).toBeVisible();
    await expect(moveSelect).toHaveValue(hole2.id);

    await moveSelect.selectOption('');
    await expect.poll(async () =>
        (await allFeatures(page)).find(f => f.id === created!.id)?.holeId,
    ).toBeNull();
});
