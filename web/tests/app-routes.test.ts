import { test, expect } from 'bun:test';
import { routeComponents } from '../src/app/app.component';

// The shell's route table by run mode (T63, §9). Gating the table — not just
// the guard — is what keeps the map-build wizard components from ever being
// constructed on a box whose pipeline APIs are unmounted.

test('builder mounts the map-build wizard routes', () => {
    const routes = Object.keys(routeComponents('builder')).sort();
    expect(routes).toEqual(['/', '/course', '/login', '/new', '/planner', '/player', '/set-area']);
});

test('serve drops them and keeps everything runtime', () => {
    const routes = Object.keys(routeComponents('serve')).sort();
    expect(routes).toEqual(['/', '/course', '/login', '/planner', '/player']);
    // Planner and analytics are explicitly untouched by the split.
    expect(routeComponents('serve')['/planner']).toBe(routeComponents('builder')['/planner']);
    expect(routeComponents('serve')['/course']).toBe(routeComponents('builder')['/course']);
});
