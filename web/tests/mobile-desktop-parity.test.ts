import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureGeometry } from '../src/geo/bezier';
import type { FallLineArrow } from '../src/analysis/analysis-math';
import { arrowsToGeojson } from '../src/analysis/analysis-overlay';
import { FLATTEN_TOLERANCE_M, geometryToWgs84Rings } from '../src/draw/features.service';
import { GREEN_FLATTEN_TOLERANCE_M, greenRingsWgs84 } from '../src/mobile/green/green-frame';
import { arrowLengthM, arrowsGeojson } from '../src/mobile/green/green-overlay';
import { ringCentroid } from '../src/mobile/green/putt-context';

/**
 * The mobile green screen deliberately re-implements four small pieces of
 * desktop code rather than importing them, because their homes
 * (analysis/analysis-overlay, draw/features.service, planner/planner-tool.service)
 * are off-limits to the mobile bundle — see mobile-import-boundary.test.ts.
 *
 * "Identical today" is worth nothing unless it stays identical, so these are
 * golden tests against the desktop sources themselves: same input, same output.
 * If a desktop tweak makes the phone read differently from the builder, one of
 * these fails and the duplication gets re-synced on purpose.
 *
 * NOTE these tests may import the forbidden modules — the BUNDLE boundary is
 * about src/mobile, and a test process has no bundle.
 */
const WEB_SRC = join(import.meta.dir, '..', 'src');

/** Pull a non-exported function out of a source file and make it callable. */
function extractFunction<T>(file: string, name: string): T {
    const src = readFileSync(file, 'utf8');
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} is gone from ${file} — re-sync this parity test`);
    // The body's brace, not one from an inline type in the signature (those
    // never end a line): the first `{` that opens a new line.
    let i = src.indexOf('{\n', start);
    if (i < 0) throw new Error(`could not find the body of ${name} in ${file}`);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    const ts = src.slice(start, i + 1);
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(ts);
    return new Function(`${js}\nreturn ${name};`)() as T;
}

describe('parity: fall-line arrows (green-overlay ↔ analysis-overlay)', () => {
    const arrows: FallLineArrow[] = [
        { e: 532_950, n: 6_473_700, dirE: 0.6, dirN: -0.8, slopePct: 3.4, labeled: true },
        { e: 532_962, n: 6_473_711, dirE: -0.28, dirN: 0.96, slopePct: 1.1, labeled: false },
    ];

    test('the same arrows render the same geometry', () => {
        for (const lengthM of [1.2, 2.4, 3.5]) {
            expect(arrowsGeojson(arrows, lengthM)).toEqual(arrowsToGeojson(arrows, lengthM));
        }
    });

    test('arrow sizing mirrors the desktop formula', () => {
        // The desktop computes this inline inside AnalysisOverlay.render, so
        // the two statements are lifted straight out of its source.
        const src = readFileSync(join(WEB_SRC, 'analysis', 'analysis-overlay.ts'), 'utf8');
        const match = src.match(/const spacing = ([^;]+);\s*const lengthM = ([^;]+);/);
        expect(match).not.toBeNull();
        const desktopLength = new Function('widthM', 'heightM',
            `const spacing = ${match![1]}; return ${match![2]};`) as
            (w: number, h: number) => number;

        for (const grid of [
            { width: 40, height: 30, resolution: 0.5 },
            { width: 200, height: 200, resolution: 0.25 },
            { width: 8, height: 8, resolution: 1 },
        ]) {
            const widthM = grid.width * grid.resolution;
            const heightM = grid.height * grid.resolution;
            expect(arrowLengthM(grid as never)).toBe(desktopLength(widthM, heightM));
        }
    });
});

describe('parity: green outline (green-frame ↔ draw/features.service)', () => {
    const geometry: FeatureGeometry = {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                {
                    x: 532_950, y: 6_473_700,
                    hIn: { x: 532_944, y: 6_473_698 },
                    hOut: { x: 532_956, y: 6_473_702 },
                },
                { x: 532_972, y: 6_473_706 },
                { x: 532_968, y: 6_473_729, hOut: { x: 532_964, y: 6_473_732 } },
                { x: 532_946, y: 6_473_722 },
            ],
        }],
    };

    test('same flattening tolerance', () => {
        expect(GREEN_FLATTEN_TOLERANCE_M).toBe(FLATTEN_TOLERANCE_M);
    });

    test('same rings, vertex for vertex', () => {
        expect(greenRingsWgs84(geometry)).toEqual(geometryToWgs84Rings(geometry));
    });
});

describe('parity: default hole centroid (putt-context ↔ planner-tool.service)', () => {
    // planner-tool.service keeps its ringCentroid private, so lift it.
    const desktopRingCentroid = extractFunction<(p: readonly { x: number; y: number }[]) =>
        { x: number; y: number }>(join(WEB_SRC, 'planner', 'planner-tool.service.ts'), 'ringCentroid');

    test('same centroid for the same anchors', () => {
        const cases = [
            [],
            [{ x: 532_950, y: 6_473_700 }],
            [
                { x: 532_950, y: 6_473_700 },
                { x: 532_972.5, y: 6_473_706.25 },
                { x: 532_968, y: 6_473_729 },
                { x: 532_946, y: 6_473_722 },
            ],
        ];
        for (const points of cases) {
            expect(ringCentroid(points)).toEqual(desktopRingCentroid(points));
        }
    });
});
