import { test, expect, type Page } from '@playwright/test';
import { TEST_COURSE_ID, HOLE_2_PAR3, tid, waitForMapReady } from './fixtures';

type Hole = { id: string; number: number };
type Tee = { id: string; lat: number; lon: number };
type AimPoint = { id: string; lat: number; lon: number };
type Green = { id: string } | null;

async function apiGet<T>(page: Page, path: string): Promise<T> {
    return page.evaluate(async (p) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
        return r.json();
    }, path);
}

async function holes(page: Page): Promise<Hole[]> {
    return apiGet<Hole[]>(page, `/api/holes?courseId=${TEST_COURSE_ID}`);
}

async function teesForHole(page: Page, holeId: string): Promise<Tee[]> {
    return apiGet<Tee[]>(page, `/api/tees?holeId=${holeId}`);
}

async function aimsForHole(page: Page, holeId: string): Promise<AimPoint[]> {
    return apiGet<AimPoint[]>(page, `/api/aim-points?holeId=${holeId}`);
}

async function greenForHole(page: Page, holeId: string): Promise<Green> {
    return apiGet<Green>(page, `/api/greens?holeId=${holeId}`);
}

async function clickMapViewport(page: Page, dx = 0, dy = 0): Promise<void> {
    const p = await page.evaluate(
        ({ dx, dy }) => {
            const map = (window as unknown as {
                __map?: { getCanvas: () => HTMLCanvasElement };
            }).__map!;
            const rect = map.getCanvas().getBoundingClientRect();
            return { x: rect.left + rect.width / 2 + dx, y: rect.top + rect.height / 2 + dy };
        },
        { dx, dy },
    );
    await page.mouse.click(p.x, p.y);
}

async function waitForMapIdle(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const map = (window as unknown as {
            __map?: { isMoving: () => boolean; once: (event: 'idle', cb: () => void) => void };
        }).__map!;
        if (!map.isMoving()) return;
        await new Promise<void>(resolve => map.once('idle', resolve));
    });
}

async function dragMapLngLat(page: Page, lon: number, lat: number, dx = 36, dy = 24): Promise<void> {
    const p = await page.evaluate(
        ({ lon, lat }) => {
            const map = (window as unknown as {
                __map?: {
                    getCanvas: () => HTMLCanvasElement;
                    project: (lngLat: [number, number]) => { x: number; y: number };
                };
            }).__map!;
            const rect = map.getCanvas().getBoundingClientRect();
            const point = map.project([lon, lat]);
            return { x: rect.left + point.x, y: rect.top + point.y };
        },
        { lon, lat },
    );
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 6 });
    await page.mouse.up();
}

/**
 * Furniture mode smoke: a real user can add/edit furniture on an existing
 * hole, then add a new hole and place tee / aim / green centre on it.
 */
test('furniture mode can place markers on existing and newly added holes', async ({ page }) => {
    await page.goto(`/course/${TEST_COURSE_ID}?hole=${HOLE_2_PAR3}`);
    await expect(page.locator(tid('course-detail'))).toBeVisible();
    await waitForMapReady(page);

    await page.locator(tid('tool-btn-furniture')).click();
    await expect(page.getByText('Course holes')).toBeVisible();

    const hole2 = (await holes(page)).find(h => h.number === HOLE_2_PAR3)!;
    expect(hole2).toBeTruthy();
    await waitForMapIdle(page);

    const existingTee = (await teesForHole(page, hole2.id))[0]!;
    expect(existingTee).toBeTruthy();
    await dragMapLngLat(page, existingTee.lon, existingTee.lat);
    await expect.poll(async () => {
        const moved = (await teesForHole(page, hole2.id)).find(t => t.id === existingTee.id)!;
        return Math.hypot(moved.lat - existingTee.lat, moved.lon - existingTee.lon) > 0.000001;
    }).toBe(true);

    const existingAimCount = (await aimsForHole(page, hole2.id)).length;

    await page.getByRole('button', { name: /Aim/ }).click();
    await clickMapViewport(page, 90, -40);
    await expect.poll(async () => (await aimsForHole(page, hole2.id)).length).toBe(existingAimCount + 1);

    await page.getByRole('button', { name: /Add hole/ }).click();
    await expect
        .poll(async () => (await holes(page)).find(h => h.number === 3) ?? null)
        .not.toBeNull();

    const hole3 = (await holes(page)).find(h => h.number === 3)!;
    await expect(page).toHaveURL(/hole=3/);
    await expect(page.getByText(/Placing: Tee .* on hole 3/)).toBeVisible();

    // Add hole leaves Tee armed; the first click should create a tee.
    await clickMapViewport(page, -80, -40);
    await expect.poll(async () => (await teesForHole(page, hole3.id)).length).toBe(1);

    await page.getByRole('button', { name: /Aim/ }).click();
    await clickMapViewport(page, 0, 0);
    await expect.poll(async () => (await aimsForHole(page, hole3.id)).length).toBe(1);

    // Anchored: /Green/ alone is ambiguous with the "Green analysis" tool button.
    await page.getByRole('button', { name: /^Green$/ }).click();
    await clickMapViewport(page, 80, 40);
    await expect.poll(async () => await greenForHole(page, hole3.id)).not.toBeNull();
});
