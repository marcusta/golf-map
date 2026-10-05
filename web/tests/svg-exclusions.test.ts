import { test, expect } from 'bun:test';
import { svgFeatures, matchSvgFilter, variantFileName, loadExclusions, NO_FILTER, COURSE_WIDE, landmarksOf, nearLabel, shapeName } from '../src/export/svg-exclusions';
import type { CourseFeature } from '../../shared/api/course-features.gen';

// The exclusion list's filter and the variant file name (svg-exclusions.ts).

const feature = (id: string, type: string, holeId: string | null, source: string | null = null) =>
    ({ id, type, holeId, source }) as CourseFeature;

const ITEMS = [
    feature('aaa-road', 'path', null),
    feature('bbb-green', 'green', 'h1'),
    feature('ccc-bunker', 'bunker', 'h2'),
    feature('ddd-canopy', 'trees', null, 'lidar-canopy'),
    feature('eee-oob', 'oob', null),
    feature('fff-zone', 'vegetation_zone', null),
];

test('only the types the SVG writes are listed', () => {
    expect(svgFeatures(ITEMS).map(f => f.id)).toEqual(['aaa-road', 'bbb-green', 'ccc-bunker', 'ddd-canopy']);
});

test('the filter narrows by type, hole, status and text', () => {
    const items = svgFeatures(ITEMS);
    const excluded = new Set(['ccc-bunker']);
    const ids = (f: Partial<typeof NO_FILTER>) => matchSvgFilter(items, { ...NO_FILTER, ...f }, excluded).map(x => x.id);
    expect(ids({})).toHaveLength(4);
    expect(ids({ type: 'path' })).toEqual(['aaa-road']);
    expect(ids({ hole: 'h1' })).toEqual(['bbb-green']);
    expect(ids({ hole: COURSE_WIDE })).toEqual(['aaa-road', 'ddd-canopy']);
    expect(ids({ status: 'excluded' })).toEqual(['ccc-bunker']);
    expect(ids({ status: 'included' })).toEqual(['aaa-road', 'bbb-green', 'ddd-canopy']);
    expect(ids({ text: 'LIDAR' })).toEqual(['ddd-canopy']);
});

test('the variant file name matches the server\'s', () => {
    expect(variantFileName('Vreta Kloster GK', '')).toBe('vreta-kloster-gk.svg');
    expect(variantFileName('Vreta', 'No paths #2')).toBe('vreta-no-paths-2.svg');
});

test('unreadable stored exclusions read as none', () => {
    const storage = { getItem: () => '{not json', setItem() {}, removeItem() {} };
    expect(loadExclusions(storage, 'c')).toEqual({ ids: [], variant: '', bisect: null });
    expect(loadExclusions(null, 'c')).toEqual({ ids: [], variant: '', bisect: null });
});

test('a feature is described by the hole green, tee or fairway it sits nearest', () => {
    const at = (id: string, type: string, holeId: string | null, x: number) => ({
        id, type, holeId, geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x, y: 10 }] }] },
    }) as CourseFeature;
    const holes = new Map([['h8', 8], ['h13', 13]]);
    const marks = landmarksOf([at('g13', 'green', 'h13', 100), at('f8', 'fairway', 'h8', 300), at('b', 'bunker', 'h8', 110)], holes);
    expect(marks.map(m => m.type)).toEqual(['green', 'fairway']);  // bunkers aren't landmarks
    expect(nearLabel(at('p', 'path', null, 120), marks)).toBe('near hole 13 green');
    expect(nearLabel(at('p', 'path', null, 280), marks)).toBe('near hole 8 fairway');
    expect(nearLabel(at('p', 'path', null, 0), [])).toBe('');
});

test('the shape name is the hole plus the feature number in hex, as the SVG and the meshes have it', () => {
    const f = (type: string, no: number | null, id = 'abcde123-4567') => ({ id, type, no }) as CourseFeature;
    expect(shapeName(f('bunker', 28), 18)).toBe('hole_18_1c');
    expect(shapeName(f('water', 281), undefined)).toBe('others_119');
    expect(shapeName(f('path', 10), 3)).toBe('a');                  // merged into the Roads layer's shapes
    expect(shapeName(f('trees', null, '7B-20e4aa'), undefined)).toBe('others_7b20e');   // generated: no number
});
