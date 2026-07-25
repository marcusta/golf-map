import { describe, expect, test } from 'bun:test';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import type { Green } from '../../shared/api/greens.gen';
import type { Hole } from '../../shared/api/holes.gen';
import type { RoundWithShots, Shot } from '../../shared/api/rounds.gen';
import { shotsToHoleOut } from '../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';
import { buildHoleRoundForSg, buildRoundForSg, groupShotsByHole } from '../src/rounds/round-sg';

// A reference origin near the existing test fixtures (hole-info-panel.test.ts).
const LAT = 58.4015;
const LON = 15.5658;
const ORIGIN = wgs84ToSweref99tm(LAT, LON);

/** Project an EPSG:3006 offset (meters, +x east / +y north) from ORIGIN to lat/lon. */
function offsetLatLon(dx: number, dy: number): { lat: number; lon: number } {
    const { lat, lon } = sweref99tmToWgs84(ORIGIN.x + dx, ORIGIN.y + dy);
    return { lat, lon };
}

function squareFeature(id: string, type: string, minX: number, maxX: number, minY: number, maxY: number): CourseFeature {
    return {
        id,
        courseId: 'course-1',
        holeId: null,
        type,
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: minX, y: minY },
                    { x: maxX, y: minY },
                    { x: maxX, y: maxY },
                    { x: minX, y: maxY },
                ],
            }],
        },
        geojson: null,
        sortOrder: 0,
        source: null,
        sourceRef: null,
        license: null,
        version: 1,
    };
}

function hole(over: Partial<Hole> = {}): Hole {
    return {
        id: 'h1', courseId: 'c1', number: 1, par: 4, strokeIndex: null, notes: null,
        savedRegionJson: null, version: 1, createdAt: '', updatedAt: '', ...over,
    };
}

function green(centerDx: number, centerDy: number, over: Partial<Green> = {}): Green {
    const { lat, lon } = offsetLatLon(centerDx, centerDy);
    return {
        id: 'g1', holeId: 'h1', boundaryJson: null, centerLat: lat, centerLon: lon,
        frontLat: null, frontLon: null, backLat: null, backLon: null, elevation: null,
        version: 1, ...over,
    } as Green;
}

function shot(
    id: string, holeNumber: number, sortOrder: number, dx: number, dy: number,
    over: Partial<Shot> = {},
): Shot {
    const { lat, lon } = offsetLatLon(dx, dy);
    return {
        id, roundId: 'r1', holeNumber, sortOrder, lat, lon,
        clubId: null, lie: null, shotType: 'full', targetLat: null, targetLon: null,
        penaltyStrokes: 0, recordedAt: '', version: 1, createdAt: '', updatedAt: '',
        ...over,
    };
}

describe('buildHoleRoundForSg', () => {
    test('projects lat/lon to the same planar frame as course features, and classifies the first stroke as tee', () => {
        // Green centre 380 m north of origin; fairway strip covers the corridor.
        const g = green(0, 380);
        const fairway = squareFeature('f1', 'fairway', ORIGIN.x - 50, ORIGIN.x + 50, ORIGIN.y, ORIGIN.y + 380);
        const h = hole({ par: 4 });

        const shots: Shot[] = [
            shot('s0', 1, 0, 0, 0), // tee, no override
            shot('s1', 1, 1, 0, 230), // in the fairway strip
            shot('s2', 1, 2, 0, 375, { shotType: 'putt', lie: 'green' }), // near green, recorded putt override
        ];

        const round = buildHoleRoundForSg(shots, { hole: h, green: g, features: [fairway] });
        expect(round).not.toBeNull();
        expect(round!.par).toBe(4);
        expect(round!.strokes).toHaveLength(3);

        // First stroke: no recorded lie override, no containing feature at (0,0) — still 'tee' (first-of-hole rule wins over geometry fallback).
        expect(round!.strokes[0].lie).toBe('tee');
        // Second stroke: inside the fairway feature.
        expect(round!.strokes[1].lie).toBe('fairway');
        // Third stroke: recorded lie override ('green') wins regardless of geometry.
        expect(round!.strokes[2].lie).toBe('green');

        // Hole position matches the green centre's projection (within transform round-trip tolerance).
        expect(round!.hole.x).toBeCloseTo(ORIGIN.x, 1);
        expect(round!.hole.y).toBeCloseTo(ORIGIN.y + 380, 1);

        // Distance for stroke 0 should be ~380 m (tee to green centre).
        const d0 = Math.hypot(round!.hole.x - round!.strokes[0].position.x, round!.hole.y - round!.strokes[0].position.y);
        expect(d0).toBeCloseTo(380, 0);
    });

    test('a recorded lie override maps through lieFromFeatureType (e.g. "bunker" -> "sand")', () => {
        const g = green(0, 200);
        const h = hole({ par: 4 });
        const shots: Shot[] = [
            shot('s0', 1, 0, 0, 0),
            shot('s1', 1, 1, 0, 150, { lie: 'bunker' }),
        ];
        const round = buildHoleRoundForSg(shots, { hole: h, green: g, features: [] });
        expect(round!.strokes[1].lie).toBe('sand');
    });

    test('unrecognized shot_type falls back to "full"', () => {
        const g = green(0, 100);
        const h = hole({ par: 3 });
        const shots: Shot[] = [shot('s0', 1, 0, 0, 0, { shotType: 'something-unexpected' })];
        const round = buildHoleRoundForSg(shots, { hole: h, green: g, features: [] });
        expect(round!.strokes[0].shotType).toBe('full');
    });

    test('returns null when there is no green (no hole position to compute against)', () => {
        const h = hole();
        const shots: Shot[] = [shot('s0', 1, 0, 0, 0)];
        expect(buildHoleRoundForSg(shots, { hole: h, green: null, features: [] })).toBeNull();
    });

    test('returns null when there are no shots', () => {
        const g = green(0, 100);
        const h = hole();
        expect(buildHoleRoundForSg([], { hole: h, green: g, features: [] })).toBeNull();
    });

    test('shots are ordered by sortOrder regardless of input array order', () => {
        const g = green(0, 300);
        const h = hole({ par: 4 });
        const shots: Shot[] = [
            shot('s2', 1, 2, 0, 280),
            shot('s0', 1, 0, 0, 0),
            shot('s1', 1, 1, 0, 150),
        ];
        const round = buildHoleRoundForSg(shots, { hole: h, green: g, features: [] });
        const distances = round!.strokes.map(s => Math.hypot(round!.hole.x - s.position.x, round!.hole.y - s.position.y));
        // Distances should be strictly decreasing in the returned order (tee furthest, last stroke closest).
        expect(distances[0]).toBeGreaterThan(distances[1]);
        expect(distances[1]).toBeGreaterThan(distances[2]);
    });
});

