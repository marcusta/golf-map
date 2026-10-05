import { expect, test } from 'bun:test';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Position } from 'geojson';
import { ScreenPointCache, hitScreenPoints } from '../src/draw/screen-cache';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import type { AnchorPoint, FeatureGeometry, Point } from '../src/geo/bezier';

// The cached hover scan must return exactly what the uncached scan returned.

const HANDLE_HIT_PX = 7;
const VERTEX_HIT_PX = 9;

/** Seeded LCG so a failure reproduces. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

/** A gl map stand-in whose flat transform is a rotated linear projection (~4 px/m). */
function fakeMap(): { map: MaplibreMap; calls: () => number } {
    let calls = 0;
    const k = 4, rot = 0.3;
    const project = (l: { lng: number; lat: number }) => {
        calls++;
        const ex = (l.lng - 15.5658) * 58300 * k;
        const ny = (l.lat - 58.4015) * 111300 * k;
        return { x: 400 + ex * Math.cos(rot) - ny * Math.sin(rot), y: 300 - ex * Math.sin(rot) - ny * Math.cos(rot) };
    };
    const map = {
        transform: { locationToScreenPoint: project },
        project: () => { throw new Error('the hover scan must not call map.project'); },
    };
    return { map: map as unknown as MaplibreMap, calls: () => calls };
}

const base = wgs84ToSweref99tm(58.4015, 15.5658);

function ring(rand: () => number, n: number, r: number, cx: number, cy: number): { points: AnchorPoint[] } {
    const points: AnchorPoint[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (0.8 + 0.4 * rand());
        const p: AnchorPoint = { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
        const h = (): Point => ({ x: p.x + (rand() - 0.5) * 3, y: p.y + (rand() - 0.5) * 3 });
        if (rand() < 0.6) p.hIn = h();
        if (rand() < 0.6) p.hOut = h();
        points.push(p);
    }
    return { points };
}

/** Verbatim copy of the pre-cache DrawToolService.hitVertexOrHandle scan. */
function oldScan(
    map: MaplibreMap,
    geometry: FeatureGeometry,
    screen: { x: number; y: number },
): { kind: 'anchor' | 'handle'; which?: 'hIn' | 'hOut'; ringIdx: number; idx: number } | null {
    const ll = (p: Point): Position => {
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        return [lon, lat];
    };
    const rings = geometry.rings.map(ring => ({
        anchor: ring.points.map(ll),
        hIn: ring.points.map(p => (p.hIn ? ll(p.hIn) : null)),
        hOut: ring.points.map(p => (p.hOut ? ll(p.hOut) : null)),
    }));
    const tr = map.transform as unknown as {
        locationToScreenPoint?: (l: { lng: number; lat: number }) => { x: number; y: number };
    };
    const project = tr.locationToScreenPoint
        ? (ll: Position) => tr.locationToScreenPoint!({ lng: ll[0], lat: ll[1] })
        : (ll: Position) => map.project(ll as [number, number]);
    const pxDistTo = (ll: Position): number => {
        const pr = project(ll);
        return Math.hypot(pr.x - screen.x, pr.y - screen.y);
    };
    for (let r = 0; r < rings.length; r++) {
        const { hIn, hOut } = rings[r];
        for (let i = 0; i < hIn.length; i++) {
            const inLl = hIn[i];
            if (inLl && pxDistTo(inLl) < HANDLE_HIT_PX) {
                return { kind: 'handle', which: 'hIn', ringIdx: r, idx: i };
            }
            const outLl = hOut[i];
            if (outLl && pxDistTo(outLl) < HANDLE_HIT_PX) {
                return { kind: 'handle', which: 'hOut', ringIdx: r, idx: i };
            }
        }
    }
    for (let r = 0; r < rings.length; r++) {
        const { anchor } = rings[r];
        for (let i = 0; i < anchor.length; i++) {
            if (pxDistTo(anchor[i]) < VERTEX_HIT_PX) {
                return { kind: 'anchor', ringIdx: r, idx: i };
            }
        }
    }
    return null;
}

test('cached hover scan matches the uncached scan on random cursors', () => {
    const rand = rng(7);
    const { map } = fakeMap();
    const cache = new ScreenPointCache();
    let hits = 0, handleHits = 0, misses = 0;
    for (let g = 0; g < 20; g++) {
        const cx = base.x + (rand() - 0.5) * 40, cy = base.y + (rand() - 0.5) * 40;
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [ring(rand, 40, 20, cx, cy), ring(rand, 12, 5, cx + 4, cy - 3)],
        };
        const all = geometry.rings.flatMap(r => r.points.flatMap(p => [p, p.hIn, p.hOut].filter((q): q is Point => !!q)));
        for (let c = 0; c < 300; c++) {
            let screen: { x: number; y: number };
            if (c % 3 === 0) {
                // Anywhere in a wide window, mostly empty map.
                screen = { x: -200 + rand() * 1200, y: -200 + rand() * 1000 };
            } else {
                // Near a random anchor or handle, inside and around the radii.
                const p = all[Math.floor(rand() * all.length)];
                const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
                const s = (map.transform as unknown as { locationToScreenPoint: (l: { lng: number; lat: number }) => { x: number; y: number } })
                    .locationToScreenPoint({ lng: lon, lat });
                screen = { x: s.x + (rand() - 0.5) * 24, y: s.y + (rand() - 0.5) * 24 };
            }
            const want = oldScan(map, geometry, screen);
            const got = hitScreenPoints(cache.get(map, geometry), screen.x, screen.y, HANDLE_HIT_PX, VERTEX_HIT_PX);
            expect(got).toEqual(want);
            if (!want) misses++;
            else if (want.kind === 'handle') handleHits++;
            else hits++;
        }
    }
    // The sample exercises all three outcomes.
    expect(hits).toBeGreaterThan(100);
    expect(handleHits).toBeGreaterThan(100);
    expect(misses).toBeGreaterThan(100);
});

