/**
 * ONE-SHOT / THROWAWAY — T22 (see docs/delegation-briefs-feature-stack.md,
 * docs/decisions-feature-stack-2026-07-08.md D25). Not wired into any test
 * suite or npm script; safe to delete once its output has been reviewed.
 *
 * Compares, on real course_features data, what the OLD hit-test rule
 * (D17: smallest real rendered-area feature containing a point wins) would
 * classify vs what the NEW D25 backfill stack order (topmost sort_order
 * among features containing a point wins) would classify. Read-only —
 * opens the sqlite file in readonly mode, never writes.
 *
 * Usage: bun scripts/t22-lie-comparison.one-shot.ts [path-to-app.sqlite]
 */
import * as path from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { flattenRing, type FeatureGeometry, type PathRing } from '../services/geo';
import { pointInRing } from '../services/analysis.service';
import { computeBackfillSortOrders, type BackfillRow } from '../db/migrations/008_feature_sort_order';

const FLATTEN_TOLERANCE_M = 0.25;

function flattenedArea(points: Array<[number, number]>): number {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        sum += ax * by - bx * ay;
    }
    return Math.abs(sum) / 2;
}

/** Area-weighted centroid of a simple polygon (shoelace-based). */
function polygonCentroid(points: Array<[number, number]>): [number, number] {
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    area = area / 2;
    if (Math.abs(area) < 1e-9) {
        // Degenerate ring — fall back to vertex average.
        const n = points.length || 1;
        const sx = points.reduce((s, [x]) => s + x, 0);
        const sy = points.reduce((s, [, y]) => s + y, 0);
        return [sx / n, sy / n];
    }
    return [cx / (6 * area), cy / (6 * area)];
}

interface Feature {
    id: string;
    course_id: string;
    hole_id: string | null;
    type: string;
    created_at: string;
    outerFlat: Array<[number, number]>;
    area: number;
    centroid: [number, number];
}

function loadFeatures(db: BunDatabase): Feature[] {
    const rows = db
        .query('SELECT id, course_id, hole_id, type, geometry_json, created_at FROM course_features')
        .all() as Array<{
        id: string;
        course_id: string;
        hole_id: string | null;
        type: string;
        geometry_json: string;
        created_at: string;
    }>;

    const features: Feature[] = [];
    for (const row of rows) {
        let geometry: FeatureGeometry;
        try {
            geometry = JSON.parse(row.geometry_json);
        } catch {
            continue;
        }
        const outerRing: PathRing | undefined = geometry.rings[0];
        if (!outerRing || outerRing.points.length < 3) continue;
        const outerFlat = flattenRing(outerRing, FLATTEN_TOLERANCE_M, geometry.curveType);
        if (outerFlat.length < 3) continue;
        features.push({
            id: row.id,
            course_id: row.course_id,
            hole_id: row.hole_id,
            type: row.type,
            created_at: row.created_at,
            outerFlat,
            area: flattenedArea(outerFlat),
            centroid: polygonCentroid(outerFlat),
        });
    }
    return features;
}

function groupKey(courseId: string, holeId: string | null): string {
    return `${courseId} ${holeId ?? ''}`;
}

function main() {
    const dbPath = Bun.argv[2] ?? path.join(import.meta.dir, '../../data/app.sqlite');
    const sqlite = new BunDatabase(dbPath, { readonly: true });

    const features = loadFeatures(sqlite);
    sqlite.close();

    // Reload the raw geometry_json (unflattened control points) separately —
    // the D25 backfill order must rank by control-point area, not the
    // flattened area used above for the OLD-rule comparison.
    const rawRows = new BunDatabase(dbPath, { readonly: true })
        .query('SELECT id, course_id, hole_id, type, geometry_json, created_at FROM course_features')
        .all() as BackfillRow[];
    const sortOrders = computeBackfillSortOrders(rawRows);

    const groups = new Map<string, Feature[]>();
    for (const f of features) {
        const key = groupKey(f.course_id, f.hole_id);
        const g = groups.get(key);
        if (g) g.push(f);
        else groups.set(key, [f]);
    }

    let totalPoints = 0;
    let matches = 0;
    const mismatches: string[] = [];

    for (const [key, group] of groups) {
        if (group.length < 2) continue; // nothing to disagree about
        for (const queryFeature of group) {
            const [px, py] = queryFeature.centroid;
            const containing = group.filter((g) => pointInRing(px, py, g.outerFlat));
            if (containing.length < 2) continue; // no overlap at this sample point
            totalPoints++;

            const oldWinner = containing.reduce((a, b) => (b.area < a.area ? b : a));
            const newWinner = containing.reduce((a, b) =>
                (sortOrders.get(b.id) ?? -1) > (sortOrders.get(a.id) ?? -1) ? b : a,
            );

            if (oldWinner.id === newWinner.id) {
                matches++;
            } else {
                mismatches.push(
                    `  group=${key} queryFeature=${queryFeature.id}(${queryFeature.type}) ` +
                        `OLD=${oldWinner.id}(${oldWinner.type} area=${oldWinner.area.toFixed(2)}) ` +
                        `NEW=${newWinner.id}(${newWinner.type} sort_order=${sortOrders.get(newWinner.id)}) ` +
                        `[old sort_order=${sortOrders.get(oldWinner.id)}, new area=${newWinner.area.toFixed(2)}]`,
                );
            }
        }
    }

    console.log(`db: ${dbPath}`);
    console.log(`total course_features: ${features.length}`);
    console.log(`groups with >=2 features: ${[...groups.values()].filter((g) => g.length >= 2).length}`);
    console.log(`sample query points (centroid-of-feature, >=2 containing features): ${totalPoints}`);
    console.log(`OLD (smallest-area) vs NEW (D25 stack order) agree: ${matches}/${totalPoints}`);
    if (mismatches.length > 0) {
        console.log(`mismatches (${mismatches.length}):`);
        for (const m of mismatches) console.log(m);
    } else {
        console.log('mismatches: none');
    }
}

main();
