import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { FEATURE_STYLES, FEATURE_TYPES, TYPE_Z_ORDER, typeColorExpression } from '../src/draw/feature-palette';
import { scopeOwnsType } from '../src/draw/draw-hover';
import { SelectionPanelComponent } from '../src/draw/selection-panel.component';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { ZoneTypesApi } from '../../shared/api/zone-types.gen';

// Rock slab (shared/features/rock-slab.ts): a surface drawn in Draw mode, with
// its margin and texture tile size edited in the selection panel.

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function slab(id: string, attributes: Record<string, unknown> | null): CourseFeature {
    return {
        id, courseId: 'c1', holeId: null, layer: null, type: 'rock_slab',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }] }] },
        sortOrder: 0, source: null, generated: false, sourceRef: null, license: null,
        attributes: attributes as CourseFeature['attributes'], no: 26, version: 1,
    };
}

/** Only `listByCourse` and `update` are reached; `updates` records the attribute writes per feature. */
function featuresApi(rows: CourseFeature[]) {
    const updates: { id: string; attributes: unknown }[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api = {
        async listByCourse() { return structuredClone(rows); },
        async update(input: { id: string; version: number; type?: string; attributes?: unknown }) {
            const row = rows.find(r => r.id === input.id)!;
            if (input.type !== undefined) row.type = input.type as CourseFeature['type'];
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
    const tool = new DrawToolService();
    di.set(DrawToolService, tool);
    await features.load('c1');
    const host = document.createElement('div');
    new SelectionPanelComponent({}).mount(host);
    return { host, features, tool, updates };
}

const field = (host: HTMLElement, id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
const section = (host: HTMLElement) => host.querySelector('[data-testid="rock-slab-section"]')!;

function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('change'));
}

describe('rock slab: the type', () => {
    test('is a Draw-mode surface type with its own colours, drawn above the grass and below the bunkers', () => {
        expect(FEATURE_TYPES).toContain('rock_slab');
        expect(FEATURE_STYLES.rock_slab.label).toBe('Rock slab');
        expect(scopeOwnsType('surfaces', 'rock_slab')).toBe(true);
        expect(scopeOwnsType('rules', 'rock_slab') || scopeOwnsType('vegetation', 'rock_slab')).toBe(false);
        expect(TYPE_Z_ORDER.indexOf('rock_slab')).toBeGreaterThan(TYPE_Z_ORDER.indexOf('green'));
        expect(TYPE_Z_ORDER.indexOf('rock_slab')).toBeLessThan(TYPE_Z_ORDER.indexOf('bunker'));
        const expr = typeColorExpression('fill');
        expect(expr[expr.indexOf('rock_slab') + 1]).toBe(FEATURE_STYLES.rock_slab.fill);
    });

    test('Draw can arm it for the next shape', async () => {
        const { tool } = await mount([slab('s1', null)]);
        tool.chooseType('rock_slab');
        expect(tool.drawType.get()).toBe('rock_slab');
    });
});

describe('selection panel: rock slab', () => {
    test('shows the section with the defaults for a slab without attributes, and not for other types', async () => {
        const { host, features } = await mount([slab('s1', null), { ...slab('b1', null), type: 'bunker' } as CourseFeature]);

        features.select('b1');
        await flush();
        expect(section(host).classList.contains('show')).toBe(false);

        features.select('s1');
        await flush();
        expect(section(host).classList.contains('show')).toBe(true);
        expect(field(host, 'rock-slab-margin').value).toBe('1.5');
        expect(field(host, 'rock-slab-tile').value).toBe('4');
    });

    test('editing writes the number, keeps the other attributes, and clearing drops the key', async () => {
        const { host, features, updates } = await mount([slab('s1', { marginM: 2, note: 'knoll' })]);
        features.select('s1');
        await flush();
        expect(field(host, 'rock-slab-margin').value).toBe('2');

        type(field(host, 'rock-slab-tile'), '6');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 's1', attributes: { marginM: 2, note: 'knoll', uvM: 6 } });

        type(field(host, 'rock-slab-margin'), '');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 's1', attributes: { note: 'knoll', uvM: 6 } });
        expect(field(host, 'rock-slab-margin').value).toBe('1.5');
    });

    test('a margin outside 0..5 m is clamped, a tile size under 0.5 m raised to it', async () => {
        const { host, features, updates } = await mount([slab('s1', null)]);
        features.select('s1');
        await flush();

        type(field(host, 'rock-slab-margin'), '9');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 's1', attributes: { marginM: 5 } });
        type(field(host, 'rock-slab-margin'), '-2');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 's1', attributes: { marginM: 0 } });

        type(field(host, 'rock-slab-tile'), '0.1');
        await flush();
        expect(updates.at(-1)).toEqual({ id: 's1', attributes: { marginM: 0, uvM: 0.5 } });
    });

    test('several selected slabs are set at once, each keeping its own other attributes', async () => {
        const { host, features, updates } = await mount([slab('s1', { uvM: 3 }), slab('s2', null)]);
        features.select('s1');
        features.toggleSelected('s2');
        await flush();
        expect(field(host, 'rock-slab-tile').value).toBe(''); // they differ

        type(field(host, 'rock-slab-margin'), '2.5');
        await flush();
        expect(updates).toEqual([
            { id: 's1', attributes: { uvM: 3, marginM: 2.5 } },
            { id: 's2', attributes: { marginM: 2.5 } },
        ]);
    });
});