test('one projection per point per camera state; invalidate and new geometry rebuild', () => {
    const rand = rng(11);
    const { map, calls } = fakeMap();
    const cache = new ScreenPointCache();
    const geometry: FeatureGeometry = { crs: 'EPSG:3006', rings: [ring(rand, 400, 30, base.x, base.y)] };
    const pointCount = geometry.rings[0].points.reduce((n, p) => n + 1 + (p.hIn ? 1 : 0) + (p.hOut ? 1 : 0), 0);

    hitScreenPoints(cache.get(map, geometry), -5000, -5000, HANDLE_HIT_PX, VERTEX_HIT_PX);
    expect(calls()).toBe(pointCount);
    for (let i = 0; i < 50; i++) {
        expect(hitScreenPoints(cache.get(map, geometry), -5000 + i, -5000, HANDLE_HIT_PX, VERTEX_HIT_PX)).toBeNull();
    }
    expect(calls()).toBe(pointCount);

    cache.invalidate();
    cache.get(map, geometry);
    expect(calls()).toBe(pointCount * 2);

    // A drag-style edit: new geometry and ring, one replaced point object.
    const pts = geometry.rings[0].points.slice();
    pts[3] = { ...pts[3], x: pts[3].x + 1 };
    const edited: FeatureGeometry = { ...geometry, rings: [{ ...geometry.rings[0], points: pts }] };
    const sp = cache.get(map, edited);
    expect(calls()).toBe(pointCount * 3);
    expect(sp).not.toBe(cache.get(map, geometry));
});

test('a cursor outside the screen bbox is rejected before the point loop', () => {
    const { map } = fakeMap();
    const cache = new ScreenPointCache();
    const geometry: FeatureGeometry = { crs: 'EPSG:3006', rings: [ring(rng(3), 20, 10, base.x, base.y)] };
    const sp = cache.get(map, geometry);
    // Just outside the bbox grown by the anchor radius: no hit, and the
    // answer agrees with the full scan.
    for (const [x, y] of [[sp.minX - 10, (sp.minY + sp.maxY) / 2], [sp.maxX + 10, sp.minY], [sp.minX, sp.maxY + 10]]) {
        expect(hitScreenPoints(sp, x, y, HANDLE_HIT_PX, VERTEX_HIT_PX)).toBeNull();
        expect(oldScan(map, geometry, { x, y })).toBeNull();
    }
});
