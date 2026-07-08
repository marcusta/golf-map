import { test, expect } from 'bun:test';
import { puttLabelDescriptors, formatAimOffset } from '../src/planner/putt-labels';
import type { PuttRead } from '../../shared/strategy';

const ball = { x: 0, y: 0 };
const hole = { x: 0, y: 8 }; // 8 m due north

function fakeRead(over: Partial<PuttRead> = {}): PuttRead {
    return {
        aimBearingDeg: 0,
        aimOffsetM: 0,
        playsLikeM: 8,
        path: [ball, hole],
        holedProb: 0.2,
        canStop: true,
        availability: 'ok',
        minConfidence: 0.6,
        ...over,
    } as PuttRead;
}

test('formatAimOffset: side + cm, straight at zero', () => {
    expect(formatAimOffset(0)).toBe('straight');
    expect(formatAimOffset(-0.45)).toBe('45 cm left');
    expect(formatAimOffset(0.12)).toBe('12 cm right');
});

test('distance label sits at the line midpoint and carries plays-like when read is present', () => {
    const labels = puttLabelDescriptors({ ball, hole, read: fakeRead({ playsLikeM: 7.4 }), slopeSamples: [] });
    const dist = labels.find(l => l.kind === 'dist')!;
    expect(dist.point).toEqual({ x: 0, y: 4 }); // midpoint
    expect(dist.text).toBe('8.0 m · plays 7.4 m');
});

test('without a settled read: distance only, no plays-like, no aim', () => {
    const labels = puttLabelDescriptors({ ball, hole, read: null, slopeSamples: [] });
    expect(labels.map(l => l.kind)).toEqual(['dist']);
    expect(labels[0].text).toBe('8.0 m');
});

test('aim label sits at the aim point (bearing carried to hole range) with side + cm', () => {
    // Aim 20° left of north → aim point is left of the hole at the same range.
    const labels = puttLabelDescriptors({
        ball, hole, read: fakeRead({ aimBearingDeg: 340, aimOffsetM: -0.6 }), slopeSamples: [],
    });
    const aim = labels.find(l => l.kind === 'aim')!;
    expect(aim.text).toBe('aim 60 cm left');
    expect(aim.point.x).toBeLessThan(0); // left (west) of the straight line
    expect(Math.hypot(aim.point.x, aim.point.y)).toBeCloseTo(8, 5); // same range as the hole
});

test('a cross-slope label per sample, magnitude + side arrow', () => {
    const labels = puttLabelDescriptors({
        ball, hole, read: null,
        slopeSamples: [
            { point: { x: 0, y: 2 }, crossSlopePct: 2.3 },
            { point: { x: 0, y: 6 }, crossSlopePct: -1.1 },
        ],
    });
    const slope = labels.filter(l => l.kind === 'slope');
    expect(slope.map(s => s.text)).toEqual(['2.3% →', '1.1% ←']);
    expect(slope[0].point).toEqual({ x: 0, y: 2 });
});