describe('groupShotsByHole / buildRoundForSg', () => {
    test('groups a multi-hole round by holeNumber, preserving sortOrder', () => {
        const round: RoundWithShots = {
            id: 'r1', courseId: 'c1', userId: null, startedAt: '', endedAt: null, notes: null,
            gamePlanId: null, windSpeedMps: null, windDirectionDeg: null, stimpFt: null, version: 1,
            createdAt: '', updatedAt: '',
            shots: [
                shot('h2s1', 2, 1, 0, 100),
                shot('h1s0', 1, 0, 0, 0),
                shot('h2s0', 2, 0, 0, 200),
                shot('h1s1', 1, 1, 0, 50),
            ],
        };
        const byHole = groupShotsByHole(round);
        expect([...byHole.keys()].sort()).toEqual([1, 2]);
        expect(byHole.get(1)!.map(s => s.id)).toEqual(['h1s0', 'h1s1']);
        expect(byHole.get(2)!.map(s => s.id)).toEqual(['h2s0', 'h2s1']);
    });

    test('buildRoundForSg assembles every hole with shots + a mapped green, skipping the rest', () => {
        const h1 = hole({ id: 'h1', number: 1, par: 4 });
        const h2 = hole({ id: 'h2', number: 2, par: 3 });
        const g1 = green(0, 380, { id: 'g1', holeId: 'h1' });
        // No green for hole 2 -> should be skipped.

        const roundWithShots: RoundWithShots = {
            id: 'r1', courseId: 'c1', userId: null, startedAt: '', endedAt: null, notes: null,
            gamePlanId: null, windSpeedMps: null, windDirectionDeg: null, stimpFt: null, version: 1,
            createdAt: '', updatedAt: '',
            shots: [
                shot('s0', 1, 0, 0, 0),
                shot('s1', 1, 1, 0, 375, { shotType: 'putt' }),
                shot('s2', 2, 0, 0, 0), // hole 2 has a shot but no green -> dropped
            ],
        };

        const holesByNumber = new Map([[1, h1], [2, h2]]);
        const greenByHoleId = new Map([['h1', g1]]);

        const holeRounds = buildRoundForSg(roundWithShots, holesByNumber, greenByHoleId, []);
        expect(holeRounds).toHaveLength(1);
        expect(holeRounds[0].par).toBe(4);
        expect(holeRounds[0].strokes).toHaveLength(2);
    });
});

describe('end-to-end sanity: adapter output feeds shared/strategy directly', () => {
    test('a built HoleRound produces the same SG a hand computation would', async () => {
        const { holeStrokesGained } = await import('../../shared/strategy/strokes-gained-round');
        const g = green(0, 380);
        const h = hole({ par: 4 });
        const shots: Shot[] = [
            shot('s0', 1, 0, 0, 0),
            shot('s1', 1, 1, 0, 230),
            shot('s2', 1, 2, 0, 375, { shotType: 'putt', lie: 'green' }),
        ];
        const fairway = squareFeature('f1', 'fairway', ORIGIN.x - 50, ORIGIN.x + 50, ORIGIN.y, ORIGIN.y + 380);
        const round = buildHoleRoundForSg(shots, { hole: h, green: g, features: [fairway] })!;
        const sg = holeStrokesGained(round);
        expect(sg).toHaveLength(3);
        // Sanity: first-shot SG matches shotsToHoleOut(tee) - shotsToHoleOut(fairway) - 1 for the actual (projected) distances.
        const expected0 = shotsToHoleOut(sg[0].distanceM, 'tee') - shotsToHoleOut(sg[1].distanceM, 'fairway') - 1;
        expect(sg[0].strokesGained).toBeCloseTo(expected0, 9);
    });
});
