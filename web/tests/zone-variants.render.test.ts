import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ConfirmService } from '../src/app/confirm-dialog.component';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { DrawToolService } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import { SelectionPanelComponent } from '../src/draw/selection-panel.component';
import { createInlineSurfaceStackClient } from '../src/draw/surface-stack-client';
import { ZoneTypesPanelComponent } from '../src/zones/zone-types-panel.component';
import { ZoneTypesService } from '../src/zones/zone-types.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { CourseZoneType, ZoneTypesApi } from '../../shared/api/zone-types.gen';

// Render smoke for zone-type variants (there are no per-component specs by
// design — TESTING.md — but the two places a person edits variants are worth
// one pass through happy-dom): the zone-type panel's Default / variants
// sections and the selection panel's Variant picker.

afterEach(() => { _reset(); di.reset(); });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function zoneType(key: string, name: string, extra: Partial<CourseZoneType> = {}): CourseZoneType {
    return {
        id: `z-${key}`, courseId: 'c1', key, name, color: '#8a9a3c',
        textureIndex: 0, channel: 0, sortOrder: 0, items: [], variants: [],
        createdAt: '', updatedAt: '', ...extra,
    };
}

function roughTall(): CourseZoneType {
    return zoneType('rough_tall', 'Tall rough', {
        items: [{ item: 'Green base', minDensity: 0, maxDensity: 1 }],
        variants: [
            { key: 'dry', name: 'Dry straw', items: [{ item: 'Straw', minDensity: 0, maxDensity: 0.4 }] },
        ],
    });
}

/** The zone-types API over an in-memory table; `updates` records every update input. */
function zoneTypesApi(initial: CourseZoneType[]) {
    const rows = new Map(initial.map(z => [z.id, structuredClone(z)]));
    const updates: Parameters<ZoneTypesApi['update']>[0][] = [];
    const api: ZoneTypesApi = {
        async list() { return [...rows.values()].map(z => structuredClone(z)); },
        async addDefaults() { return []; },
        create: () => Promise.reject(new Error('not under test')),
        async update(input) {
            updates.push(structuredClone(input));
            const row = rows.get(input.id)!;
            Object.assign(row, structuredClone(input));
            return structuredClone(row);
        },
        remove: () => Promise.reject(new Error('not under test')),
        reorder: () => Promise.reject(new Error('not under test')),
    };
    return { api, rows, updates };
}

