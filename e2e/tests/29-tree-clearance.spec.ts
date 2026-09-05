import { test, expect, type Page } from '@playwright/test';
import {
    TEST_COURSE_ID, HOLE_2_PAR3, TEE_HOLE_2, CLUB_7I, tid, openPlanner, seedPlanViaApi,
} from './fixtures';
import { wgs84ToSweref99tm } from '../../web/src/geo/transform';

/**
 * Height-aware tree clearance in the planner legs readout
 * (web/src/planner/tree-clearance.ts + shared/strategy/tree-clearance.ts).
 *
 * Par-3 hole 2 with the 7 iron (141.7 m carry, table apex ~23 m) gives one
 * clubbed tee→green leg. A generated lidar-canopy tree ring is seeded across
 * that line 40–60 m from the tee, where the ball is ~16–19 m up:
 *   - heightP90M 60 → "Trees 60 m · blocked (ball … m)" and a caddy card;
 *   - heightP90M 5  → "Trees 5 m · clears by … m".
 * Ground comes from the elevation service when tiles are cached, else flat;
 * either way a 60 m canopy blocks and a 5 m one clears.
 */

const SOURCE = 'lidar-canopy';
/** Seed geometry for hole 2 (server/db/seeds/course.ts: tee yellow, green center). */
const TEE = { lat: 58.4012 + HOLE_2_PAR3 * 0.001, lon: 15.5698 - HOLE_2_PAR3 * 0.001 };
const GREEN = { lat: 58.402 + HOLE_2_PAR3 * 0.001, lon: 15.5649 - HOLE_2_PAR3 * 0.001 };

/** A box across the tee→green line from `fromM` to `toM` along it, `halfM` wide, as an EPSG:3006 ring. */
function boxAcrossLine(fromM: number, toM: number, halfM: number): number[][][] {
    const a = wgs84ToSweref99tm(TEE.lat, TEE.lon);
    const b = wgs84ToSweref99tm(GREEN.lat, GREEN.lon);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const px = -uy;
    const py = ux;
    const at = (d: number, side: number): number[] =>
        [a.x + ux * d + px * side, a.y + uy * d + py * side];
    const ring = [at(fromM, -halfM), at(toM, -halfM), at(toM, halfM), at(fromM, halfM)];
    ring.push(ring[0]!);
    return [ring];
}

async function putGenerated(page: Page, trees: Array<{ ring: number[][][]; heightP90M: number }>): Promise<void> {
    if (!page.url().startsWith('http')) await page.goto('/');
    await page.evaluate(async ({ courseId, source, trees }) => {
        const body = {
            type: 'FeatureCollection',
            features: trees.map(t => ({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: t.ring },
                properties: {
                    type: 'trees', source,
                    heightP90M: t.heightP90M, heightMaxM: t.heightP90M + 2, heightMeanM: t.heightP90M - 3, areaM2: 1200,
                },
            })),
        };
        const r = await fetch(`/api/courses/${courseId}/features/generated?source=${source}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`PUT generated -> ${r.status} ${await r.text()}`);
    }, { courseId: TEST_COURSE_ID, source: SOURCE, trees });
}

async function seedAndOpen(page: Page, heightP90M: number): Promise<void> {
    await putGenerated(page, [{ ring: boxAcrossLine(40, 60, 30), heightP90M }]);
    await seedPlanViaApi(page, {
        courseId: TEST_COURSE_ID,
        holeNumber: HOLE_2_PAR3,
        teeId: TEE_HOLE_2,
        preferredClubId: CLUB_7I,
    });
    await openPlanner(page, TEST_COURSE_ID, HOLE_2_PAR3);
}

test.afterEach(async ({ page }) => {
    // Shared serial DB: never leave the canopy behind for later specs.
    await putGenerated(page, []).catch(() => undefined);
});

test('a 60 m canopy across the tee shot reads blocked (red) and the caddy says so', async ({ page }) => {
    await seedAndOpen(page, 60);

    const row = page.locator(tid('planner-leg-trees')).first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-tree-status', 'blocked');
    await expect(row).toHaveText(/^Trees 60 m · blocked \(ball \d+ m\)$/);
    await expect(row).toHaveClass(/tree-row--bad/);

    // The over-the-trees caddy rule fires on the same leg.
    await expect(page.locator(tid('planner-caddy-section'))).toBeVisible();
    await expect(page.locator(tid('planner-caddy-card')).filter({ hasText: 'blocked, aim left/right or lay up' }))
        .toHaveCount(1);
});

test('a 5 m canopy across the tee shot reads clears (green)', async ({ page }) => {
    await seedAndOpen(page, 5);

    const row = page.locator(tid('planner-leg-trees')).first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-tree-status', 'clears');
    await expect(row).toHaveText(/^Trees 5 m · clears by \d+ m$/);
    await expect(row).toHaveClass(/tree-row--good/);
    await expect(page.locator(tid('planner-caddy-card')).filter({ hasText: 'over the trees' })).toHaveCount(0);
});
