import { test, expect, describe } from 'bun:test';
import {
    parsePathToSubpaths,
    parseTransform,
    composeAffine,
    applyAffine,
    IDENTITY,
    parseSvgDocument,
    makeGeoreference,
    mapSubpath,
    subpathsToGeometries,
    suggestType,
    type Affine,
} from '../src/import/svg-parse';
import { flattenRing, segmentControls, cubicBezierPoint, signedArea } from '../src/geo/bezier';

// ─── Real sample from the golf-map-2 Landeryd trace ────────────────────────
// Green on the Master layer (path291 in landeryd.svg): relative m/c/z path
// with an Inkscape translate transform — the dominant shape encoding in the
// file (696 paths, all m/c/z with 373 translate transforms).
const LANDERYD_GREEN_D =
    'm 1440.5625,1431.8258 c 0.7662,-0.2536 2.034,-0.6064 3.4892,-0.8048 1.4553,-0.1985 3.0979,-0.2425 4.7129,-0.2315 1.6151,0.011 3.2026,0.077 4.4979,0.3142 1.2954,0.237 2.2986,0.6449 3.0979,1.1079 0.7992,0.4631 1.3945,0.9812 1.8686,1.7198 0.474,0.7387 0.8268,1.6977 1.0693,2.6018 0.2426,0.904 0.3749,1.7528 0.3804,2.5025 0.01,0.7496 -0.1158,1.4001 -0.3749,2.0836 -0.2591,0.6835 -0.6559,1.4 -1.1796,2.1882 -0.5236,0.7883 -1.1741,1.6482 -2.2765,2.7947 -1.1024,1.1466 -2.6568,2.5797 -3.8364,3.6215 -1.1796,1.0418 -1.9844,1.6923 -2.7782,2.2214 -0.7937,0.5292 -1.5764,0.9371 -2.4584,1.1631 -0.8819,0.226 -1.8631,0.2701 -2.938,0.039 -1.0749,-0.2316 -2.2434,-0.7387 -3.2246,-1.3781 -0.9812,-0.6394 -1.7749,-1.4111 -2.5466,-2.4364 -0.7717,-1.0252 -1.5213,-2.304 -2.0284,-3.682 -0.5072,-1.3781 -0.7717,-2.8554 -0.8324,-4.1618 -0.061,-1.3063 0.083,-2.4418 0.3914,-3.5332 0.3086,-1.0914 0.7827,-2.1387 1.2512,-2.949 0.4686,-0.8103 0.9316,-1.3836 1.334,-1.7805 0.4024,-0.3968 0.7441,-0.6173 1.0473,-0.8047 0.3032,-0.1874 0.5677,-0.3418 1.3339,-0.5953 z';
const LANDERYD_GREEN_TRANSFORM = 'translate(544.25391,-21.63057)';

/** Landeryd course georeference bbox (courses.georeference_json, EPSG:3006). */
const LANDERYD_BOUNDS = { minX: 541110.0, minY: 6467550.0, maxX: 543410.0, maxY: 6469850.0 };
const LANDERYD_VIEWBOX = { minX: 0, minY: 0, width: 2300, height: 2300 };

// ─── Path-data parsing ──────────────────────────────────────────────────────

