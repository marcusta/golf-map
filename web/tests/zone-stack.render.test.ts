import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { FeatureStackPanelComponent } from '../src/draw/feature-stack-panel.component';
import { SelectionPanelComponent } from '../src/draw/selection-panel.component';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { CourseZoneType, ZoneTypesApi } from '../../shared/api/zone-types.gen';

// Render smoke for finding zones in Vegetation mode (D-VZ14): the stack panel
// lists every zone under a heading per hole, each named by what it plants, and
// the selection panel files a zone under a hole as a folder, not a "move".

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const TYPES: CourseZoneType[] = [
    {
        id: 'z-creek', courseId: 'c1', key: 'creek_bank', name: 'Creek bank', color: '#5f8a4a',
        textureIndex: 0, channel: 0, sortOrder: 0, items: [],
        variants: [{ key: 'vass', name: 'Vass (common reed)', items: [{ item: 'Reed', minDensity: 0, maxDensity: 1 }] }],
        createdAt: '', updatedAt: '',
    },
    {
        id: 'z-rough', courseId: 'c1', key: 'rough_tall', name: 'Tall rough', color: '#8a9a3c',
        textureIndex: 0, channel: 0, sortOrder: 1, items: [{ item: 'Green base', minDensity: 0, maxDensity: 1 }], variants: [],
        createdAt: '', updatedAt: '',
    },
];

function zone(id: string, holeId: string | null, attributes: Record<string, unknown>, sortOrder = 0): CourseFeature {
    return {
        id, courseId: 'c1', holeId, layer: null, type: 'vegetation_zone',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] },
        geojson: null, sortOrder, source: null, generated: false, sourceRef: null, license: null,
        attributes: attributes as CourseFeature['attributes'], version: 1,
    };
}

async function mount(features: CourseFeature[]) {
    di.set(ConfirmService, new ConfirmService());
    const detail = new CourseDetailService();
    (detail.holes as unknown as { set(v: unknown): void }).set([
        { id: 'h1', courseId: 'c1', number: 1, par: 4 },
        { id: 'h15', courseId: 'c1', number: 15, par: 3 },
    ]);
    di.set(CourseDetailService, detail);
    const zoneTypesApi = {
        async list() { return structuredClone(TYPES); },
    } as unknown as ZoneTypesApi;
    const zoneTypes = new ZoneTypesService(zoneTypesApi);
    di.set(ZoneTypesService, zoneTypes);
    await zoneTypes.load('c1');
    const rows = new Map(features.map(f => [f.id, structuredClone(f)]));
    const api = {
        async listByCourse() { return [...rows.values()].map(f => structuredClone(f)); },
        async update(input: { id: string; version: number; holeId?: string | null }) {
            const row = rows.get(input.id)!;
            if (input.holeId !== undefined) row.holeId = input.holeId;
            row.version = input.version + 1;
            return structuredClone(row);
        },
    } as unknown as CourseFeaturesApi;
    const svc = new FeaturesService(api, createInlineSurfaceStackClient());
    di.set(FeaturesService, svc);
    const tool = new DrawToolService();
    // What activating the Vegetation tool sets (DrawToolService.activate): its scope, and zones shown.
    // (activate needs a live map; its features wiring is all the move uses).
    tool.scope.set('vegetation');
    (tool as unknown as { features: FeaturesService }).features = svc;
    svc.modeHiddenTypes.set(new Set());
    di.set(DrawToolService, tool);
    await svc.load('c1');
    const host = document.createElement('div');
    new FeatureStackPanelComponent({}).mount(host);
    const selection = document.createElement('div');
    new SelectionPanelComponent({}).mount(selection);
    await flush();
    const listed = () => [...host.querySelectorAll('[data-testid="stack-panel-rows"] > *')]
        .map(r => r.textContent!.replace(/\s+/g, ' ').replace(/\d+ pts/, '').trim());
    return { host, selection, svc, rows, listed };
}

test('Vegetation mode lists every zone under its hole, named by what it plants', async () => {
    const { host, listed } = await mount([
        zone('a', null, { zoneType: 'rough_tall' }),
        zone('b', 'h15', { zoneType: 'creek_bank', zoneVariant: 'vass', blend: 'mix', extraPalettes: 'rough_tall=0.5' }),
        zone('c', 'h15', { zoneType: 'rough_tall' }, 1),
    ]);
    expect(host.querySelector<HTMLSelectElement>('[data-testid="stack-panel-scope"]')!.value).toBe('__all-zones');
    expect(listed()).toEqual([
        'No hole (course level) · 1 drawn',
        'Tall rough',
        'Hole 15 · 2 drawn',
        'Tall rough',
        'Creek bank · Vass (common reed) + 1 · adds',
    ]);
});

test('a zone is filed under a hole from the selection panel, and the list follows without leaving All zones', async () => {
    const { host, selection, svc, rows, listed } = await mount([
        zone('a', null, { zoneType: 'rough_tall' }),
        zone('b', 'h15', { zoneType: 'creek_bank', zoneVariant: 'vass' }),
    ]);
    svc.select('a');
    await flush();
    const field = selection.querySelector('.move-field')!;
    expect(field.textContent).toContain('Hole (folder)');
    expect(field.querySelector('[data-testid="move-hole-hint"]')!.className).toContain('show');
    const select = field.querySelector<HTMLSelectElement>('[data-testid="draw-move-hole"]')!;
    expect([...select.options].map(o => o.textContent)).toEqual(['No hole (course level)', 'Hole 1 (par 4)', 'Hole 15 (par 3)']);

    select.value = 'h15';
    select.dispatchEvent(new Event('change'));
    await flush();
    await flush();
    expect(rows.get('a')!.holeId).toBe('h15');
    expect(rows.get('b')!.holeId).toBe('h15');   // the other zone stays where it was filed
    expect(host.querySelector<HTMLSelectElement>('[data-testid="stack-panel-scope"]')!.value).toBe('__all-zones');
    expect(listed()[0]).toBe('Hole 15 · 2 drawn');
    // No stack-order verbs for zones: their order changes nothing.
    expect(host.querySelector('.reorder-ops')!.className).not.toContain('show');
});
