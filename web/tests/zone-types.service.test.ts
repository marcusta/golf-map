import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import {
    ZoneTypesService, zoneTypeKeyOf, zoneVariantKeyOf, slugify, uniqueVariantKey, itemNamesOf,
} from '../src/zones/zone-types.service';
import type { CourseZoneType, ZoneTypesApi } from '../../shared/api/zone-types.gen';

afterEach(() => { _reset(); di.reset(); });

function zoneType(key: string, name: string, color: string, channel: number): CourseZoneType {
    return {
        id: `z-${key}`, courseId: 'c1', key, name, color,
        textureIndex: 0, channel, sortOrder: channel, items: [], variants: [], createdAt: '', updatedAt: '',
    };
}

/** In-memory fake of the zone-types API: the server's list/create/update/remove. */
function fakeApi(initial: CourseZoneType[] = []) {
    const rows = new Map(initial.map(z => [z.id, structuredClone(z)]));
    const calls = { list: 0, create: 0, update: 0, remove: 0, addDefaults: 0 };
    const api: ZoneTypesApi = {
        async list({ courseId }) {
            calls.list++;
            return [...rows.values()].filter(z => z.courseId === courseId).map(z => structuredClone(z));
        },
        async addDefaults({ courseId }) {
            calls.addDefaults++;
            const added = zoneType('meadow', 'Meadow', '#b8a94a', 3);
            added.courseId = courseId;
            rows.set(added.id, added);
            return [structuredClone(added)];
        },
        async create(input) {
            calls.create++;
            const created = zoneType(input.key, input.name, input.color, rows.size);
            created.courseId = input.courseId;
            rows.set(created.id, created);
            return structuredClone(created);
        },
        async update(input) {
            calls.update++;
            const row = rows.get(input.id);
            if (!row) throw new Error('404');
            Object.assign(row, structuredClone(input));
            return structuredClone(row);
        },
        async remove(input) {
            calls.remove++;
            rows.delete(input.id);
            return { ok: true };
        },
        reorder: () => Promise.reject(new Error('not under test')),
    };
    return { api, rows, calls };
}

