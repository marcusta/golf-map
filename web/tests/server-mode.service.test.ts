import { test, expect, afterEach } from 'bun:test';
import {
    ServerModeService,
    visibleEditorTools,
    isBuilderRoute,
    canAuthorCourses,
    BUILDER_ROUTES,
} from '../src/app/server-mode.service';
import { EDITOR_TOOLS } from '../src/editor/tools/index';
import { guardRoute } from '../src/auth/guard';

// Mode gating for the deploy split (T63, §9): the real ServerModeService
// against a stubbed global fetch (the sanctioned network seam), plus the pure
// gating functions the shell and command bar read.

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubMeta(respond: () => Response | Promise<Response>): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/meta')) return Promise.resolve(respond());
        return Promise.resolve(json(200, {}));
    }) as typeof fetch;
}

const META = { name: 'golf-map', version: '1', mode: 'builder' as const };

test('load reads the run mode off /api/meta', async () => {
    stubMeta(() => json(200, { ...META, mode: 'builder' }));
    const svc = new ServerModeService();

    await svc.load();

    expect(svc.mode.peek()).toBe('builder');
    expect(svc.isBuilder()).toBe(true);
});

test('a serve-mode server hides the builder half', async () => {
    stubMeta(() => json(200, { ...META, mode: 'serve' }));
    const svc = new ServerModeService();

    await svc.load();

    expect(svc.mode.peek()).toBe('serve');
    expect(svc.isBuilder()).toBe(false);
});

test('the restrictive answer is the default and the failure mode', async () => {
    // Before /api/meta answers, nothing builder-only may render: offering a
    // button that 404s is worse than offering none.
    const svc = new ServerModeService();
    expect(svc.mode.peek()).toBe('serve');

    stubMeta(() => Promise.reject(new Error('offline')));
    await svc.load();
    expect(svc.mode.peek()).toBe('serve');

    // An unknown/absent mode is treated the same way.
    stubMeta(() => json(200, { ...META, mode: 'something-else' }));
    await svc.load();
    expect(svc.mode.peek()).toBe('serve');
});

test('serve mode offers only the read-only editor tools', () => {
    const builder = visibleEditorTools('builder');
    expect(builder).toEqual(EDITOR_TOOLS);
    expect(builder.map(t => t.id)).toContain('draw');

    const serve = visibleEditorTools('serve').map(t => t.id);
    // Everything that edits the map or needs a builder API is gone …
    expect(serve).not.toContain('draw');
    expect(serve).not.toContain('furniture');
    expect(serve).not.toContain('sam');
    expect(serve).not.toContain('terrain-edit');
    expect(serve).not.toContain('clean');
    // … measurement and green analysis survive: they only read tiles + DEM,
    // which is exactly what the VPS ships.
    expect(serve).toContain('measure');
    expect(serve).toContain('analysis');
});

test('every builder-only tool is flagged as such (registry stays in sync)', () => {
    const flagged = EDITOR_TOOLS.filter(t => t.builderOnly).map(t => t.id).sort();
    expect(flagged).toEqual(['clean', 'draw', 'furniture', 'sam', 'terrain-edit']);
});

test('builder routes are the map-build wizard, prefix-matched', () => {
    expect(BUILDER_ROUTES).toEqual(['/new', '/set-area']);
    expect(isBuilderRoute('/new')).toBe(true);
    expect(isBuilderRoute('/set-area/abc-123')).toBe(true);
    expect(isBuilderRoute('/course/abc-123')).toBe(false);
    expect(isBuilderRoute('/planner/abc-123')).toBe(false);
    // A route that merely starts with the same characters is not a match.
    expect(isBuilderRoute('/newsletter')).toBe(false);
});

test('course authoring is builder-only', () => {
    expect(canAuthorCourses('builder')).toBe(true);
    expect(canAuthorCourses('serve')).toBe(false);
});

test('the route guard sends builder routes home in serve mode only', () => {
    const marcus = { id: 'u1', username: 'marcus' };

    expect(guardRoute(marcus, '/new', 'builder')).toBeNull();
    expect(guardRoute(marcus, '/set-area/abc', 'builder')).toBeNull();

    expect(guardRoute(marcus, '/new', 'serve')).toBe('/');
    expect(guardRoute(marcus, '/set-area/abc', 'serve')).toBe('/');

    // Runtime routes are untouched by the mode — planner and analytics run on
    // APIs both boxes serve.
    expect(guardRoute(marcus, '/planner/abc', 'serve')).toBeNull();
    expect(guardRoute(marcus, '/course/abc', 'serve')).toBeNull();
    expect(guardRoute(marcus, '/player', 'serve')).toBeNull();

    // Sessionless still wins over mode gating.
    expect(guardRoute(null, '/new', 'serve')).toBe('/login');
});
