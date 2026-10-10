import { test, expect } from 'bun:test';
import { cleanupAreaGeoJson, effectiveCleanupArea, forcedCleanupArea, validateCleanupAreas, type CleanupArea } from './cleanup-areas';
const box = (id: string, kind: CleanupArea['kind'], left: number, right: number): CleanupArea => ({
    id, kind, name: id, ring: [[left,0], [right,0], [right,2], [left,2], [left,0]],
});
test('overlapping includes union before exclusions split them; keep wins in any order', () => {
    const a = box('a', 'include', 0, 3), b = box('b', 'include', 2, 5), keep = box('keep', 'exclude', 1, 4);
    const result = effectiveCleanupArea([a, b, keep]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(effectiveCleanupArea([keep, b, a]));
    expect(effectiveCleanupArea([keep])).toEqual([]);
    expect(effectiveCleanupArea([a, box('all', 'exclude', -1, 6)])).toEqual([]);
    expect(effectiveCleanupArea([a, box('outside', 'exclude', 10, 11)])).toEqual(effectiveCleanupArea([a]));
});
test('a forced area is eligible on its own, is exported as its own feature, and still loses to keep', () => {
    const forced = box('forced', 'force', 4, 8), clean = box('clean', 'include', 0, 5), keep = box('keep', 'exclude', 6, 7);
    expect(effectiveCleanupArea([forced])).toEqual(forcedCleanupArea([forced]));
    expect(effectiveCleanupArea([clean, forced])).toEqual(effectiveCleanupArea([box('all', 'include', 0, 8)]));
    expect(forcedCleanupArea([clean, forced, keep])).toHaveLength(2); // keep splits the forced area
    expect(forcedCleanupArea([clean, keep])).toEqual([]);
    const types = (areas: CleanupArea[]) => cleanupAreaGeoJson({ siteId: 's', version: 1, areas }).features.map(f => f.properties.type);
    expect(types([clean])).toEqual(['cleanup']);
    expect(types([clean, forced])).toEqual(['cleanup', 'cleanup-force']);
    expect(types([forced, box('all', 'exclude', -1, 9)])).toEqual([]);
});
test('rejects degenerate and self-touching outlines; closed simple rings are accepted', () => {
    expect(() => validateCleanupAreas([box('ok', 'include', 15, 16)])).not.toThrow();
    for (const ring of [
        [[0,0],[1,1],[2,2],[0,0]],
        [[0,0],[2,0],[1,0],[1,2],[0,0]],
        [[0,0],[2,0],[2,2],[0,2],[2,0],[0,0]],
    ]) expect(() => validateCleanupAreas([{ ...box('bad', 'include', 0, 2), ring: ring as [number,number][] }])).toThrow();
});
