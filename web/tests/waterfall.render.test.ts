import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import type { ToolContext } from '../src/editor/tool';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { SelectionPanelComponent } from '../src/draw/selection-panel.component';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { ZoneTypesApi } from '../../shared/api/zone-types.gen';

// Waterfall (shared/features/waterfall.ts): its style picked in the selection
// panel, with a cascade's stream width and a fountain's jet height, each change
// one undo step in Draw.

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fall(id: string, attributes: Record<string, unknown> | null): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, layer: null, type: 'waterfall',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: -1 }, { x: 6, y: -1 }, { x: 6, y: 1 }, { x: 0, y: 1 }] }],
            centerline: { points: [{ x: 0, y: 0 }, { x: 6, y: 0 }], widthM: 2 } },
        sortOrder: 0, source: null, generated: false, sourceRef: null, license: null,
        attributes: attributes as CourseFeature['attributes'], no: 30, version: 1,
    };
}

/** `listByCourse`, `update` and `updateMany` are reached; `updates` records the attribute writes per feature. */
function featuresApi(rows: CourseFeature[]) {
    const updates: { id: string; attributes: unknown }[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const apply = (input: { id: string; version: number; attributes?: unknown }) => {
        const row = rows.find(r => r.id === input.id)!;
        if (input.attributes !== undefined) {
            updates.push({ id: input.id, attributes: structuredClone(input.attributes) });
            row.attributes = input.attributes as CourseFeature['attributes'];
        }
        row.version = input.version + 1;
        return structuredClone(row);
    };
    const api = {
        async listByCourse() { return structuredClone(rows); },
        async update(input: { id: string; version: number; attributes?: unknown }) { return apply(input); },
        async updateMany(input: { items: { id: string; version: number; attributes?: unknown }[] }) { return input.items.map(apply); },
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
    const tool = new DrawToolService();
    di.set(DrawToolService, tool);
    await features.load('c1');
    tool.attach({ features, track: () => {} } as unknown as ToolContext);
    const host = document.createElement('div');
    new SelectionPanelComponent({}).mount(host);
    return { host, features, tool, updates };
}

const q = <T extends HTMLElement>(host: HTMLElement, id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const shown = (el: Element) => el.classList.contains('show');
const fieldOf = (host: HTMLElement, id: string) => q(host, id).closest('label')!;

function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('change'));
}

describe('selection panel: waterfall', () => {
    test('shows the style (Sill when unset) for a waterfall, not for other types; the four styles are offered', async () => {
        const { host, features } = await mount([fall('w1', null), { ...fall('b1', null), type: 'bunker' } as CourseFeature]);
        features.select('b1');
        await flush();
        expect(shown(q(host, 'waterfall-section'))).toBe(false);

        features.select('w1');
        await flush();
        expect(shown(q(host, 'waterfall-section'))).toBe(true);
        const select = q<HTMLSelectElement>(host, 'waterfall-style-select');
        expect([...select.options].map(o => o.textContent)).toEqual(['Sill', 'Outlet', 'Cascade', 'Fountain']);
        expect(select.value).toBe('sill');
        expect(shown(fieldOf(host, 'waterfall-width'))).toBe(false);
        expect(shown(fieldOf(host, 'waterfall-height'))).toBe(false);
        expect(fieldOf(host, 'waterfall-style-select').title).toContain('Cascade: down over rocks');
    });

    test('a style change keeps the other attributes and is one undo step; a cascade shows its stream width', async () => {
        const { host, features, tool, updates } = await mount([fall('w1', { style: 'sill', topM: 104.2, bottomM: 103.1, sillM: 1 })]);
        features.select('w1');
        await flush();

        change(q(host, 'waterfall-style-select'), 'cascade');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'cascade', topM: 104.2, bottomM: 103.1, sillM: 1 } });
        expect(shown(fieldOf(host, 'waterfall-width'))).toBe(true);
        expect(q<HTMLInputElement>(host, 'waterfall-width').value).toBe('1.2');      // the default stream

        change(q(host, 'waterfall-width'), '9');                                     // clamped to 0.2..5
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'cascade', topM: 104.2, bottomM: 103.1, sillM: 1, widthM: 5 } });

        tool.undo();
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'cascade', topM: 104.2, bottomM: 103.1, sillM: 1 } });
        tool.undo();
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'sill', topM: 104.2, bottomM: 103.1, sillM: 1 } });
        expect(q<HTMLSelectElement>(host, 'waterfall-style-select').value).toBe('sill');
    });

    test('a fountain shows its jet height; clearing it drops the key', async () => {
        const { host, features, updates } = await mount([fall('w1', { style: 'fountain', heightM: 2.5 })]);
        features.select('w1');
        await flush();
        expect(shown(fieldOf(host, 'waterfall-height'))).toBe(true);
        expect(shown(fieldOf(host, 'waterfall-width'))).toBe(false);
        expect(q<HTMLInputElement>(host, 'waterfall-height').value).toBe('2.5');

        change(q(host, 'waterfall-height'), '0.1');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'fountain', heightM: 0.2 } });
        change(q(host, 'waterfall-height'), '');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 'w1', attributes: { style: 'fountain' } });
        expect(q<HTMLInputElement>(host, 'waterfall-height').value).toBe('1.5');
    });

    test('several selected waterfalls: Mixed while they differ, then set together in one undo step', async () => {
        const { host, features, tool, updates } = await mount([fall('w1', { style: 'outlet' }), fall('w2', null)]);
        features.select('w1');
        features.toggleSelected('w2');
        await flush();
        const select = q<HTMLSelectElement>(host, 'waterfall-style-select');
        expect(select.value).toBe('__mixed');
        expect(select.options[0]!.textContent).toBe('Mixed');

        change(select, 'fountain');
        await flush();
        expect(updates).toEqual([
            { id: 'w1', attributes: { style: 'fountain' } },
            { id: 'w2', attributes: { style: 'fountain' } },
        ]);
        expect(select.value).toBe('fountain');
        tool.undo();
        await flush();
        expect(updates.slice(2).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
            { id: 'w1', attributes: { style: 'outlet' } },
            { id: 'w2', attributes: null },
        ]);
    });
});
