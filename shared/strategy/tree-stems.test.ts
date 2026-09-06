import { describe, expect, test } from 'bun:test';
import { buildTreeStemIndex, parseTreeStemsAsset, TREE_STEM_FIELDS, TREE_STEM_FIELDS_V2 } from './tree-stems';
import { treeClearance, treeCrossingsAlongLine } from './tree-clearance';

const asset = (trees: number[][]) => ({version: 1, crs: 'EPSG:3006', fields: TREE_STEM_FIELDS, trees});
const origin = {x: 0, y: 0}, target = {x: 200, y: 0};
const index = (trees: number[][]) => buildTreeStemIndex(parseTreeStemsAsset(asset(trees)));

describe('individual crown clearance (Swift parity)', () => {
    test('valid empty asset, strict schema and rows', () => {
        expect(parseTreeStemsAsset(asset([]))).toEqual([]);
        expect(parseTreeStemsAsset(asset([[1,2,10,3,50]]))).toEqual([{x:1, y:2, heightM:10, crownRadiusM:3, groundM:50, kind:2}]);
        for (const value of [{...asset([]), crs: 'EPSG:4326'}, {...asset([]), version: 3}, {...asset([]), version: 2},
                             asset([[0,0,2,0,0]]), asset([[0,0,2,1,NaN]]), asset([[0,0,2,1]]), asset([[0,0,2,1,0,1]])]) {
            expect(() => parseTreeStemsAsset(value)).toThrow();
        }
    });
    test('version 2 rows carry kind; version 1 rows read as unknown', () => {
        const v2 = (trees: number[][]) => ({version: 2, crs: 'EPSG:3006', fields: TREE_STEM_FIELDS_V2, trees});
        expect(parseTreeStemsAsset(v2([[1,2,10,3,50,0], [1,2,10,3,50,1], [1,2,3,1.5,50,2]])).map(s => s.kind)).toEqual([0,1,2]);
        expect(parseTreeStemsAsset(v2([]))).toEqual([]);
        for (const value of [v2([[1,2,10,3,50]]), v2([[1,2,10,3,50,3]]), v2([[1,2,10,3,50,0.5]]), v2([[1,2,10,3,50,NaN]]),
                             {...v2([]), fields: TREE_STEM_FIELDS}, {...asset([]), fields: TREE_STEM_FIELDS_V2}]) {
            expect(() => parseTreeStemsAsset(value)).toThrow();
        }
        // Clearance ignores kind: identical crossings for either version.
        const rows = [[100,3,10,5,50], [120,5,10,5,50]];
        const v1Hits = treeCrossingsAlongLine(origin, target, index(rows));
        const v2Hits = treeCrossingsAlongLine(origin, target, buildTreeStemIndex(parseTreeStemsAsset(v2(rows.map((r, i) => [...r, i])))));
        expect(v2Hits.map(h => [h.entryM, h.exitM])).toEqual(v1Hits.map(h => [h.entryM, h.exitM]));
    });
    test('exact off-centre chord, tangent, miss and origin-inside', () => {
        const hits = treeCrossingsAlongLine(origin, target, index([[100,3,10,5,50], [120,5,10,5,50], [140,5.1,10,5,50], [0,0,10,2,50]]));
        expect(hits.map(h => [h.entryM, h.exitM])).toEqual([[0,2],[96,104],[120,120]]);
    });
    test('absolute ground and narrow sample valley at non-integer distance', () => {
        const result = treeClearance(origin, target, index([[100,0,10,5,60]]), {
            carryM: 200, apexM: 30,
            samples: [{d:0,h:30},{d:100.25,h:19},{d:100.5,h:30},{d:200,h:30}],
        }, {originGroundM:50, groundAt: () => 999});
        expect(result.summary.status).toBe('blocked');
        expect(result.summary.worst?.minClearanceM).toBe(-1);
        expect(result.summary.worst?.worstAtM).toBe(100.25);
    });
    test('missing absolute origin elevation reports unknown', () => {
        const result = treeClearance(origin, target, index([[100,0,10,5,80]]), {carryM:200,apexM:30}, {originGroundKnown:false});
        expect(result.summary.status).toBe('unknown');
        expect(result.crossings[0].minClearanceM).toBeNull();
    });
    test('entry edge can block although centre clears, gap clears, beyond carry retained', () => {
        expect(treeClearance(origin,target,index([[100,0,19,30,0]]),{carryM:200,apexM:20}).summary.status).toBe('blocked');
        expect(treeClearance(origin,target,index([[100,8,30,5,0],[100,-8,30,5,0]]),{carryM:200,apexM:20}).crossings).toHaveLength(0);
        const result = treeClearance(origin,target,index([[250,0,20,5,0]]),{carryM:200,apexM:20});
        expect(result.beyondCarry).toHaveLength(1);
        expect(result.summary.status).toBe('clears');
    });
    test('a 1.5 m bush 20 m out clears a full shot, is a rollout hazard for a chip and blocks a bump-and-run', () => {
        const bush = index([[20, 0, 1.5, 1.5, 50]]);
        const full = treeClearance(origin, target, bush, {carryM: 200, apexM: 30}, {originGroundM: 50});
        expect(full.summary.status).toBe('clears');
        expect(full.crossings).toHaveLength(1);
        expect(full.summary.worst?.minClearanceM).toBeGreaterThan(5);
        const chip = treeClearance(origin, target, bush, {carryM: 15, apexM: 3}, {originGroundM: 50});
        expect(chip.summary.status).toBe('clears');
        expect(chip.beyondCarry).toHaveLength(1);
        const runner = treeClearance(origin, target, bush, {carryM: 40, apexM: 1}, {originGroundM: 50});
        expect(runner.summary.status).toBe('blocked');
    });
});
