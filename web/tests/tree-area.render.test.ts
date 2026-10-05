import { test, expect, describe, afterEach } from 'bun:test';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
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

// Render pass for the tree species area's section of the selection panel
// (shared/features/tree-areas.ts): the one place a person edits an area's mix.

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function area(attributes: Record<string, unknown>): CourseFeature {
    return {
        id: 'area-1', courseId: 'c1', holeId: null, layer: null, type: 'tree_area',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }] }] },
        sortOrder: 0, source: null, generated: false, sourceRef: null, license: null,
        attributes: attributes as CourseFeature['attributes'], no: null, version: 1,
    };
}

/** Only `listByCourse` and `update` are reached; `updates` records the attribute writes. */
function featuresApi(feature: CourseFeature) {
    const row = structuredClone(feature);
    const updates: Record<string, unknown>[] = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api = {
        async listByCourse() { return [structuredClone(row)]; },
        async update(input: { id: string; version: number; type?: string; attributes?: unknown }) {
            if (input.type !== undefined) row.type = input.type as CourseFeature['type'];
            if (input.attributes !== undefined) {
                updates.push(structuredClone(input.attributes) as Record<string, unknown>);
                row.attributes = input.attributes as CourseFeature['attributes'];
            }
            row.version = input.version + 1;
            return structuredClone(row);
        },
        listByHole: reject, geojsonByCourse: reject, create: reject, remove: reject, reorder: reject,
    } as unknown as CourseFeaturesApi;
    return { api, updates, row };
}

async function services(feature: CourseFeature) {
    di.set(ConfirmService, new ConfirmService());
    di.set(CourseDetailService, new CourseDetailService());
    const noZoneTypes = { async list() { return []; }, async addDefaults() { return []; } } as unknown as ZoneTypesApi;
    const zoneTypes = new ZoneTypesService(noZoneTypes);
    di.set(ZoneTypesService, zoneTypes);
    await zoneTypes.load('c1');
    const { api, updates, row } = featuresApi(feature);
    const features = new FeaturesService(api, createInlineSurfaceStackClient());
    di.set(FeaturesService, features);
    const tool = new DrawToolService();
    di.set(DrawToolService, tool);
    await features.load('c1');
    features.select(feature.id);
    return { features, tool, updates, row };
}

async function mount(attributes: Record<string, unknown>) {
    const { updates, tool } = await services(area(attributes));
    const host = document.createElement('div');
    new SelectionPanelComponent({}).mount(host);
    return { host, updates, tool };
}

/** The draw tool in Vegetation mode over `features`, on a map stub that never loads. */
function activateVegetation(tool: DrawToolService, features: FeaturesService): void {
    const map = {
        ready: new Signal(false),
        map: new Signal(null),
        interactionMode: new Signal('vegetation'),
        onClick: () => () => {},
        onMouseMove: () => () => {},
        addOverlayLayer: () => {},
        updateOverlayData: () => {},
        removeOverlayLayer: () => {},
    };
    const ctx = { map, elevation: null, tileset: null, courseDetail: null, features, courseId: 'c1', track: () => {} } as unknown as ToolContext;
    tool.activate(ctx, { scope: 'vegetation', toolId: 'vegetation' });
}

describe('the zone-type picker converts the selection', () => {
    test('a selected zone becomes a tree species area and back, keeping both settings for undo', async () => {
        const zone = { ...area({ zoneType: 'rough_tall', zoneVariant: '', weight: 0.8, feather: 2, noise: 0 }), type: 'vegetation_zone' } as CourseFeature;
        const { features, tool, row } = await services(zone);
        activateVegetation(tool, features);
        tool.drawTreeMix.set('oak=9, birch');

        tool.chooseTreeArea();
        await flush();
        expect(row.type).toBe('tree_area');
        expect(row.attributes).toMatchObject({ species: 'oak=9, birch', zoneType: 'rough_tall', weight: 0.8 });
        expect(tool.drawType.get()).toBe('vegetation_zone'); // a conversion, not the next shape

        tool.undo();
        await flush();
        expect(row.type).toBe('vegetation_zone');
        tool.redo();
        await flush();
        expect(row.type).toBe('tree_area');

        tool.chooseZoneType('shrub'); // an area selected: it becomes a zone of that type
        await flush();
        expect(row.type).toBe('vegetation_zone');
        expect(row.attributes).toMatchObject({ zoneType: 'shrub', weight: 0.8, species: 'oak=9, birch' });
        expect(tool.drawZoneType.get()).not.toBe('shrub');

        features.select(null);
        tool.chooseTreeArea(); // nothing selected: the next drawn shape
        expect(tool.drawType.get()).toBe('tree_area');
    });
});