describe('zone-types panel', () => {
    async function mount(types: CourseZoneType[]) {
        const fake = zoneTypesApi(types);
        const svc = new ZoneTypesService(fake.api);
        di.set(ZoneTypesService, svc);
        const host = document.createElement('div');
        new ZoneTypesPanelComponent({}).mount(host);
        await svc.openFor('c1');
        return { host, svc, ...fake };
    }

    test('no mask slot inputs; Default items and each variant render with their own bindings', async () => {
        const { host } = await mount([roughTall()]);

        expect(host.querySelector('[aria-label="Texture index"]')).toBeNull();
        expect(host.querySelector('[aria-label="Channel"]')).toBeNull();
        expect(host.textContent).not.toContain('four types per texture');

        const row = host.querySelector('[data-testid="zone-type-row"]')!;
        const def = row.querySelector('[data-testid="zone-type-default"]')!;
        expect(def.textContent).toContain('Default');
        expect([...def.querySelectorAll<HTMLInputElement>('[aria-label="Vegetation item"]')].map(i => i.value))
            .toEqual(['Green base']);

        const variants = [...row.querySelectorAll('[data-testid="zone-type-variant"]')];
        expect(variants).toHaveLength(1);
        expect(variants[0]!.querySelector<HTMLInputElement>('[aria-label="Variant name"]')!.value).toBe('Dry straw');
        expect(variants[0]!.querySelector('code')!.textContent).toBe('dry');
        expect([...variants[0]!.querySelectorAll<HTMLInputElement>('[aria-label="Vegetation item"]')].map(i => i.value))
            .toEqual(['Straw']);
    });

    test('item inputs autocomplete from every item name in the table', async () => {
        const { host } = await mount([roughTall(), zoneType('shrub', 'Shrubs', {
            items: [{ item: 'Hazel', minDensity: 0, maxDensity: 1 }, { item: 'Straw', minDensity: 0, maxDensity: 1 }],
        })]);

        const datalist = host.querySelector('datalist')!;
        expect([...datalist.querySelectorAll('option')].map(o => o.value)).toEqual(['Green base', 'Straw', 'Hazel']);
        const inputs = [...host.querySelectorAll<HTMLInputElement>('[aria-label="Vegetation item"]')];
        expect(inputs.length).toBe(4);
        expect(inputs.every(i => i.getAttribute('list') === datalist.id)).toBe(true);
    });

    test('Add variant, rename it (key kept), bind an item, then remove it', async () => {
        const { host, rows } = await mount([roughTall()]);
        const row = () => host.querySelector('[data-testid="zone-type-row"]')!;
        const variantEls = () => [...row().querySelectorAll('[data-testid="zone-type-variant"]')];

        row().querySelector<HTMLButtonElement>('[data-testid="zone-type-add-variant"]')!.click();
        await flush();
        expect(rows.get('z-rough_tall')!.variants.map(v => [v.key, v.name]))
            .toEqual([['dry', 'Dry straw'], ['new_variant', 'New variant']]);
        expect(variantEls()).toHaveLength(2);

        const name = variantEls()[1]!.querySelector<HTMLInputElement>('[aria-label="Variant name"]')!;
        name.value = 'Lush';
        name.dispatchEvent(new Event('change'));
        await flush();
        expect(rows.get('z-rough_tall')!.variants[1]).toEqual({ key: 'new_variant', name: 'Lush', items: [] });

        variantEls()[1]!.querySelector<HTMLButtonElement>('.zt-row__add-item')!.click();
        await flush();
        const item = variantEls()[1]!.querySelector<HTMLInputElement>('[aria-label="Vegetation item"]')!;
        item.value = 'Tall green';
        item.dispatchEvent(new Event('change'));
        await flush();
        expect(rows.get('z-rough_tall')!.variants[1]!.items).toEqual([{ item: 'Tall green', minDensity: 0, maxDensity: 1 }]);
        // The Default mix and the other variant are untouched.
        expect(rows.get('z-rough_tall')!.items).toEqual([{ item: 'Green base', minDensity: 0, maxDensity: 1 }]);
        expect(rows.get('z-rough_tall')!.variants[0]!.items).toEqual([{ item: 'Straw', minDensity: 0, maxDensity: 0.4 }]);

        variantEls()[0]!.querySelector<HTMLButtonElement>('[aria-label="Delete variant"]')!.click();
        await flush();
        expect(rows.get('z-rough_tall')!.variants.map(v => v.key)).toEqual(['new_variant']);
    });
});

