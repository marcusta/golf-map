import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Vegetation test scene (web/dev/vegetation.html, served at /dev/vegetation by
 * vite dev). Opens the page, cycles the camera presets, saves one screenshot per
 * preset under docs/validation/vegetation/ and checks that every preset renders
 * trees within the layer's draw-call budget. Runs on SwiftShader: small viewport,
 * stand forced to half cards, sway off.
 */
const PRESETS_M = [3, 10, 40, 150, 600];
const OUT_DIR = resolve(__dirname, '../../docs/validation/vegetation');
/** Species passes (3) + impostors + shadows + shrubs + ground + atlas overlay. */
const MAX_DRAW_CALLS = 8;

interface PanelStats { drawCalls: number; visible: number; triangles: number; frameMedianMs: number; texturesReady: boolean; distanceM: number }

test('vegetation scene renders every camera preset within the draw-call budget', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 960, height: 600 });
    await mkdir(OUT_DIR, { recursive: true });
    await page.goto('/dev/vegetation?lod=half&sway=0&preset=40');
    const panel = page.getByTestId('vegetation-panel');
    await expect(panel).toBeVisible();
    const stats = async (): Promise<PanelStats> => JSON.parse((await panel.getAttribute('data-stats')) ?? '{}');
    await expect.poll(async () => (await stats()).texturesReady, { timeout: 60_000 }).toBe(true);
    // One HTML name tag per lineup stem (3 species x 4 variants + shrub) and ladder stem (2 x 5).
    await expect(page.getByTestId('stem-label')).toHaveCount(13 + 10);
    const results: Record<number, PanelStats> = {};
    for (const distance of PRESETS_M) {
        await page.getByTestId(`preset-${distance}`).click();
        await expect(page.getByTestId('camera-distance')).toContainText(`${distance}.0 m`);
        // Let the render loop settle (impostors rebake after a control change).
        await page.waitForTimeout(600);
        await expect.poll(async () => (await stats()).visible).toBeGreaterThan(0);
        const snapshot = await stats();
        results[distance] = snapshot;
        expect(snapshot.drawCalls, `draw calls at ${distance} m`).toBeGreaterThan(0);
        expect(snapshot.drawCalls, `draw calls at ${distance} m`).toBeLessThanOrEqual(MAX_DRAW_CALLS);
        expect(snapshot.triangles, `triangles at ${distance} m`).toBeGreaterThan(0);
        // The 150 m preset frames the whole lineup, every tag on screen.
        if (distance === 150) await expect(page.locator('[data-testid=stem-label][data-group=lineup]:not([hidden])')).toHaveCount(13);
        await page.screenshot({ path: resolve(OUT_DIR, `preset-${distance}m.png`) });
    }
    console.log('vegetation scene presets', JSON.stringify(results));
    // The atlas viewer draws one extra quad.
    await page.getByTestId('atlas-select').selectOption('impostor');
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(OUT_DIR, 'atlas-impostor.png') });
    expect((await stats()).drawCalls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
});