describe('selection panel: tree species area', () => {
    const rows = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="tree-area-species"]')];
    const cells = (row: Element) => [
        row.querySelector<HTMLInputElement>('[data-testid="tree-area-species-name"]')!.value,
        row.querySelector<HTMLInputElement>('[data-testid="tree-area-species-weight"]')!.value,
        row.querySelector('.tree-species-share')!.textContent,
    ];

    test('shows the section with one row per species, its weight and its share', async () => {
        const { host } = await mount({ species: 'oak=9, birch', name: 'Oak grove' });

        expect(host.querySelector('[data-testid="tree-area-section"]')!.classList.contains('show')).toBe(true);
        expect(host.querySelector('[data-testid="path-surface-section"]')!.classList.contains('show')).toBe(false);
        expect(rows(host).map(cells)).toEqual([['oak', '9', '90%'], ['birch', '1', '10%']]);
        expect(host.querySelector<HTMLInputElement>('[data-testid="tree-area-name"]')!.value).toBe('Oak grove');
        expect(host.querySelector<HTMLInputElement>('[data-testid="tree-area-ignore-kind"]')!.checked).toBe(false);
        expect(document.getElementById('tree-area-species-options')!.querySelectorAll('option').length).toBeGreaterThan(5);
    });

    test('editing, adding and removing species writes the whole mix back, and the next area starts with it', async () => {
        const { host, updates, tool } = await mount({ species: 'oak=9, birch', name: 'Oak grove' });
        const mix = () => updates.at(-1)!.species;

        const weight = rows(host)[1]!.querySelector<HTMLInputElement>('[data-testid="tree-area-species-weight"]')!;
        weight.value = '3';
        weight.dispatchEvent(new Event('change'));
        await flush();
        expect(mix()).toBe('oak=9, birch=3');
        // The rows are refreshed in place (the shares follow), so the focus survives an edit.
        expect(rows(host)[1]!.querySelector('[data-testid="tree-area-species-weight"]')).toBe(weight);
        expect(rows(host).map(cells)).toEqual([['oak', '9', '75%'], ['birch', '3', '25%']]);

        const name = rows(host)[1]!.querySelector<HTMLInputElement>('[data-testid="tree-area-species-name"]')!;
        name.value = 'Elm';
        name.dispatchEvent(new Event('change'));
        await flush();
        expect(mix()).toBe('oak=9, elm=3');

        host.querySelector<HTMLButtonElement>('[data-testid="tree-area-add"]')!.click();
        await flush();
        expect(mix()).toBe('oak=9, elm=3, birch'); // the first suggestion the mix does not have

        rows(host)[0]!.querySelector<HTMLButtonElement>('[data-testid="tree-area-species-remove"]')!.click();
        await flush();
        expect(mix()).toBe('elm=3, birch');
        expect(updates.every(u => u.name === 'Oak grove')).toBe(true);
        expect(tool.drawTreeMix.get()).toBe('elm=3, birch');
    });

    test('a bad species name or a mix of zeros is not saved', async () => {
        const { host, updates } = await mount({ species: 'oak' });

        const name = rows(host)[0]!.querySelector<HTMLInputElement>('[data-testid="tree-area-species-name"]')!;
        name.value = 'red oak';
        name.dispatchEvent(new Event('change'));
        const weight = rows(host)[0]!.querySelector<HTMLInputElement>('[data-testid="tree-area-species-weight"]')!;
        weight.value = '0';
        weight.dispatchEvent(new Event('change'));
        await flush();

        expect(updates).toEqual([]);
        expect(name.value).toBe('oak');
        expect(weight.value).toBe('1');
        expect(rows(host)[0]!.querySelector<HTMLButtonElement>('[data-testid="tree-area-species-remove"]')!.disabled).toBe(true);
    });

    test('name and the survey-class switch save with the mix; clearing the name drops it', async () => {
        const { host, updates } = await mount({ species: 'oak', name: 'Oak grove' });

        const kind = host.querySelector<HTMLInputElement>('[data-testid="tree-area-ignore-kind"]')!;
        kind.checked = true;
        kind.dispatchEvent(new Event('change'));
        await flush();
        expect(updates.at(-1)).toEqual({ species: 'oak', name: 'Oak grove', ignoreKind: true });

        const name = host.querySelector<HTMLInputElement>('[data-testid="tree-area-name"]')!;
        name.value = '  ';
        name.dispatchEvent(new Event('change'));
        await flush();
        expect(updates.at(-1)).toEqual({ species: 'oak', ignoreKind: true });
    });
});
