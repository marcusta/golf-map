import { describe, expect, test } from 'bun:test';
import {
    bearingBetween,
    browseTargetActivation,
    buildBrowseLadder,
} from '../src/planner/browse-ladder';

describe('planner browse ladder', () => {
    test('sorts point targets from an arbitrary origin and keeps promotable positions', () => {
        const origin = { x: 10, y: 20, elevation: 5 };
        const rows = buildBrowseLadder({
            origin,
            bearingDeg: 0,
            points: [
                { id: 'green', label: 'Green', role: 'green_center', point: { x: 10, y: 120, elevation: 7 } },
                { id: 'aim', label: 'Aim', role: 'aim', point: { x: 10, y: 70, elevation: 6 } },
            ],
        });

        expect(rows.map(row => row.id)).toEqual(['aim:aim', 'green:green_center']);
        expect(rows[0]?.lineM).toBeCloseTo(50);
        expect(rows[0]?.position).toEqual({ x: 10, y: 70, elevation: 6 });
        expect(rows[0]?.playsAsM).toBeCloseTo(51);
    });

    test('hazard front and carry are concrete points usable as the next origin', () => {
        const origin = { x: 0, y: 0 };
        const rows = buildBrowseLadder({
            origin,
            bearingDeg: 0,
            points: [],
            hazards: [{
                id: 'bunker',
                label: 'Bunker',
                ring: { kind: 'bunker', points: [
                    { x: -5, y: 40 }, { x: 5, y: 40 }, { x: 5, y: 55 }, { x: -5, y: 55 },
                ] },
            }],
        });

        expect(rows.map(row => row.id)).toEqual([
            'bunker:hazard_front', 'bunker:hazard_carry',
        ]);
        expect(rows.map(row => row.position)).toEqual([{ x: 0, y: 40 }, { x: 0, y: 55 }]);
    });

    test('bearing uses compass degrees', () => {
        expect(bearingBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
        expect(bearingBetween({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(180);
    });

    test('ordinary map and ladder clicks inspect without changing the origin', () => {
        expect(browseTargetActivation('map')).toBe('inspect');
        expect(browseTargetActivation('ladder')).toBe('inspect');
    });
});
