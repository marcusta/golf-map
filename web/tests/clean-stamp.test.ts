import { describe, expect, test } from 'bun:test';
import {
    DAB_SPACING_FRACTION,
    MAX_SPACING_DIAMETERS,
    dabAlphaAt,
    dabCenters,
    dabSpacingPx,
    renderStampStroke,
} from '../src/clean/clean-stamp';

// Clone-stamp brush engine (client mirror of pipeline/golfpipe/stamp.py):
// pure math over flat RGBA buffers. These pins keep the TS and Python
// implementations in semantic lockstep — dab spacing from flow, feathered
// falloff from hardness, opacity cap, tone-match mean-shift with texture
// preservation, and the source-validity edge behavior.

function surface(size: number, fill: [number, number, number]): Uint8ClampedArray {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return data;
}

function px(data: Uint8ClampedArray, size: number, x: number, y: number): [number, number, number] {
    const i = (y * size + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
}

/** Paint a rectangle of the surface a solid color (a clone-source region). */
function paintRect(data: Uint8ClampedArray, size: number, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * size + x) * 4;
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
    }
}

describe('dab spacing from flow', () => {
    test('higher flow → denser dabs; clamped at both ends', () => {
        const d = 40;
        expect(dabSpacingPx(d, 1)).toBeCloseTo(d * DAB_SPACING_FRACTION, 9);
        expect(dabSpacingPx(d, 0.3)).toBeGreaterThan(dabSpacingPx(d, 1));
        expect(dabSpacingPx(d, 0.01)).toBeCloseTo(d * MAX_SPACING_DIAMETERS, 9);
        expect(dabSpacingPx(1, 1)).toBe(1);
    });

    test('dab centers walk the polyline at the spacing', () => {
        const centers = dabCenters([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2.5);
        expect(centers[0]).toEqual({ x: 0, y: 0 });
        for (let i = 1; i < centers.length; i++) {
            expect(centers[i].x - centers[i - 1].x).toBeCloseTo(2.5, 9);
        }
        expect(centers[centers.length - 1].x).toBeCloseTo(10, 9);
        // Single point → single dab; a short tail inside half a spacing is skipped.
        expect(dabCenters([{ x: 3, y: 4 }], 5)).toHaveLength(1);
        expect(dabCenters([{ x: 0, y: 0 }, { x: 1, y: 0 }], 4)).toHaveLength(1);
    });
});

describe('feathered falloff from hardness', () => {
    test('hardness 1 is a hard disc; softer brushes feather earlier', () => {
        expect(dabAlphaAt(14.9, 15, 1)).toBe(1);
        expect(dabAlphaAt(15.1, 15, 1)).toBe(0);

        // Soft brush: opaque core, zero rim, monotone falloff between.
        expect(dabAlphaAt(5, 15, 0.4)).toBe(1); // inside 0.4·15 = 6
        expect(dabAlphaAt(16, 15, 0.4)).toBe(0);
        let prev = 1;
        for (let d = 6; d <= 15; d += 0.5) {
            const a = dabAlphaAt(d, 15, 0.4);
            expect(a).toBeLessThanOrEqual(prev + 1e-12);
            prev = a;
        }
        // Lower hardness → less alpha at the same mid-ring distance.
        expect(dabAlphaAt(10, 15, 0.1)).toBeLessThan(dabAlphaAt(10, 15, 0.6));
    });
});

describe('renderStampStroke', () => {
    test('clones source pixels at the offset; nothing changes outside the dab', () => {
        const size = 64;
        const data = surface(size, [40, 90, 60]);
        paintRect(data, size, 40, 10, 60, 30, [200, 10, 10]); // red donor patch
        const before = data.slice();

        // Single dab at (20, 20), source offset +30 px in x → the red patch.
        renderStampStroke(data, size, {
            path: [{ x: 20, y: 20 }],
            offsetPx: { dx: 30, dy: 0 },
            radiusPx: 6,
            opacity: 1,
            flow: 1,
            hardness: 1,
            toneMatch: false,
        });
        expect(px(data, size, 20, 20)).toEqual([200, 10, 10]); // cloned
        expect(px(data, size, 20, 40)).toEqual([40, 90, 60]); // untouched
        // Everything beyond the dab radius is byte-identical.
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (Math.hypot(x + 0.5 - 20, y + 0.5 - 20) <= 7) continue;
                const i = (y * size + x) * 4;
                expect(data[i]).toBe(before[i]);
            }
        }
    });

    test('opacity caps the whole stroke; low flow builds up translucently', () => {
        const size = 64;
        const base = surface(size, [0, 0, 0]);
        paintRect(base, size, 0, 32, 64, 64, [200, 200, 200]); // donor: lower half

        const half = base.slice();
        renderStampStroke(half, size, {
            path: [{ x: 20, y: 10 }],
            offsetPx: { dx: 0, dy: 40 },
            radiusPx: 5,
            opacity: 0.5,
            flow: 1,
            hardness: 1,
            toneMatch: false,
        });
        expect(px(half, size, 20, 10)[0]).toBe(100); // 0·0.5 + 200·0.5

        const lowFlow = base.slice();
        renderStampStroke(lowFlow, size, {
            path: [{ x: 40, y: 10 }],
            offsetPx: { dx: 0, dy: 40 },
            radiusPx: 5,
            opacity: 1,
            flow: 0.3,
            hardness: 1,
            toneMatch: false,
        });
        const v = px(lowFlow, size, 40, 10)[0];
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(200); // translucent single dab
    });

    test('tone-match shifts the clone mean to the destination but keeps texture', () => {
        const size = 64;
        const data = surface(size, [150, 150, 150]);
        // Donor region: noisy dark texture (mean ~90, visible variance).
        let seed = 7;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
        for (let y = 34; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
                const i = (y * size + x) * 4;
                const v = Math.round(90 + (rand() - 0.5) * 40);
                data[i] = v; data[i + 1] = v; data[i + 2] = v;
            }
        }

        renderStampStroke(data, size, {
            path: [{ x: 16, y: 16 }],
            offsetPx: { dx: 0, dy: 32 },
            radiusPx: 10,
            opacity: 1,
            flow: 1,
            hardness: 1,
            toneMatch: true,
        });
        // Collect the painted core.
        const values: number[] = [];
        for (let y = 8; y < 25; y++) {
            for (let x = 8; x < 25; x++) {
                if (Math.hypot(x + 0.5 - 16, y + 0.5 - 16) > 9) continue;
                values.push(px(data, size, x, y)[0]);
            }
        }
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
        expect(Math.abs(mean - 150)).toBeLessThan(3); // mean pulled to the dest
        expect(std).toBeGreaterThan(5); // donor texture survives the shift
    });

    test('pixels whose source falls outside the surface stay untouched', () => {
        const size = 32;
        const data = surface(size, [80, 80, 80]);
        paintRect(data, size, 0, 0, 32, 32, [80, 80, 80]);
        const before = data.slice();
        // Dab near the right edge with a big +x offset: sources off-surface.
        renderStampStroke(data, size, {
            path: [{ x: 28, y: 16 }],
            offsetPx: { dx: 20, dy: 0 },
            radiusPx: 5,
            opacity: 1,
            flow: 1,
            hardness: 1,
            toneMatch: false,
        });
        // Columns whose source col ≥ 32: unchanged (col + 20 ≥ 32 → col ≥ 12,
        // i.e. the whole dab): the buffer is byte-identical.
        expect(data).toEqual(before);
    });

    test('deterministic: identical inputs → identical bytes', () => {
        const size = 48;
        const make = () => {
            const d = surface(size, [10, 20, 30]);
            paintRect(d, size, 24, 0, 48, 48, [180, 60, 90]);
            renderStampStroke(d, size, {
                path: [{ x: 8, y: 8 }, { x: 16, y: 20 }, { x: 10, y: 30 }],
                offsetPx: { dx: 24, dy: 4 },
                radiusPx: 4.5,
                opacity: 0.8,
                flow: 0.5,
                hardness: 0.6,
                toneMatch: true,
            });
            return d;
        };
        expect(make()).toEqual(make());
    });
});
