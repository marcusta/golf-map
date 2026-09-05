import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';
import { wgs84ToSweref99tm } from '../../web/src/geo/transform';

/**
 * Generated (pipeline) features in the editor: trees written through
 * `PUT /api/courses/:id/features/generated?source=lidar-canopy` carry a
 * non-null `source`. They render from their own map source
 * (`features-generated`, web/src/draw/features.service.ts), collapse into one
 * "Trees (lidar)" group row in the stack panel, select read-only (badge, no
 * vertex handles, no move/offset controls), and can still be deleted.
 * Hand-drawn trees keep full editing.
 *
 * Seeds two small squares around the map viewport (so real clicks hit them),
 * from the logged-in page context (storageState carries the session; the
 * route requires auth). Cleans up with an empty PUT and by deleting the
 * hand-drawn tree it draws.
 */

const SOURCE = 'lidar-canopy';
const GENERATED_SOURCE_ID = 'features-generated';
/** Same rightward bias as 08-feature-stack-panel.spec.ts (keeps clicks clear of the floating draw panel). */
const SAFE_DX = 180;
/**
 * Above the band other specs draw in (07/08 leave course-level shapes within
 * dy = -120..120 around SAFE_DX). D24 stacks by sortOrder within the course
 * level, so a hand-drawn leftover drawn later would sit ON TOP of a seeded
 * tree and take the click.
 */
const ROW_DY = -200;
const TREE_A = { dx: SAFE_DX, dy: ROW_DY, half: 40 };
const TREE_B = { dx: SAFE_DX - 120, dy: ROW_DY, half: 30 };

type MapHook = {
    getCanvas: () => HTMLCanvasElement;
    getSource: (id: string) => unknown;
    unproject: (p: [number, number]) => { lng: number; lat: number };
};
type ToolHook = {
    features: { generatedGeojson: { peek: () => { features: Array<{ id?: string | number }> } } };
    previewGeojson: () => { features: Array<{ properties?: { role?: string } }> };
};

function viewportPoint(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
    return page.evaluate(({ dx, dy }) => {
        const map = (window as unknown as { __map: MapHook }).__map;
        const rect = map.getCanvas().getBoundingClientRect();
        return { x: rect.left + rect.width / 2 + dx, y: rect.top + rect.height / 2 + dy };
    }, { dx, dy });
}

async function clickMapViewport(page: Page, dx: number, dy: number): Promise<void> {
    const p = await viewportPoint(page, dx, dy);
    await page.mouse.click(p.x, p.y);
}

/** Square polygon (EPSG:3006 ring) covering a screen box around a viewport offset. */
async function squareAt(page: Page, dx: number, dy: number, half: number): Promise<number[][][]> {
    const corners: Array<[number, number]> = [[dx - half, dy - half], [dx + half, dy - half], [dx + half, dy + half], [dx - half, dy + half]];
    const lngLats = await page.evaluate((pts) => {
        const map = (window as unknown as { __map: MapHook }).__map;
        const rect = map.getCanvas().getBoundingClientRect();
        return pts.map(([dx, dy]) => {
            const ll = map.unproject([rect.width / 2 + dx, rect.height / 2 + dy]);
            return { lng: ll.lng, lat: ll.lat };
        });
    }, corners);
    const ring = lngLats.map(ll => { const p = wgs84ToSweref99tm(ll.lat, ll.lng); return [p.x, p.y]; });
    ring.push(ring[0]!);
    return [ring];
}

