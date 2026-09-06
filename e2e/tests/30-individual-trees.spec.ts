import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FURNITURE_COURSE_ID, HOLE_1, openPlanner, tid } from './fixtures';
import { wgs84ToSweref99tm } from '../../web/src/geo/transform';

test('40k stems render and cull; surface fallback and walk restore work', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const asset = await (await request.get(`/api/assets/get?id=${FURNITURE_COURSE_ID}-tile-manifest`)).json();
    const manifest = JSON.parse(asset.metaJson);
    const scratch = await mkdtemp(join(tmpdir(), 'golf-map-trees-e2e-'));
    const directory = resolve(__dirname, '../../data/tiles', FURNITURE_COURSE_ID);
    const destination = resolve(directory, 'tree-stems.json');
    await mkdir(scratch, { recursive: true });
    await mkdir(directory, { recursive: true });
    const center = wgs84ToSweref99tm(58.4015, 15.5658);
    const trees = Array.from({ length: 40_000 }, (_, i) => [center.x + (i % 200 - 100) * 8, center.y + (Math.floor(i / 200) - 100) * 8, 12 + i % 16, 2 + i % 4, 0]);
    await writeFile(resolve(scratch, 'e2e-tree-stems.json'), JSON.stringify({ version: 1, crs: 'EPSG:3006', fields: ['x', 'y', 'heightM', 'crownRadiusM', 'groundM'], trees }));
    // Refuse to replace an existing asset; clean the temporary link and metadata on failure.
    await symlink(resolve(scratch, 'e2e-tree-stems.json'), destination);
    try {
        manifest.assets = { 'tree-stems': { path: 'tree-stems.json', format: 'tree-stems-v1', count: trees.length } };
        expect((await request.post('/api/assets/update', { data: { id: asset.id, version: asset.version, metaJson: JSON.stringify(manifest) } })).ok()).toBe(true);
        // SwiftShader takes about a second per frame at the production bands (a million
        // card triangles in view). Pull the full-card band in to 30 m and the half-card
        // band to 120 m so most of the stand renders as impostors (dev-only flag).
        await openPlanner(page, FURNITURE_COURSE_ID, HOLE_1, { treeLod: '30,120' });
        // The layer exists once the map has loaded and the 40k-stem asset is parsed; slow on a cold vite dep cache.
        await expect.poll(() => page.evaluate(() => (window as any).__trees3d?.total), { timeout: 60_000 }).toBe(40_000);
        await page.locator(tid('map-layers-btn')).click();
        await page.locator(tid('layers-canopy-toggle')).click();
        await page.locator(tid('layers-trees3d-toggle')).click();
        const state = () => page.evaluate(() => ({ terrain: (window as any).__map.getTerrain().source, canopy: (window as any).__map.getLayoutProperty('course-canopy-color', 'visibility'), ...((window as any).__trees3d ?? {}) }));
        await expect.poll(state).toMatchObject({ terrain: 'course-terrain', canopy: 'none', total: 40_000 });
        await expect.poll(async () => (await state()).visible).toBeGreaterThan(0);
        expect((await state()).drawCalls).toBeLessThanOrEqual(16);
        await page.locator(tid('layers-terrain-surface')).click();
        await expect.poll(state).toMatchObject({ terrain: 'course-surface', canopy: 'visible', visible: 0 });
        await page.locator(tid('map-layers-btn')).click();
        const canvas = page.locator('.maplibregl-canvas');
        const box = (await canvas.boundingBox())!;
        await canvas.click({ position: { x: box.width / 2, y: box.height / 2 }, modifiers: ['Alt'] });
        await expect(page.locator(tid('walk-hud'))).toBeVisible();
        await expect.poll(state).toMatchObject({ terrain: 'course-terrain', canopy: 'none' });
        await page.waitForTimeout(1800);
        const standingAltitude = await page.evaluate(() => (window as any).__map.transform.getCameraAltitude());
        // Walk mode with terrain and trees runs at about one frame per second on
        // SwiftShader; a click needs several frames for its stability checks.
        const slow = { timeout: 45_000 };
        await page.locator(tid('map-layers-btn')).click(slow);
        await page.locator(tid('layers-terrain-surface')).click(slow);
        await expect.poll(async () => Math.abs(await page.evaluate(() => (window as any).__map.transform.getCameraAltitude()) - standingAltitude)).toBeLessThan(0.1);
        await page.locator(tid('layers-trees3d-toggle')).click(slow);
        await expect.poll(async () => Math.abs(await page.evaluate(() => (window as any).__map.transform.getCameraAltitude()) - standingAltitude)).toBeLessThan(0.1);
        await page.locator(tid('map-layers-btn')).click(slow);
        await page.keyboard.down('w');
        const perf = await page.evaluate(async () => {
            const intervals: number[] = [], cpu: number[] = [];
            const start = performance.now();
            let last = start;
            for (let i = 0; i < 120 && (i < 3 || performance.now() - start < 6000); i++) {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                const now = performance.now(); intervals.push(now - last); last = now;
                cpu.push((window as any).__trees3d.cpuMs);
            }
            intervals.sort((a, b) => a - b); cpu.sort((a, b) => a - b);
            const median = Math.floor(intervals.length / 2), p95 = Math.floor(intervals.length * 0.95);
            return { samples: intervals.length, frameMedianMs: intervals[median], frameP95Ms: intervals[p95], medianFps: 1000 / intervals[median], treeCpuMedianMs: cpu[median], treeCpuP95Ms: cpu[p95], stats: { ...(window as any).__trees3d } };
        });
        await page.keyboard.up('w');
        await writeFile(testInfo.outputPath('40k-trees-performance.json'), JSON.stringify(perf, null, 2));
        await testInfo.attach('40k-trees-performance.json', { body: JSON.stringify(perf, null, 2), contentType: 'application/json' });
        console.log('40k trees performance', JSON.stringify(perf));
        // Record software-GPU performance; hardware-specific 60 fps is measured separately.
        expect(perf.stats.visible).toBeGreaterThan(0);
        expect(perf.stats.visible).toBeLessThan(40_000);
        await page.keyboard.press('Escape');
        await expect.poll(state).toMatchObject({ terrain: 'course-surface', canopy: 'visible', visible: 0 });
    } finally {
        try {
            const latest = await (await request.get(`/api/assets/get?id=${asset.id}`)).json();
            await request.post('/api/assets/update', { data: { id: asset.id, version: latest.version, metaJson: asset.metaJson } });
        } finally {
            await unlink(destination);
            await rm(scratch, { recursive: true, force: true });
        }
    }
});
