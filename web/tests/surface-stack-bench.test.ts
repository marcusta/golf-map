import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import { resolveSurfaceStack, surfaceStackStats } from '../../shared/render/resolved-surface-stack';
import { geometryToWgs84Rings } from '../src/draw/features.service';
import type { FeatureGeometry } from '../src/geo/bezier';

// Bench for resolveSurfaceStack on real course data. Opt-in: it reads the
// local dev database read-only and takes seconds per course.
//   SURFACE_STACK_BENCH=1 bun test tests/surface-stack-bench.test.ts
const DB_PATH = resolve(import.meta.dir, '../../data/app.sqlite');
const enabled = process.env.SURFACE_STACK_BENCH === '1' && existsSync(DB_PATH);
const GROUP_RANK_SPAN = 4096; // features.service.ts

type Row = { id: string; hole_id: string | null; type: string; geometry_json: string; sort_order: number; number: number | null };

function courseCollections(db: Database): Array<{ courseId: string; name: string; all: FeatureCollection; byHole: Map<number, FeatureCollection> }> {
    const courses = db.query(`
        select c.id, c.name from courses c
        where exists (select 1 from course_features f where f.course_id = c.id and f.source is null)
    `).all() as Array<{ id: string; name: string }>;
    return courses.map(course => {
        const rows = db.query(`
            select f.id, f.hole_id, f.type, f.geometry_json, f.sort_order, h.number
            from course_features f left join holes h on h.id = f.hole_id
            where f.course_id = ? and f.source is null
        `).all(course.id) as Row[];
        const features: Feature[] = rows.map(row => ({
            type: 'Feature',
            id: row.id,
            properties: { id: row.id, type: row.type, holeId: row.hole_id, stackKey: (row.number ?? 0) * GROUP_RANK_SPAN + row.sort_order },
            geometry: { type: 'Polygon', coordinates: geometryToWgs84Rings(JSON.parse(row.geometry_json) as FeatureGeometry) },
        }));
        const byHole = new Map<number, FeatureCollection>();
        rows.forEach((row, i) => {
            const n = row.number ?? 0;
            if (!byHole.has(n)) byHole.set(n, { type: 'FeatureCollection', features: [] });
            byHole.get(n)!.features.push(features[i]!);
        });
        return { courseId: course.id, name: course.name, all: { type: 'FeatureCollection', features }, byHole };
    });
}

function vertexCount(c: FeatureCollection): number {
    let n = 0;
    for (const f of c.features) if (f.geometry.type === 'Polygon') for (const ring of f.geometry.coordinates) n += ring.length;
    return n;
}

/** Same features with fresh coordinate arrays, so no per-surface memo applies. */
function fresh(c: FeatureCollection): FeatureCollection {
    return { type: 'FeatureCollection', features: c.features.map(f => ({ ...f, geometry: structuredClone(f.geometry) })) };
}

function time(c: FeatureCollection): number {
    const t0 = performance.now();
    resolveSurfaceStack(c);
    return performance.now() - t0;
}

/** Shift one surface ~0.5 m east: the shape of a typical single-feature edit. */
function editOne(c: FeatureCollection, index: number): FeatureCollection {
    const features = [...c.features];
    const f = features[index]!;
    if (f.geometry.type !== 'Polygon') return c;
    const coordinates = f.geometry.coordinates.map(ring => ring.map(([x, y]) => [x! + 0.00001, y!]));
    features[index] = { ...f, geometry: { type: 'Polygon', coordinates } };
    return { type: 'FeatureCollection', features };
}

describe.skipIf(!enabled)('resolveSurfaceStack bench (data/app.sqlite)', () => {
    test('full course and per-hole timings', () => {
        const db = new Database(DB_PATH, { readonly: true });
        for (const course of courseCollections(db)) {
            const cold = time(fresh(course.all));
            const full = time(fresh(course.all));
            const holes = [...course.byHole.entries()].filter(([n]) => n > 0).map(([n, c]) => ({ n, ms: time(fresh(c)), count: c.features.length }));
            const worst = holes.reduce((a, b) => (b.ms > a.ms ? b : a), { n: 0, ms: 0, count: 0 });
            const median = holes.map(h => h.ms).sort((a, b) => a - b)[Math.floor(holes.length / 2)] ?? 0;
            // Incremental: prime the per-surface memo, then resolve after a
            // visibility-style rebuild (new Feature objects, same coordinates)
            // and after single-feature edits.
            const primed = fresh(course.all);
            time(primed);
            const rebuilt: FeatureCollection = { type: 'FeatureCollection', features: primed.features.map(f => ({ ...f })) };
            const clipsBefore = surfaceStackStats.clips;
            const rebuild = time(rebuilt);
            const rebuildClips = surfaceStackStats.clips - clipsBefore;
            const edits: Array<{ ms: number; clips: number }> = [];
            let current = rebuilt;
            for (const index of [0, Math.floor(primed.features.length / 3), Math.floor(primed.features.length / 2), primed.features.length - 1]) {
                current = editOne(current, index);
                const c0 = surfaceStackStats.clips;
                edits.push({ ms: time(current), clips: surfaceStackStats.clips - c0 });
            }
            const editMax = Math.max(...edits.map(e => e.ms));
            console.log(`${course.name}: ${course.all.features.length} features, ${vertexCount(course.all)} vertices, full cold ${cold.toFixed(0)} ms, warm ${full.toFixed(0)} ms; ` +
                `per hole median ${median.toFixed(0)} ms, worst hole ${worst.n} (${worst.count} features) ${worst.ms.toFixed(0)} ms; ` +
                `rebuild same coords ${rebuild.toFixed(1)} ms (${rebuildClips} clips); one edit ${edits.map(e => e.ms.toFixed(1)).join("/")} ms, max ${editMax.toFixed(1)} ms (clips ${edits.map(e => e.clips).join('/')})`);
        }
        db.close();
        expect(true).toBe(true);
    }, 600_000);
});