describe('parsePathToSubpaths', () => {
    test('absolute M/L/Z square', () => {
        const subs = parsePathToSubpaths('M 0 0 L 10 0 L 10 10 L 0 10 Z');
        expect(subs.length).toBe(1);
        expect(subs[0].closed).toBe(true);
        expect(subs[0].points.map(p => [p.x, p.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
        expect(subs[0].points.every(p => !p.hIn && !p.hOut)).toBe(true);
    });

    test('H/V shorthands', () => {
        const subs = parsePathToSubpaths('M 0 0 H 10 V 10 H 0 Z');
        expect(subs[0].points.map(p => [p.x, p.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    });

    test('implicit lineto after moveto and implicit command repetition', () => {
        const subs = parsePathToSubpaths('m 1,1 2,0 0,2 z');
        expect(subs[0].points.map(p => [p.x, p.y])).toEqual([[1, 1], [3, 1], [3, 3]]);
    });

    test('cubic handles are absolute hOut/hIn', () => {
        const subs = parsePathToSubpaths('M 0 0 C 1 2 3 4 5 0 Z');
        const [a, b] = subs[0].points;
        expect(a.hOut).toEqual({ x: 1, y: 2 });
        expect(b.hIn).toEqual({ x: 3, y: 4 });
        expect([b.x, b.y]).toEqual([5, 0]);
    });

    test('S reflects the previous cubic control point', () => {
        const subs = parsePathToSubpaths('M 0 0 C 0 5 5 10 10 10 S 20 5 20 0');
        const mid = subs[0].points[1];
        // reflection of (5,10) about (10,10) = (15,10)
        expect(mid.hOut).toEqual({ x: 15, y: 10 });
        expect(subs[0].points[2].hIn).toEqual({ x: 20, y: 5 });
        expect(subs[0].closed).toBe(false);
    });

    test('Q is degree-elevated to an equivalent cubic', () => {
        const subs = parsePathToSubpaths('M 0 0 Q 5 10 10 0');
        const ring = { points: subs[0].points };
        const [p0, p1, p2, p3] = segmentControls(ring, 0);
        // sample the cubic against the original quadratic at several t
        for (const t of [0.2, 0.5, 0.8]) {
            const [cx, cy] = cubicBezierPoint(p0, p1, p2, p3, t);
            const mt = 1 - t;
            const qx = mt * mt * 0 + 2 * mt * t * 5 + t * t * 10;
            const qy = mt * mt * 0 + 2 * mt * t * 10 + t * t * 0;
            expect(cx).toBeCloseTo(qx, 9);
            expect(cy).toBeCloseTo(qy, 9);
        }
    });

    test('T reflects the previous quadratic control point', () => {
        const q = parsePathToSubpaths('M 0 0 Q 5 10 10 0 T 20 0')[0];
        // reflected control = 2*(10,0) − (5,10) = (15,−10); cubic c1 of the
        // T segment = p0 + 2/3 (q − p0) = (10,0) + 2/3 (5,−10)
        expect(q.points[1].hOut!.x).toBeCloseTo(10 + (2 / 3) * 5, 9);
        expect(q.points[1].hOut!.y).toBeCloseTo(0 + (2 / 3) * -10, 9);
    });

    test('multiple subpaths split on m', () => {
        const subs = parsePathToSubpaths('M 0 0 L 10 0 L 10 10 Z m 2,2 l 2,0 l 0,2 z');
        expect(subs.length).toBe(2);
        // relative m after z continues from the previous subpath START (0,0)
        expect(subs[1].points[0]).toEqual({ x: 2, y: 2 });
    });

    test('arc commands are rejected', () => {
        expect(() => parsePathToSubpaths('M 0 0 A 5 5 0 0 1 10 0')).toThrow(/arc/i);
    });

    test('real Landeryd green: closure anchor merged into start with its handle', () => {
        const subs = parsePathToSubpaths(LANDERYD_GREEN_D);
        expect(subs.length).toBe(1);
        expect(subs[0].closed).toBe(true);
        // 24 raw anchors; the trailing one coincides with the start (Inkscape
        // closed path) and is merged, transferring its incoming handle.
        expect(subs[0].points.length).toBe(23);
        expect(subs[0].points[0].hIn).toBeDefined();
        expect(subs[0].points[0].x).toBeCloseTo(1440.5625, 3);
        expect(subs[0].points[0].y).toBeCloseTo(1431.8258, 3);
    });
});

// ─── Bezier fidelity round-trip (real path, independent reference) ─────────
// Reference values computed with an INDEPENDENT parser + sampler (Python,
// 64 samples/segment) over the same d + transform: shoelace area, centroid
// and bbox of the flattened outline, in translated SVG space and in
// EPSG:3006 after georeferencing with the course bounds.

describe('bezier fidelity (Landeryd green path291)', () => {
    const transform = parseTransform(LANDERYD_GREEN_TRANSFORM);

    test('translated SVG-space outline matches the SVG geometry', () => {
        const sub = parsePathToSubpaths(LANDERYD_GREEN_D)[0];
        const ring = mapSubpath(sub, p => applyAffine(transform, p));
        const flat = flattenRing(ring, 0.02);
        expect(Math.abs(signedArea(flat))).toBeCloseTo(422.321894, 1);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of flat) {
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        expect(minX).toBeCloseTo(1979.444876, 2);
        expect(minY).toBeCloseTo(1409.157368, 2);
        expect(maxX).toBeCloseTo(2003.933150, 2);
        expect(maxY).toBeCloseTo(1431.669948, 2);
    });

    test('georeferenced outline lands at the right EPSG:3006 position', () => {
        const georef = makeGeoreference(LANDERYD_VIEWBOX, LANDERYD_BOUNDS);
        const sub = parsePathToSubpaths(LANDERYD_GREEN_D)[0];
        const ring = mapSubpath(sub, p => georef(applyAffine(transform, p)));
        // first anchor: reference (543094.81641, 6468439.80477)
        expect(ring.points[0].x).toBeCloseTo(543094.81641, 4);
        expect(ring.points[0].y).toBeCloseTo(6468439.80477, 4);
        const flat = flattenRing(ring, 0.02);
        expect(Math.abs(signedArea(flat))).toBeCloseTo(422.315918, 1); // ~422 m² green
        // reference bbox (independent Python sampler, same georeference):
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of flat) {
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        expect(minX).toBeCloseTo(543089.444876, 2);
        expect(minY).toBeCloseTo(6468418.330052, 2);
        expect(maxX).toBeCloseTo(543113.933150, 2);
        expect(maxY).toBeCloseTo(6468440.842632, 2);
    });
});

// ─── Transforms ─────────────────────────────────────────────────────────────

describe('parseTransform / applyAffine', () => {
    test('translate', () => {
        const p = applyAffine(parseTransform('translate(544.25391,-21.63057)'), { x: 10, y: 20 });
        expect(p.x).toBeCloseTo(554.25391, 9);
        expect(p.y).toBeCloseTo(-1.63057, 9);
    });

    test('single-arg translate and scale', () => {
        expect(applyAffine(parseTransform('translate(5)'), { x: 1, y: 1 })).toEqual({ x: 6, y: 1 });
        expect(applyAffine(parseTransform('scale(2)'), { x: 3, y: 4 })).toEqual({ x: 6, y: 8 });
        expect(applyAffine(parseTransform('scale(2,3)'), { x: 3, y: 4 })).toEqual({ x: 6, y: 12 });
    });

    test('matrix (the landeryd path105 case)', () => {
        const m = parseTransform('matrix(1.9255632,0,0,1.4842315,-298.18229,-202.55489)');
        const p = applyAffine(m, { x: 910.31108, y: 373.09378 });
        expect(p.x).toBeCloseTo(1.9255632 * 910.31108 - 298.18229, 6);
        expect(p.y).toBeCloseTo(1.4842315 * 373.09378 - 202.55489, 6);
    });

    test('multiple ops compose left-to-right (translate then scale)', () => {
        const m = parseTransform('translate(10,0) scale(2)');
        // scale applies first, then translate: (3,4) → (6,8) → (16,8)
        expect(applyAffine(m, { x: 3, y: 4 })).toEqual({ x: 16, y: 8 });
    });

    test('rotate(90) about origin', () => {
        const p = applyAffine(parseTransform('rotate(90)'), { x: 1, y: 0 });
        expect(p.x).toBeCloseTo(0, 9);
        expect(p.y).toBeCloseTo(1, 9);
    });

    test('composeAffine nests parent∘child', () => {
        const parent = parseTransform('translate(100,0)');
        const child = parseTransform('scale(2)');
        const m = composeAffine(parent, child);
        expect(applyAffine(m, { x: 1, y: 1 })).toEqual({ x: 102, y: 2 });
        expect(applyAffine(IDENTITY as Affine, { x: 7, y: 8 })).toEqual({ x: 7, y: 8 });
    });
});

// ─── Georeferencing (y-flip) ────────────────────────────────────────────────

describe('makeGeoreference', () => {
    const georef = makeGeoreference(LANDERYD_VIEWBOX, LANDERYD_BOUNDS);

    test('SVG top-left corner → WEST/NORTH (y-axis flipped)', () => {
        expect(georef({ x: 0, y: 0 })).toEqual({ x: 541110.0, y: 6469850.0 });
    });

    test('SVG bottom-right corner → EAST/SOUTH', () => {
        expect(georef({ x: 2300, y: 2300 })).toEqual({ x: 543410.0, y: 6467550.0 });
    });

    test('center maps to center; 1 SVG unit = 1 meter for the 2300 box', () => {
        const c = georef({ x: 1150, y: 1150 });
        expect(c.x).toBeCloseTo((541110 + 543410) / 2, 6);
        expect(c.y).toBeCloseTo((6467550 + 6469850) / 2, 6);
        // one unit down in SVG = one meter SOUTH
        expect(georef({ x: 0, y: 1 }).y).toBeCloseTo(6469850 - 1, 9);
    });

    test('non-zero viewBox origin', () => {
        const g = makeGeoreference({ minX: 100, minY: 200, width: 50, height: 50 }, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
        expect(g({ x: 100, y: 200 })).toEqual({ x: 0, y: 100 });
        expect(g({ x: 150, y: 250 })).toEqual({ x: 100, y: 0 });
    });
});

// ─── Type suggestion ────────────────────────────────────────────────────────

describe('suggestType', () => {
    test('golf-map-2 fill convention', () => {
        expect(suggestType('#bce5a4', null, null)).toBe('green');
        expect(suggestType('#e5e5aa', null, null)).toBe('bunker');
        expect(suggestType('#0000c0', null, null)).toBe('water');
        expect(suggestType('#00ffff', null, null)).toBe('water_creek');
    });

    test('fill wins over class and layer', () => {
        expect(suggestType('#43e561', 'bunker', 'Deeps')).toBe('fairway');
    });

    test('class tokens', () => {
        expect(suggestType(null, 'green', null)).toBe('green');
        expect(suggestType(null, 'semi_rough', null)).toBe('semi_rough');
        expect(suggestType(null, 'cartpath', null)).toBe('path');
    });

    test('layer labels incl. landeryd conventions', () => {
        expect(suggestType(null, null, 'Deeps')).toBe('deep_rough');
        expect(suggestType(null, null, 'Roughs')).toBe('rough');
        expect(suggestType(null, null, 'roads')).toBe('path');
        expect(suggestType(null, null, 'Greens')).toBe('green');
        expect(suggestType('#123456', 'decoration', 'Master')).toBeNull();
    });
});

// ─── Document scan ──────────────────────────────────────────────────────────

describe('parseSvgDocument', () => {
    const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     viewBox="0 0 2300 2300">
  <g inkscape:label="Master" id="layer2">
    <path d="M 0 0 L 10 0 L 10 10 Z" style="fill:#bce5a4;stroke:none"/>
    <path d="M 20 0 L 30 0 L 30 10 Z" style="fill:#bce5a4"/>
    <path d="M 0 20 L 10 20 L 10 30 Z" style="fill:#e5e5aa" transform="translate(5,5)"/>
    <g transform="translate(100,0)">
      <path d="M 0 0 L 5 0 L 5 5 Z" style="fill:#43e561"/>
    </g>
  </g>
  <g inkscape:label="Hidden" style="display:none">
    <path d="M 0 0 L 1 0 L 1 1 Z" style="fill:#bce5a4"/>
  </g>
  <g id="classy">
    <path d="M 0 0 L 2 0 L 2 2 Z" class="bunker edge"/>
  </g>
  <path d="M 5 5 L 6 5 L 6 6 Z" fill="#278438"/>
</svg>`;

    test('buckets by (layer, fill/class) with counts, transforms and suggestions', () => {
        const parsed = parseSvgDocument(SVG);
        expect(parsed.viewBox).toEqual({ minX: 0, minY: 0, width: 2300, height: 2300 });
        expect(parsed.totalPaths).toBe(6); // hidden layer excluded

        const green = parsed.buckets.find(b => b.layer === 'Master' && b.fill === '#bce5a4')!;
        expect(green.paths.length).toBe(2);
        expect(green.suggestedType).toBe('green');

        const bunker = parsed.buckets.find(b => b.layer === 'Master' && b.fill === '#e5e5aa')!;
        expect(bunker.paths.length).toBe(1);
        expect(bunker.paths[0].transform).toEqual([1, 0, 0, 1, 5, 5]);

        // nested group transform accumulated
        const fairway = parsed.buckets.find(b => b.fill === '#43e561')!;
        expect(fairway.layer).toBe('Master');
        expect(fairway.paths[0].transform).toEqual([1, 0, 0, 1, 100, 0]);

        // class-based mapping (no fill)
        const classy = parsed.buckets.find(b => b.layer === 'classy')!;
        expect(classy.className).toBe('bunker');
        expect(classy.suggestedType).toBe('bunker');

        // bare fill attribute at root level
        const rough = parsed.buckets.find(b => b.fill === '#278438')!;
        expect(rough.layer).toBe('');
        expect(rough.suggestedType).toBe('rough');

        // hidden layer contributes nothing
        expect(parsed.buckets.find(b => b.layer === 'Hidden')).toBeUndefined();
    });

    test('rejects non-SVG and missing dimensions', () => {
        expect(() => parseSvgDocument('<html><body>nope</body></html>')).toThrow();
        expect(() => parseSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0"/></svg>')).toThrow(/viewBox/i);
    });

    test('falls back to width/height when viewBox is absent', () => {
        const parsed = parseSvgDocument('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><path d="M 0 0 L 1 1 Z" class="green"/></svg>');
        expect(parsed.viewBox).toEqual({ minX: 0, minY: 0, width: 100, height: 50 });
    });
});

// ─── Ring grouping ──────────────────────────────────────────────────────────

describe('subpathsToGeometries', () => {
    const square = (x: number, y: number, size: number) => ({
        points: [
            { x, y },
            { x: x + size, y },
            { x: x + size, y: y + size },
            { x, y: y + size },
        ],
    });

    test('inner subpath becomes a hole ring', () => {
        const geoms = subpathsToGeometries([square(0, 0, 10), square(4, 4, 2)]);
        expect(geoms.length).toBe(1);
        expect(geoms[0].rings.length).toBe(2);
        expect(geoms[0].crs).toBe('EPSG:3006');
    });

    test('disjoint subpaths become separate features', () => {
        const geoms = subpathsToGeometries([square(0, 0, 10), square(100, 100, 5)]);
        expect(geoms.length).toBe(2);
        expect(geoms.every(g => g.rings.length === 1)).toBe(true);
    });

    test('mixed: hole in the first, plus a separate feature', () => {
        const geoms = subpathsToGeometries([square(0, 0, 10), square(2, 2, 3), square(50, 0, 10)]);
        expect(geoms.length).toBe(2);
        expect(geoms[0].rings.length).toBe(2);
        expect(geoms[1].rings.length).toBe(1);
    });
});