async function putGenerated(page: Page, rings: number[][][][]): Promise<{ deleted: number; inserted: number }> {
    return page.evaluate(async ({ courseId, source, rings }) => {
        const body = {
            type: 'FeatureCollection',
            features: rings.map((coordinates, i) => ({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates },
                properties: { type: 'trees', source, heightMaxM: 17.2, heightP90M: 13.4, heightMeanM: 9.1, areaM2: 88 + i },
            })),
        };
        const r = await fetch(`/api/courses/${courseId}/features/generated?source=${source}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`PUT generated -> ${r.status} ${await r.text()}`);
        return r.json();
    }, { courseId: TEST_COURSE_ID, source: SOURCE, rings });
}

function generatedCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __drawTool: ToolHook }).__drawTool.features.generatedGeojson.peek().features.length);
}

function previewRoles(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as { __drawTool: ToolHook }).__drawTool.previewGeojson().features.map(f => f.properties?.role ?? ''));
}

async function handDrawnTrees(page: Page): Promise<Array<{ id: string; version: number }>> {
    return page.evaluate(async (courseId) => {
        const r = await fetch(`/api/features?courseId=${courseId}`);
        const rows: Array<{ id: string; version: number; type: string; source: string | null }> = await r.json();
        return rows.filter(f => f.type === 'trees' && f.source === null).map(f => ({ id: f.id, version: f.version }));
    }, TEST_COURSE_ID);
}

async function openDraw(page: Page): Promise<void> {
    await page.goto(`/course/${TEST_COURSE_ID}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await waitForMapReady(page);
    await selectSubMode(page, 'draw');
    await expect(page.locator(tid('stack-panel'))).toBeVisible();
}

test.afterEach(async ({ page }) => {
    // Never leave generated rows behind for the later specs (shared DB, serial).
    await putGenerated(page, []).catch(() => undefined);
    for (const t of await handDrawnTrees(page).catch(() => [])) {
        await page.evaluate(async (input) => {
            await fetch('/api/features/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        }, t);
    }
});

test('generated lidar trees render read-only, group in the stack panel, delete, and leave hand-drawn trees editable', async ({ page }) => {
    await openDraw(page);
    const baselineHandDrawn = (await handDrawnTrees(page)).length;

    // Seed two generated trees where the viewport is looking, then reload so
    // the course load picks them up.
    const seeded = await putGenerated(page, [
        await squareAt(page, TREE_A.dx, TREE_A.dy, TREE_A.half),
        await squareAt(page, TREE_B.dx, TREE_B.dy, TREE_B.half),
    ]);
    expect(seeded.inserted).toBe(2);
    await openDraw(page);

    // Own map source, populated with exactly the generated set.
    await expect.poll(() => generatedCount(page)).toBe(2);
    expect(await page.evaluate((id) => !!(window as unknown as { __map: MapHook }).__map.getSource(id), GENERATED_SOURCE_ID)).toBe(true);

    // Stack panel: one collapsed group row, no per-tree rows.
    const groupRow = page.locator(tid('stack-group-row'));
    await expect(groupRow).toHaveCount(1);
    await expect(groupRow).toContainText('Trees (lidar)');
    await expect(groupRow).toContainText('2');
    await expect(page.locator(`${tid('stack-row')}[data-generated="true"]`)).toHaveCount(0);

    // Select tree A: read-only panel, no edit handles.
    await clickMapViewport(page, TREE_A.dx, TREE_A.dy);
    const badge = page.locator(tid('selection-generated-badge'));
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Generated from lidar · Height ~13 m');
    await expect(page.locator(tid('draw-move-hole'))).toBeHidden();
    await expect(page.locator('.sel-panel .offset-section')).toBeHidden();
    await expect(page.locator('.sel-panel .vertex-ops')).toBeHidden();
    const roles = await previewRoles(page);
    expect(roles.filter(r => r.startsWith('vertex') || r === 'handle' || r === 'control-cage')).toEqual([]);
    // The selected tree is listed once, under its group row.
    await expect(page.locator(`${tid('stack-row')}[data-generated="true"]`)).toHaveCount(1);

    // Delete is allowed.
    await page.locator('.sel-panel .delete-btn').click();
    await page.locator('.confirm-dialog--default .confirm-dialog__confirm').click();
    await expect.poll(() => generatedCount(page)).toBe(1);
    await expect(groupRow).toContainText('1');
    await expect(badge).toBeHidden();

    // Hand-drawn tree in the freed spot: full editing (vertex markers, no badge).
    await page.keyboard.press('8'); // trees
    const newPoly = page.locator(tid('new-polygon-btn'));
    if ((await newPoly.getAttribute('aria-pressed')) !== 'true') await newPoly.click();
    const half = 50;
    const corners: Array<[number, number]> = [
        [SAFE_DX - half, ROW_DY - half], [SAFE_DX + half, ROW_DY - half], [SAFE_DX + half, ROW_DY + half], [SAFE_DX - half, ROW_DY + half],
    ];
    for (const [dx, dy] of corners) await clickMapViewport(page, dx, dy);
    await clickMapViewport(page, ...corners[0]!);
    await expect.poll(async () => (await handDrawnTrees(page)).length).toBe(baselineHandDrawn + 1);
    if ((await newPoly.getAttribute('aria-pressed')) === 'true') await newPoly.click();
    await clickMapViewport(page, SAFE_DX, ROW_DY);
    await expect(page.locator(tid('selection-panel'))).toBeVisible();
    await expect(badge).toBeHidden();
    await expect(page.locator(tid('draw-move-hole'))).toBeVisible();
    await expect.poll(async () => (await previewRoles(page)).filter(r => r.startsWith('vertex')).length).toBeGreaterThanOrEqual(4);
    // Generated set untouched by the hand-drawn work.
    expect(await generatedCount(page)).toBe(1);
});
