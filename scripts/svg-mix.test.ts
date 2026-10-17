/**
 * The SVG-level bisect's mixer (`gspro:bisect -- <course> svg-mix`): a variant is
 * the good export plus chosen shape changes from the bad one, keyed by
 * `data-feature-id`. Pinned on tiny files written the way `gspro.py svg` writes
 * them: a shape moved to another hole is ONE change (never duplicated), a removed
 * shape is dropped only when applied, a layer only the bad file has comes in with
 * its first applied shape, and layer ids are renumbered.
 */
import { describe, expect, test } from 'bun:test';
import { layerOrderChanged, mixSvg, parseSvg, shapeChanges } from './svg-mix';

const HEAD = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10" version="1.1">',
    '  <title>Test</title>',
];
const path = (pid: string, fid: string, d = 'M 0,0 L 1,1 Z', type = 'fairway') =>
    `    <path id="${pid}" inkscape:label="${pid}" data-type="${type}" data-feature-id="${fid}" style="fill:#000" d="${d}"/>`;
const svg = (layers: [string, string[]][]) => [
    ...HEAD,
    ...layers.flatMap(([label, paths], i) => [`  <g inkscape:groupmode="layer" id="layer${i + 1}" inkscape:label="${label}">`, ...paths, '  </g>']),
    '</svg>',
].join('\n');
const pids = (text: string) => [...text.matchAll(/<path id="([^"]+)"/g)].map(m => m[1]);
const layers = (text: string) => [...text.matchAll(/<g [^>]*id="(layer\d+)" inkscape:label="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);

describe('svg-mix', () => {
    const good = parseSvg(svg([
        ['Hole3', [path('hole_3_110', 'f-green'), path('hole_3_112', 'f-bunker', 'M 1,1 Z', 'bunker'), path('hole_3_113', 'f-tee')]],
        ['Roads', [path('roads_1', 'f-road a b')]],
    ]));
    const bad = parseSvg(svg([
        ['Hole101', [path('hole_101_112', 'f-bunker', 'M 1,1 Z', 'bunker'), path('hole_101_16c', 'f-range', 'M 5,5 Z')]],
        ['Hole3', [path('hole_3_110', 'f-green', 'M 0,0 L 2,2 Z'), path('hole_3_113', 'f-tee')]],
        ['Roads', []],
    ]));

    test('lists each shape change once, keyed by feature: a move between holes is one change', () => {
        const changes = shapeChanges(good, bad);
        expect(changes.map(c => `${c.n} ${c.kind} ${c.key} ${c.goodPid ?? '-'} -> ${c.badPid ?? '-'}`)).toEqual([
            '1 moved f-bunker hole_3_112 -> hole_101_112',
            '2 added f-range - -> hole_101_16c',
            '3 edited f-green hole_3_110 -> hole_3_110',
            '4 removed f-road a b roads_1 -> -',
        ]);
        expect(layerOrderChanged(good, bad)).toBe(false);
    });

    test('nothing applied is the good file again (same paths, same order)', () => {
        const out = mixSvg(good, bad, new Set());
        expect(pids(out.text)).toEqual(['hole_3_110', 'hole_3_112', 'hole_3_113', 'roads_1']);
        expect(out.text).toContain('d="M 0,0 L 1,1 Z"');
        expect(layers(out.text)).toEqual(['layer1:Hole3', 'layer2:Roads']);
    });

    test('a shape moved to another hole moves as a whole — never in both layers', () => {
        const out = mixSvg(good, bad, new Set(['f-bunker']));
        expect(pids(out.text)).toEqual(['hole_101_112', 'hole_3_110', 'hole_3_113', 'roads_1']);
        // The new layer comes in first, as in the bad file, and the ids are renumbered.
        expect(layers(out.text)).toEqual(['layer1:Hole101', 'layer2:Hole3', 'layer3:Roads']);
        expect(out.paths).toBe(4);
    });

    test('a removed shape goes only when its change is applied; an empty layer is left out', () => {
        const out = mixSvg(good, bad, new Set(['f-road a b']));
        expect(pids(out.text)).toEqual(['hole_3_110', 'hole_3_112', 'hole_3_113']);
        expect(out.layers).toEqual(['Hole3']);
    });

    test('a new layer with an added shape, and an edit swapped in place', () => {
        const out = mixSvg(good, bad, new Set(['f-range', 'f-green']));
        expect(out.layers).toEqual(['Hole101', 'Hole3', 'Roads']);
        expect(pids(out.text)).toEqual(['hole_101_16c', 'hole_3_110', 'hole_3_112', 'hole_3_113', 'roads_1']);
        expect(out.text).toContain('d="M 0,0 L 2,2 Z"');
    });

    test('everything applied is the bad file', () => {
        const all = new Set(shapeChanges(good, bad).map(c => c.key));
        const out = mixSvg(good, bad, all);
        expect(pids(out.text)).toEqual(['hole_101_112', 'hole_101_16c', 'hole_3_110', 'hole_3_113']);
    });

    test('an added shape lands after its nearest predecessor in the bad file that is already there', () => {
        const g = parseSvg(svg([['Hole1', [path('a', 'fa'), path('c', 'fc')]]]));
        const b = parseSvg(svg([['Hole1', [path('a', 'fa'), path('b', 'fb'), path('x', 'fx'), path('c', 'fc')]]]));
        expect(pids(mixSvg(g, b, new Set(['fx'])).text)).toEqual(['a', 'x', 'c']);
    });

    test('a layer only the good file has stays after its good predecessor', () => {
        const g = parseSvg(svg([['Hole1', [path('a', 'fa')]], ['Hole2', [path('b', 'fb')]], ['Roads', [path('r', 'fr')]]]));
        const b = parseSvg(svg([['Hole1', [path('a', 'fa')]], ['Roads', [path('r', 'fr')]]]));
        expect(mixSvg(g, b, new Set()).layers).toEqual(['Hole1', 'Hole2', 'Roads']);
    });

    test('refuses a variant with two paths of one id (a renumbering half applied)', () => {
        // In the bad file hole_3_112 is a different feature: the old one moved away and took its id with it.
        const b = parseSvg(svg([['Hole3', [path('hole_3_110', 'f-green'), path('hole_3_112', 'f-new'), path('hole_3_113', 'f-tee')]], ['Roads', [path('roads_1', 'f-road a b')]]]));
        expect(() => mixSvg(good, b, new Set(['f-new']))).toThrow(/duplicate path ids: hole_3_112/);
    });

    test('refuses what it does not understand inside a layer', () => {
        expect(() => parseSvg(svg([['Hole1', ['    <circle r="1"/>']]]))).toThrow(/unexpected line/);
    });
});
