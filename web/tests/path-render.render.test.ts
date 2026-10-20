import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { SelectionPanelComponent } from '../src/draw/selection-panel.component';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { ZoneTypesApi } from '../../shared/api/zone-types.gen';

// Path render (shared/features/path-render.ts): an OPCD road mesh or a R.A.M.
// spline on the ground meshes, picked in the selection panel's path section
// next to the surface.

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function road(id: string, attributes: Record<string, unknown> | null, centerline = true): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, layer: null, type: 'path',
        geometry: {
            crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: -2 }, { x: 40, y: -2 }, { x: 40, y: 2 }, { x: 0, y: 2 }] }],
            ...(centerline ? { centerline: { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], widthM: 4 } } : {}),
        },
        sortOrder: 0, source: null, generated: false, sourceRef: null, license: null,
        attributes: attributes as CourseFeature['attributes'], no: 38, version: 1,
    };
}

/** Only `listByCourse` and `update` are reached; `updates` records the attribute writes per feature. */
function featuresApi(rows: CourseFeature[]) {
    const updates: { id: string; attributes: unknown }[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api = {
        async listByCourse() { return structuredClone(rows); },
        async update(input: { id: string; version: number; attributes?: unknown }) {
            const row = rows.find(r => r.id === input.id)!;
            if (input.attributes !== undefined) {
                updates.push({ id: input.id, attributes: structuredClone(input.attributes) });
                row.attributes = input.attributes as CourseFeature['attributes'];
            }
            row.version = input.version + 1;
            return structuredClone(row);
        },
        listByHole: reject, geojsonByCourse: reject, create: reject, remove: reject, reorder: reject,
    } as unknown as CourseFeaturesApi;
    return { api, updates };
}

async function mount(rows: CourseFeature[]) {
    di.set(ConfirmService, new ConfirmService());
    di.set(CourseDetailService, new CourseDetailService());
    const noZoneTypes = { async list() { return []; }, async addDefaults() { return []; } } as unknown as ZoneTypesApi;
    const zoneTypes = new ZoneTypesService(noZoneTypes);
    di.set(ZoneTypesService, zoneTypes);
    await zoneTypes.load('c1');
    const { api, updates } = featuresApi(rows);
    const features = new FeaturesService(api, createInlineSurfaceStackClient());
    di.set(FeaturesService, features);
    di.set(DrawToolService, new DrawToolService());
    await features.load('c1');
    const host = document.createElement('div');
    new SelectionPanelComponent({}).mount(host);
    return { host, features, updates };
}

const picker = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('[data-testid="path-render-select"]')!;
const options = (select: HTMLSelectElement) => [...select.options].map(o => o.textContent);

function pick(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change'));
}

describe('selection panel: path render', () => {
    test('sits in the path section with its explanation in the tooltip; a road without the key is an OPCD mesh', async () => {
        const { host, features } = await mount([road('p1', { surface: 'gravel' })]);
        features.select('p1');
        await flush();

        const section = host.querySelector('[data-testid="path-surface-section"]')!;
        expect(section.classList.contains('show')).toBe(true);
        expect(section.contains(picker(host))).toBe(true);
        expect(host.querySelector('[data-testid="path-render-field"]')!.getAttribute('title'))
            .toBe('R.A.M.: drawn in Unity on the ground, out of the OPCD build. Needs a new OPCD build to take effect.');
        expect(options(picker(host))).toEqual(['OPCD mesh', 'R.A.M. spline']);
        expect(picker(host).value).toBe('opcd');
        expect(picker(host).disabled).toBe(false);
    });

    test('R.A.M. writes the key keeping the other attributes, and OPCD mesh drops it again', async () => {
        const { host, features, updates } = await mount([road('p1', { surface: 'gravel' })]);
        features.select('p1');
        await flush();

        pick(picker(host), 'ram');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'p1', attributes: { surface: 'gravel', render: 'ram' } });
        expect(picker(host).value).toBe('ram');

        pick(picker(host), 'opcd');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'p1', attributes: { surface: 'gravel' } });
        expect(picker(host).value).toBe('opcd');
    });

    test('a path drawn as an outline (no centerline) cannot be R.A.M.: the picker is off and says why', async () => {
        const { host, features } = await mount([road('p1', null, false)]);
        features.select('p1');
        await flush();

        expect(picker(host).disabled).toBe(true);
        expect(picker(host).title).toContain('centerline');
    });

    test('paths that disagree show Mixed; R.A.M. is set on the ones that can take it only', async () => {
        const { host, features, updates } = await mount([
            road('p1', { render: 'ram' }), road('p2', { surface: 'asphalt' }), road('p3', null, false),
        ]);
        features.select('p1');
        features.toggleSelected('p2');
        features.toggleSelected('p3');
        await flush();

        expect(options(picker(host))).toEqual(['Mixed', 'OPCD mesh', 'R.A.M. spline']);
        expect(picker(host).value).toBe('__mixed');
        expect(picker(host).disabled).toBe(false);
        expect(picker(host).title).toBe('2 of 3 paths can be R.A.M. (centerline roads, not bridges)');

        pick(picker(host), 'ram');
        await flush();
        expect(updates).toEqual([{ id: 'p2', attributes: { surface: 'asphalt', render: 'ram' } }]);
    });
});
