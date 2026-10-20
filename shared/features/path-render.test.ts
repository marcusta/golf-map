import { expect, test } from 'bun:test';
import { pathRender, pathRenderError } from './path-render';

const centerline = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], widthM: 4 };

test('an absent or unknown render is an OPCD mesh', () => {
    expect(pathRender(undefined)).toBe('opcd');
    expect(pathRender({ surface: 'gravel' })).toBe('opcd');
    expect(pathRender({ render: 'ram' })).toBe('ram');
    expect(pathRender({ render: 'spline' })).toBe('opcd');
});

test('ram only on a centerline path that is not a bridge deck', () => {
    expect(pathRenderError(undefined, 'fairway', undefined, undefined)).toBeNull();
    expect(pathRenderError('opcd', 'path', undefined, 'asphalt')).toBeNull();
    expect(pathRenderError('ram', 'path', centerline, 'gravel')).toBeNull();
    expect(pathRenderError('spline', 'path', centerline, 'gravel')).toContain('opcd, ram');
    expect(pathRenderError('ram', 'path', undefined, 'gravel')).toContain('centerline');
    expect(pathRenderError('ram', 'water_creek', centerline, undefined)).toContain('centerline');
    expect(pathRenderError('ram', 'path', centerline, 'bridge')).toContain('bridge');
});
