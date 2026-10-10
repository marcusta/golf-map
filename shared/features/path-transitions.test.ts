import { expect, test } from 'bun:test';
import { centerlineStations, centerlinePointAtStation, projectCenterlineStation, transitionRange, transitionFootprint, pathTransitionsError, pathTransitionDefaults } from './path-transitions';

test('both endings occupy the remainder even when their nominal marker spans do not overlap', () => {
    const centerline = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], widthM: 4 };
    const first = { ...pathTransitionDefaults('wheel-tracks'), id: 'first', placement: 'section' as const, startM: 20 };
    const second = { ...first, id: 'second', startM: 60 };
    for (const ending of ['grass', 'continue'] as const) {
        expect(transitionFootprint({ ...first, ending }, 100)).toEqual({ minM: 20, maxM: 100 });
        expect(pathTransitionsError([{ ...first, ending }, second], centerline, 'path', 'gravel')).toContain('overlap');
    }
    expect(transitionFootprint({ ...first, direction: -1, centerGrassReachM: 10 }, 100)).toEqual({ minM: 0, maxM: 30 });
});

test('stations follow the flattened spline and endpoint anchors reverse consistently', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 30, y: 0 }];
    const s = centerlineStations(points);
    expect(s.points.length).toBeGreaterThan(3);
    expect(s.lengthM).toBeGreaterThan(Math.hypot(10, 8) + Math.hypot(20, 8));
    const middle = centerlinePointAtStation(points, s.lengthM / 2);
    expect(projectCenterlineStation(points, middle).stationM).toBeCloseTo(s.lengthM / 2, 6);
    const t = pathTransitionDefaults('soft-fade');
    const end = transitionRange(t, s.lengthM), start = transitionRange({ ...t, placement: 'start' }, s.lengthM);
    expect(end.endM).toBeCloseTo(s.lengthM);
    expect(start.endM).toBe(0);
    expect(start.startM).toBeCloseTo(s.lengthM - end.startM);
});