describe('ZoneTypesService', () => {
    test('load populates the table and caches per courseId', async () => {
        const { api, calls } = fakeApi([zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        const svc = new ZoneTypesService(api);

        await svc.load('c1');
        expect(svc.items.get().map(z => z.key)).toEqual(['shrub']);
        await svc.load('c1');
        expect(calls.list).toBe(1);
    });

    test('a failed load reports the error and leaves the cache open for a retry', async () => {
        const { api, calls } = fakeApi();
        api.list = () => Promise.reject(new Error('offline'));
        const svc = new ZoneTypesService(api);

        await svc.load('c1');
        expect(svc.error.get()).toBe('offline');
        expect(svc.items.get()).toEqual([]);

        api.list = async () => { calls.list++; return [zoneType('fern', 'Ferns', '#4f8c5a', 2)]; };
        await svc.load('c1');
        expect(svc.items.get().map(z => z.key)).toEqual(['fern']);
    });

    test('colours and labels resolve by key, unknown keys degrade quietly', async () => {
        const { api } = fakeApi([zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(svc.colorFor('shrub')).toBe('#6b8f3a');
        expect(svc.labelFor('shrub')).toBe('Shrubs');
        expect(svc.colorFor('gone')).toBe('');
        expect(svc.labelFor('gone')).toBe('gone');
    });

    test('defaultAttributes names the first zone type; the fallback covers an empty table', async () => {
        const { api } = fakeApi([
            zoneType('rough_tall', 'Tall rough', '#8a9a3c', 0),
            zoneType('shrub', 'Shrubs', '#6b8f3a', 1),
        ]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');
        expect(svc.defaultAttributes()).toEqual({ zoneType: 'rough_tall', zoneVariant: '', weight: 1, feather: 2, noise: 0 });

        const empty = new ZoneTypesService(fakeApi().api);
        expect(empty.defaultAttributes().zoneType).toBe('shrub');
    });

    test('attributesOf fills in the defaults for whatever the feature is missing', async () => {
        const { api } = fakeApi([zoneType('rough_tall', 'Tall rough', '#8a9a3c', 0)]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(svc.attributesOf(null)).toEqual({ zoneType: 'rough_tall', zoneVariant: '', weight: 1, feather: 2, noise: 0 });
        expect(svc.attributesOf({ zoneType: 'fern', weight: 0.25 }))
            .toEqual({ zoneType: 'fern', zoneVariant: '', weight: 0.25, feather: 2, noise: 0 });
        expect(svc.attributesOf({ zoneType: 'fern', zoneVariant: 'dense' }).zoneVariant).toBe('dense');
        expect(svc.attributesOf({ zoneType: 'fern', zoneVariant: 3 }).zoneVariant).toBe('');
        // A stored 0 is a value, not a missing key.
        expect(svc.attributesOf({ zoneType: 'fern', weight: 0 }).weight).toBe(0);
    });

    test('every write re-reads the table', async () => {
        const { api, calls, rows } = fakeApi([zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(await svc.create('c1', { key: 'heather', name: 'Heather', color: '#7a5f8a' })).toBe(true);
        expect(svc.items.get().map(z => z.key)).toEqual(['shrub', 'heather']);

        expect(await svc.update('z-shrub', { name: 'Bushes' })).toBe(true);
        expect(svc.items.get().find(z => z.key === 'shrub')!.name).toBe('Bushes');

        expect(await svc.remove('z-shrub')).toBe(true);
        expect(svc.items.get().map(z => z.key)).toEqual(['heather']);
        expect(rows.size).toBe(1);
        expect(calls.list).toBe(4); // the load plus one after each write
    });

    test('a rejected write surfaces the message and leaves the table alone', async () => {
        const { api } = fakeApi([zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        api.update = () => Promise.reject(new Error("Zone type key 'shrub' is already used by this course"));
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(await svc.update('z-shrub', { key: 'shrub' })).toBe(false);
        expect(svc.error.get()).toContain('already used');
        expect(svc.items.get().map(z => z.key)).toEqual(['shrub']);
    });

    test('the panel opens for a course and closes again', async () => {
        const { api } = fakeApi([zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        const svc = new ZoneTypesService(api);

        expect(svc.panelCourseId.get()).toBeNull();
        await svc.openFor('c1');
        expect(svc.panelCourseId.get()).toBe('c1');
        expect(svc.items.get()).toHaveLength(1);
        svc.close();
        expect(svc.panelCourseId.get()).toBeNull();
    });
});

describe('ZoneTypesService variants', () => {
    function roughWithVariants(): CourseZoneType {
        const rough = zoneType('rough_tall', 'Tall rough', '#8a9a3c', 0);
        rough.items = [{ item: 'Green base', minDensity: 0, maxDensity: 1 }];
        rough.variants = [
            { key: 'dry', name: 'Dry straw', items: [{ item: 'Straw', minDensity: 0, maxDensity: 0.4 }] },
        ];
        return rough;
    }

    test('variantsOf lists a type’s variants; unknown types and types without any give none', async () => {
        const { api } = fakeApi([roughWithVariants(), zoneType('shrub', 'Shrubs', '#6b8f3a', 1)]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(svc.variantsOf('rough_tall').map(v => v.key)).toEqual(['dry']);
        expect(svc.variantsOf('shrub')).toEqual([]);
        expect(svc.variantsOf('gone')).toEqual([]);
    });

    test('addVariant appends "New variant" under a key unique in the type, and the key survives a rename', async () => {
        const { api, rows } = fakeApi([roughWithVariants()]);
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(await svc.addVariant(svc.items.get()[0]!)).toBe('new_variant');
        expect(await svc.addVariant(svc.items.get()[0]!)).toBe('new_variant_2');
        const variants = svc.items.get()[0]!.variants;
        expect(variants).toEqual([
            { key: 'dry', name: 'Dry straw', items: [{ item: 'Straw', minDensity: 0, maxDensity: 0.4 }] },
            { key: 'new_variant', name: 'New variant', items: [] },
            { key: 'new_variant_2', name: 'New variant', items: [] },
        ]);

        await svc.update('z-rough_tall', {
            variants: variants.map(v => (v.key === 'new_variant' ? { ...v, name: 'Lush' } : v)),
        });
        expect(rows.get('z-rough_tall')!.variants[1]).toEqual({ key: 'new_variant', name: 'Lush', items: [] });
    });

    test('a failed addVariant reports the error and returns no key', async () => {
        const { api } = fakeApi([roughWithVariants()]);
        api.update = () => Promise.reject(new Error('offline'));
        const svc = new ZoneTypesService(api);
        await svc.load('c1');

        expect(await svc.addVariant(svc.items.get()[0]!)).toBe('');
        expect(svc.error.get()).toBe('offline');
    });
});

describe('uniqueVariantKey / itemNamesOf', () => {
    test('slugs the name and numbers it past the keys the type already has', () => {
        const type = { variants: [{ key: 'dry', name: 'Dry', items: [] }, { key: 'dry_2', name: 'Dry', items: [] }] };
        expect(uniqueVariantKey(type, 'Lush')).toBe('lush');
        expect(uniqueVariantKey(type, 'Dry')).toBe('dry_3');
        expect(uniqueVariantKey({ variants: [] }, '!!!')).toBe('variant');
    });

    test('every distinct item name across Default items and variants, first seen first', () => {
        const rough = zoneType('rough_tall', 'Tall rough', '#8a9a3c', 0);
        rough.items = [{ item: 'Green base', minDensity: 0, maxDensity: 1 }];
        rough.variants = [{
            key: 'dry', name: 'Dry',
            items: [{ item: 'Straw', minDensity: 0, maxDensity: 1 }, { item: 'Green base', minDensity: 0, maxDensity: 0.3 }],
        }];
        const shrub = zoneType('shrub', 'Shrubs', '#6b8f3a', 1);
        shrub.items = [{ item: 'Hazel', minDensity: 0, maxDensity: 1 }, { item: 'Straw', minDensity: 0, maxDensity: 1 }];
        expect(itemNamesOf([rough, shrub])).toEqual(['Green base', 'Straw', 'Hazel']);
        expect(itemNamesOf([])).toEqual([]);
    });
});

describe('zoneVariantKeyOf', () => {
    test('reads the variant key, else empty (= Default)', () => {
        expect(zoneVariantKeyOf({ zoneType: 'fern', zoneVariant: 'dense' })).toBe('dense');
        expect(zoneVariantKeyOf({ zoneType: 'fern' })).toBe('');
        expect(zoneVariantKeyOf({ zoneVariant: 7 })).toBe('');
        expect(zoneVariantKeyOf(null)).toBe('');
    });
});

describe('zoneTypeKeyOf', () => {
    test('reads the key off a feature’s attributes, else empty', () => {
        expect(zoneTypeKeyOf({ zoneType: 'fern' })).toBe('fern');
        expect(zoneTypeKeyOf({ heightMaxM: 12 })).toBe('');
        expect(zoneTypeKeyOf(null)).toBe('');
        expect(zoneTypeKeyOf(undefined)).toBe('');
    });
});

describe('slugify (panel: display name → zone-type key)', () => {
    test('produces keys the server accepts', () => {
        for (const [name, key] of [
            ['Tall rough', 'tall_rough'],
            ['Ljung / hed', 'ljung_hed'],
            ['Ängsmark', 'angsmark'],
            ['  Ferns  ', 'ferns'],
            ['!!!', ''],
        ] as const) {
            expect(slugify(name)).toBe(key);
            if (key) expect(key).toMatch(/^[a-z0-9_]+$/);
        }
    });
});