describe('selection panel: Variant picker', () => {
    function zoneFeature(attributes: Record<string, unknown>): CourseFeature {
        return {
            id: 'zone-1', courseId: 'c1', holeId: null, layer: null, type: 'vegetation_zone',
            geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] },
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
            async update(input: { id: string; version: number; attributes?: unknown }) {
                if (input.attributes !== undefined) {
                    updates.push(structuredClone(input.attributes) as Record<string, unknown>);
                    row.attributes = input.attributes as CourseFeature['attributes'];
                }
                row.version = input.version + 1;
                return structuredClone(row);
            },
            listByHole: reject, geojsonByCourse: reject, create: reject, remove: reject, reorder: reject,
        } as unknown as CourseFeaturesApi;
        return { api, updates };
    }

    async function mount(types: CourseZoneType[], attributes: Record<string, unknown>) {
        di.set(ConfirmService, new ConfirmService());
        di.set(CourseDetailService, new CourseDetailService());
        const zoneTypes = new ZoneTypesService(zoneTypesApi(types).api);
        di.set(ZoneTypesService, zoneTypes);
        await zoneTypes.load('c1');
        const { api, updates } = featuresApi(zoneFeature(attributes));
        const features = new FeaturesService(api, createInlineSurfaceStackClient());
        di.set(FeaturesService, features);
        di.set(DrawToolService, new DrawToolService());
        await features.load('c1');
        features.select('zone-1');

        const host = document.createElement('div');
        new SelectionPanelComponent({}).mount(host);
        const field = host.querySelector('.zone-variant-field')!;
        const select = host.querySelector<HTMLSelectElement>('[data-testid="zone-variant-select"]')!;
        return { host, field, select, updates };
    }

    const base = { weight: 1, feather: 2, noise: 0 };
    /** What every save adds for a zone that has never set them (shared/features/zone-layers.ts). */
    const layers = { blend: 'replace', extraPalettes: '' };

    test('lists Default plus the type’s variants and shows the zone’s variant', async () => {
        const { field, select } = await mount([roughTall()], { zoneType: 'rough_tall', zoneVariant: 'dry', ...base });

        expect(field.classList.contains('show')).toBe(true);
        expect([...select.options].map(o => [o.value, o.textContent])).toEqual([['', 'Default'], ['dry', 'Dry straw']]);
        expect(select.value).toBe('dry');
    });

    test('is hidden when the zone’s type has no variants', async () => {
        const { field, select } = await mount([roughTall(), zoneType('shrub', 'Shrubs')], { zoneType: 'shrub', ...base });

        expect(field.classList.contains('show')).toBe(false);
        expect(select.value).toBe('');
    });

    test('picking a variant saves it with the other zone attributes', async () => {
        const { select, updates } = await mount([roughTall()], { zoneType: 'rough_tall', ...base, weight: 0.5 });
        expect(select.value).toBe('');

        select.value = 'dry';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([{ zoneType: 'rough_tall', zoneVariant: 'dry', weight: 0.5, feather: 2, noise: 0, ...layers }]);
    });

    test('changing the zone type resets the variant to Default', async () => {
        const { host, updates } = await mount(
            [roughTall(), zoneType('shrub', 'Shrubs')],
            { zoneType: 'rough_tall', zoneVariant: 'dry', ...base },
        );
        const typeSelect = host.querySelector<HTMLSelectElement>('[data-testid="zone-type-select"]')!;

        typeSelect.value = 'shrub';
        typeSelect.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([{ zoneType: 'shrub', zoneVariant: '', ...base, ...layers }]);
    });

    /** Vreta's creek_bank: palettes only (Default binds nothing), `reed_wet` the water half of `reed`. */
    const creekBankPalettes = () => zoneType('creek_bank', 'Creek bank', {
        variants: [
            { key: 'lush', name: 'Lush tall grass', items: [{ item: 'Creek - tall green', minDensity: 0, maxDensity: 1 }] },
            { key: 'reed', name: 'Reed & cattail', items: [{ item: 'Creek - blades', minDensity: 0, maxDensity: 1 }] },
            { key: 'reed_wet', name: 'Reed & cattail (wet)', items: [{ item: 'Creek - cattail', minDensity: 0, maxDensity: 1 }] },
        ],
    });

    test('a creek_bank zone picks a palette: no `_wet` halves, and Default says it plants nothing', async () => {
        const { select } = await mount([roughTall(), creekBankPalettes()], { zoneType: 'creek_bank', zoneVariant: 'reed', ...base });
        expect([...select.options].map(o => [o.value, o.textContent])).toEqual([
            ['', 'Default (no items: plants nothing)'], ['lush', 'Lush tall grass'], ['reed', 'Reed & cattail'],
        ]);

        // A zone already on a wet half keeps it, marked for what it is.
        const wet = await mount([roughTall(), creekBankPalettes()], { zoneType: 'creek_bank', zoneVariant: 'reed_wet', ...base });
        expect(wet.select.value).toBe('reed_wet');
        expect(wet.select.options[wet.select.options.length - 1]!.textContent).toBe('Reed & cattail (wet) (water half only)');
    });

    test('retyping a zone to a type whose Default binds nothing starts it on the first palette', async () => {
        const { host, updates } = await mount([roughTall(), creekBankPalettes()], { zoneType: 'rough_tall', ...base });
        const typeSelect = host.querySelector<HTMLSelectElement>('[data-testid="zone-type-select"]')!;

        typeSelect.value = 'creek_bank';
        typeSelect.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([{ zoneType: 'creek_bank', zoneVariant: 'lush', ...base, ...layers }]);
        expect(di.get(ZoneTypesService).startVariantOf('rough_tall')).toBe('');
    });

    test('a variant its type no longer has stays visible as its own option', async () => {
        const { field, select } = await mount([roughTall()], { zoneType: 'rough_tall', zoneVariant: 'gone', ...base });

        expect(field.classList.contains('show')).toBe(true);
        expect(select.value).toBe('gone');
        expect(select.options[select.options.length - 1]!.textContent).toBe('gone (no such variant)');
    });

    test('Overlap shows the zone’s blend and saves Mix with the other attributes', async () => {
        const { host, updates } = await mount([roughTall()], { zoneType: 'rough_tall', ...base });
        const blend = host.querySelector<HTMLSelectElement>('[data-testid="zone-blend-select"]')!;
        expect(blend.value).toBe('replace');

        blend.value = 'mix';
        blend.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([{ zoneType: 'rough_tall', zoneVariant: '', ...base, blend: 'mix', extraPalettes: '' }]);
        expect(blend.value).toBe('mix');
    });

    test('Also plants lists the extra palettes with their variant and weight', async () => {
        const { host } = await mount([roughTall(), zoneType('shrub', 'Shrubs')], {
            zoneType: 'shrub', ...base, extraPalettes: 'rough_tall/dry=0.4, gone',
        });
        const rows = [...host.querySelectorAll('[data-testid="zone-extra-palette"]')];
        const read = (row: Element) => ({
            type: row.querySelector<HTMLSelectElement>('[data-testid="zone-extra-type"]')!.value,
            variant: row.querySelector<HTMLSelectElement>('[data-testid="zone-extra-variant"]')!,
            weight: row.querySelector<HTMLInputElement>('[data-testid="zone-extra-weight"]')!.value,
        });
        const [dry, gone] = rows.map(read);
        expect(rows).toHaveLength(2);
        expect(dry!.type).toBe('rough_tall');
        expect(dry!.variant.value).toBe('dry');
        expect(dry!.variant.style.display).toBe('');
        expect(dry!.weight).toBe('0.4');
        // A type the table no longer has keeps its own option; no variants to pick.
        expect(gone!.type).toBe('gone');
        expect(gone!.variant.style.display).toBe('none');
    });

    test('adding, editing and removing extra palettes writes the whole list back', async () => {
        const { host, updates } = await mount([roughTall(), zoneType('shrub', 'Shrubs')], { zoneType: 'rough_tall', ...base });
        const extras = () => updates.at(-1)!.extraPalettes;

        host.querySelector<HTMLButtonElement>('[data-testid="zone-extra-add"]')!.click();
        await flush();
        expect(extras()).toBe('shrub'); // the first type the zone does not plant yet

        const row = () => host.querySelector('[data-testid="zone-extra-palette"]')!;
        const weight = row().querySelector<HTMLInputElement>('[data-testid="zone-extra-weight"]')!;
        weight.value = '0.3';
        weight.dispatchEvent(new Event('change'));
        await flush();
        expect(extras()).toBe('shrub=0.3');

        const type = row().querySelector<HTMLSelectElement>('[data-testid="zone-extra-type"]')!;
        type.value = 'rough_tall';
        type.dispatchEvent(new Event('change'));
        await flush();
        expect(extras()).toBe('rough_tall=0.3');

        const variant = row().querySelector<HTMLSelectElement>('[data-testid="zone-extra-variant"]')!;
        variant.value = 'dry';
        variant.dispatchEvent(new Event('change'));
        await flush();
        expect(extras()).toBe('rough_tall/dry=0.3');

        row().querySelector<HTMLButtonElement>('[data-testid="zone-extra-remove"]')!.click();
        await flush();
        expect(extras()).toBe('');
        expect(host.querySelectorAll('[data-testid="zone-extra-palette"]')).toHaveLength(0);
        expect(updates.every(u => u.zoneType === 'rough_tall' && u.weight === 1)).toBe(true);
    });
});

