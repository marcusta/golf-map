import { test, expect } from '@playwright/test';
import { TEST_COURSE_ID, tid, openPlanner } from './fixtures';

/**
 * The course route (tee → aim points → green) is course definition, not player
 * strategy, so it renders as its own quiet dashed line under the plan legs
 * whenever the hole has aim points. Reads the overlay source straight off the
 * map rather than pixel-peeping the canvas.
 */
test('course route line runs tee → aim → green under the plan legs', async ({ page }) => {
    await openPlanner(page, TEST_COURSE_ID, 1);
    await expect(page.locator(tid('planner-legs-section'))).toBeVisible();

    const probe = await page.evaluate(() => {
        const map = (window as unknown as { __map?: any }).__map!;
        const source = map.getSource('plan-course-route');
        const layers = map.getStyle().layers.map((l: any) => l.id);
        return {
            geojson: source?._data?.geojson ?? source?._data ?? null,
            routeIndex: layers.indexOf('plan-course-route-line'),
            planIndex: layers.indexOf('plan-ellipse-fill'),
        };
    });

    const features = probe.geojson.features as any[];
    const line = features.find((f) => f.properties.role === 'route');
    expect(line.geometry.coordinates.length).toBe(3); // tee, one aim, green
    const aims = features.filter((f) => f.properties.role === 'route-aim');
    expect(aims.length).toBe(1);
    expect(aims[0].properties.label).toBe('Aim 1');
    // The aim vertex is shared with the polyline's middle point.
    expect(aims[0].geometry.coordinates).toEqual(line.geometry.coordinates[1]);

    // Drawn below the plan overlay so the shot legs stay the loud thing.
    expect(probe.routeIndex).toBeGreaterThanOrEqual(0);
    expect(probe.planIndex).toBeGreaterThanOrEqual(0);
    expect(probe.routeIndex).toBeLessThan(probe.planIndex);
});
