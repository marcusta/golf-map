import { afterEach, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di } from '@basics/core/client/core';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { FeaturesService } from '../src/draw/features.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { ScreenPointCache } from '../src/draw/screen-cache';
import { snapPointer } from '../src/draw/draw-snap';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Per-pointer-move cost of draw snapping (review item 25) over 2,000
// b-spline features of 12 controls each, 50 x 40 grid at 30 m pitch, at
// 4 px/m. "cold" is the first move after a camera change (the candidates'
// anchors and outlines get projected); "warm" is a later move at the same
// camera. The fake flat transform runs a full WGS84 -> SWEREF 99 TM per
// point, which costs more than MapLibre's locationToScreenPoint, so the
// cold numbers are an upper bound.

const N = 2000;
const K = 4;
const base = wgs84ToSweref99tm(58.4015, 15.5658);

afterEach(() => {
    _reset();
    di.reset();
});

function geometry(i: number): FeatureGeometry {
    const cx = base.x + (i % 50) * 30, cy = base.y - Math.floor(i / 50) * 30;
    const points = [];
    for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        points.push({ x: cx + 12 * Math.cos(a), y: cy + 12 * Math.sin(a), ...(k % 4 === 0 ? { corner: true } : {}) });
    }
    return { crs: 'EPSG:3006', curveType: 'bspline', rings: [{ points }] };
}

function row(i: number): CourseFeature {
    return {
        id: `f${i}`, courseId: 'c1', holeId: null, type: i % 2 ? 'bunker' : 'rough', geometry: geometry(i),
        sortOrder: i, source: null, sourceRef: null, license: null, attributes: null, version: 1,
    };
}

function stats(samples: number[]): { median: number; p95: number } {
    const s = [...samples].sort((a, b) => a - b);
    return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)] };
}

test('snap cost per pointer move, 2,000 features', async () => {
    const detail = new CourseDetailService();
    detail.holeStore.set([]);
    di.set(CourseDetailService, detail);
    const rows = Array.from({ length: N }, (_, i) => row(i));
    const features = new FeaturesService({ listByCourse: async () => rows } as unknown as CourseFeaturesApi);
    await features.load('c1');

    const map = {
        transform: {
            locationToScreenPoint: ({ lng, lat }: { lng: number; lat: number }) => {
                const s = wgs84ToSweref99tm(lat, lng);
                return { x: (s.x - base.x) * K, y: (base.y - s.y) * K };
            },
        },
    } as unknown as MaplibreMap;
    const screenPoints = new ScreenPointCache();
    const host = { features, map, screenPoints };
    const noMod = { metaKey: false, ctrlKey: false };

    // A pointer path that wanders across many features, near outlines
    // (snaps) and in the gaps between them (no snap).
    const path = Array.from({ length: 400 }, (_, i) => {
        const sx = (i * 37) % (50 * 30 * K), sy = ((i * 53) % (40 * 30 * K));
        return { point: { x: sx, y: sy }, world: { x: base.x + sx / K, y: base.y - sy / K } };
    });
    const run = (p: typeof path[number]) => snapPointer(host, { point: p.point, originalEvent: noMod }, p.world, null);

    // Warm the flat-cache (camera independent) once, as the hit-test does.
    for (const p of path) run(p);

    const cold: number[] = [];
    const warm: number[] = [];
    let snapped = 0;
    for (const p of path) {
        screenPoints.invalidate();
        let t0 = performance.now();
        run(p);
        cold.push(performance.now() - t0);
        t0 = performance.now();
        if (run(p)) snapped++;
        warm.push(performance.now() - t0);
    }
    const c = stats(cold), w = stats(warm);
    console.log(`draw snap, ${N} features: warm median ${(w.median * 1000).toFixed(0)} us, p95 ${(w.p95 * 1000).toFixed(0)} us; `
        + `cold median ${(c.median * 1000).toFixed(0)} us, p95 ${(c.p95 * 1000).toFixed(0)} us; ${snapped}/${path.length} moves snapped`);
    expect(snapped).toBeGreaterThan(0);
    // Loose ceiling: catches an accidental O(all vertices) scan per move.
    expect(w.median).toBeLessThan(2);
});