describe('selection panel: creek bank palette', () => {
    function creek(id: string, attributes: Record<string, unknown> | null): CourseFeature {
        return {
            id, courseId: 'c1', holeId: null, layer: null, type: 'water_creek',
            geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }] }] },
            sortOrder: 0, source: null, generated: false, sourceRef: null, license: null,
            attributes: attributes as CourseFeature['attributes'], no: null, version: 1,
        };
    }

    const creekBank = () => zoneType('creek_bank', 'Creek bank', {
        variants: [
            { key: 'lush', name: 'Lush tall grass', items: [{ item: 'Creek - tall green', minDensity: 0, maxDensity: 1 }] },
            { key: 'reed', name: 'Reed & cattail', items: [{ item: 'Creek - blades', minDensity: 0, maxDensity: 1 }] },
            // The wet half of `reed`: never offered on its own.
            { key: 'reed_wet', name: 'Reed & cattail (wet)', items: [{ item: 'Creek - cattail', minDensity: 0, maxDensity: 1 }] },
        ],
    });

    async function mount(creeks: CourseFeature[], backdrop: string[] = []) {
        const confirm = new ConfirmService();
        const asked: string[] = [];
        confirm.confirm = async (opts: { title: string }) => { asked.push(opts.title); return false; };
        di.set(ConfirmService, confirm);
        di.set(CourseDetailService, new CourseDetailService());
        const zoneTypes = new ZoneTypesService(zoneTypesApi([roughTall(), creekBank()]).api);
        di.set(ZoneTypesService, zoneTypes);
        await zoneTypes.load('c1');
        const rows = new Map(creeks.map(c => [c.id, structuredClone(c)]));
        const updates: [string, unknown][] = [];
        const reject = () => Promise.reject(new Error('not under test'));
        const api = {
            async listByCourse() { return [...rows.values()].map(r => structuredClone(r)); },
            async update(input: { id: string; version: number; attributes?: unknown }) {
                const row = rows.get(input.id)!;
                updates.push([input.id, structuredClone(input.attributes)]);
                row.attributes = input.attributes as CourseFeature['attributes'];
                row.version = input.version + 1;
                return structuredClone(row);
            },
            listByHole: reject, geojsonByCourse: reject, create: reject, remove: reject, reorder: reject,
        } as unknown as CourseFeaturesApi;
        const features = new FeaturesService(api, createInlineSurfaceStackClient());
        di.set(FeaturesService, features);
        di.set(DrawToolService, new DrawToolService());
        await features.load('c1');
        // Vegetation mode shows the course as a backdrop (DrawToolService.activate).
        features.modeBackdropTypes.set(new Set(backdrop));
        features.setSelection(creeks.map(c => c.id));

        const host = document.createElement('div');
        new SelectionPanelComponent({}).mount(host);
        return {
            host, features, asked,
            section: host.querySelector('[data-testid="creek-bank-section"]')!,
            palette: host.querySelector<HTMLSelectElement>('[data-testid="creek-bank-palette"]')!,
            cover: host.querySelector<HTMLInputElement>('[data-testid="creek-bank-cover"]')!,
            updates,
        };
    }

    test('offers None plus the creek_bank palettes; picking one keeps the creek’s other attributes', async () => {
        const { section, palette, cover, updates } = await mount([creek('c-1', { digPreset: 'meadow_brook' })]);

        expect(section.classList.contains('show')).toBe(true);
        expect([...palette.options].map(o => [o.value, o.textContent]))
            .toEqual([['', 'None'], ['lush', 'Lush tall grass'], ['reed', 'Reed & cattail']]);
        expect(palette.value).toBe('');
        expect(cover.parentElement!.classList.contains('show')).toBe(false);

        palette.value = 'reed';
        palette.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([['c-1', { digPreset: 'meadow_brook', bankVeg: 'reed' }]]);
        expect(cover.parentElement!.classList.contains('show')).toBe(true);
        expect(cover.value).toBe('50');

        cover.value = '35';
        cover.dispatchEvent(new Event('change'));
        await flush();
        expect(updates[1]).toEqual(['c-1', { digPreset: 'meadow_brook', bankVeg: 'reed', bankVegCover: 0.35 }]);

        palette.value = '';
        palette.dispatchEvent(new Event('change'));
        await flush();
        expect(updates[2]).toEqual(['c-1', { digPreset: 'meadow_brook', bankVegCover: 0.35 }]);
    });

    test('how far up the bank it grows, and how far the water plants reach, are set per creek', async () => {
        const { host, updates } = await mount([creek('c-1', { digPreset: 'meadow_brook', bankVeg: 'reed' })]);
        const max = host.querySelector<HTMLInputElement>('[data-testid="creek-bank-max"]')!;
        const wet = host.querySelector<HTMLInputElement>('[data-testid="creek-bank-wet"]')!;
        // Defaults shown; the water-plants field only because `reed` has a `reed_wet` mix.
        expect([max.value, wet.value]).toEqual(['4.5', '1']);
        expect(wet.parentElement!.classList.contains('show')).toBe(true);

        wet.value = '0.3';
        wet.dispatchEvent(new Event('change'));
        await flush();
        max.value = '2';
        max.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([
            ['c-1', { digPreset: 'meadow_brook', bankVeg: 'reed', bankVegWetM: 0.3 }],
            ['c-1', { digPreset: 'meadow_brook', bankVeg: 'reed', bankVegWetM: 0.3, bankVegMaxM: 2 }],
        ]);

        // A palette with no water mix has nothing to reach up the bank.
        const lush = await mount([creek('c-2', { bankVeg: 'lush' })]);
        expect(lush.host.querySelector('[data-testid="creek-bank-wet"]')!.parentElement!.classList.contains('show')).toBe(false);
    });

    test('a water polygon (a dug pond or channel) takes a palette too', async () => {
        const { section, palette, updates } = await mount([{ ...creek('p-1', { digPreset: 'parkland_shelf' }), type: 'water' }]);
        expect(section.classList.contains('show')).toBe(true);
        palette.value = 'reed';
        palette.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([['p-1', { digPreset: 'parkland_shelf', bankVeg: 'reed' }]]);
    });

    test('in Vegetation mode a selected creek or water is read-only: bank vegetation only, no delete', async () => {
        const water = { ...creek('p-1', { digPreset: 'parkland_shelf' }), type: 'water' };
        const { host, features, asked, section, palette, updates } = await mount([water, creek('c-1', null)], ['water', 'water_creek', 'fairway']);
        const shown = (sel: string) => host.querySelector(sel)!.classList.contains('show');

        expect(section.classList.contains('show')).toBe(true);
        expect(host.querySelector('[data-testid="creek-bank-section"] .section-title')!.textContent).toBe('Bank vegetation (2 waters)');
        expect(shown('[data-testid="backdrop-hint"]')).toBe(true);
        expect(features.editableSelectedFeatures.get()).toEqual([]);
        expect(host.querySelector('.delete-btn')!.classList.contains('hidden')).toBe(true);
        expect(host.querySelector('.move-field')!.classList.contains('hidden')).toBe(true);
        expect(shown('.offset-section') || shown('.simplify-section')).toBe(false);

        palette.value = 'reed';
        palette.dispatchEvent(new Event('change'));
        await flush();
        expect(updates).toEqual([['p-1', { digPreset: 'parkland_shelf', bankVeg: 'reed' }], ['c-1', { bankVeg: 'reed' }]]);

        // Del does nothing to them here: not even a confirm.
        await di.get(DrawToolService).deleteSelected();
        expect(asked).toEqual([]);
    });

    test('is hidden for other types', async () => {
        const { section } = await mount([{ ...creek('b-1', null), type: 'bunker' }]);
        expect(section.classList.contains('show')).toBe(false);
    });
});
