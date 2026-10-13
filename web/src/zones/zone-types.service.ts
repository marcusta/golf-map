// The course's vegetation zone-type table (docs/feature-vegetation-zones.md
// §5): the legend every `vegetation_zone` feature points into with its
// `zoneType` attribute, and the VSPro item bindings the Unity importer wires
// up (D-VZ9): the type's Default items plus any named variants (each its own
// item mix), which a zone picks with its `zoneVariant` attribute. The mask
// channels are the pipeline's business (one per item); the type's legacy
// texture/channel fields are kept by the server but no longer edited here.
//
// One table per course, loaded once and cached. The server seeds the four
// defaults on the first list, so `load()` never comes back empty for a course
// that exists — the draw tool can always name a zone type for a new zone.
//
// Two consumers: the selection panel's zone section (picker + colours) and the
// zone-type editor panel (this service also holds that panel's open state, the
// same way GsproExportService does).
//
// DI singleton; the constructor takes the API client so it is testable
// headlessly.

import { Signal, Computed } from '@basics/core/client/core';
import { api } from '../api';
import type { CourseZoneType, ZoneTypeItem, ZoneTypeVariant, ZoneTypesApi } from '../../../shared/api/zone-types.gen';
import { CREEK_BANK_ZONE_TYPE, isWetBankVariant } from '../../../shared/features/creek-vegetation';
import { zoneBlendOf, type ZoneBlend } from '../../../shared/features/zone-layers';
import { zoneHeightOf } from '../../../shared/features/zone-height';

export type { CourseZoneType, ZoneTypeItem, ZoneTypeVariant };

/**
 * Defaults for a newly drawn zone's attributes (§5). `zoneType` comes from
 * the course's table; this key is only the fallback for the impossible case
 * of an empty table.
 */
export const FALLBACK_ZONE_TYPE_KEY = 'shrub';
export const ZONE_WEIGHT_DEFAULT = 1;
export const ZONE_FEATHER_DEFAULT_M = 2;
export const ZONE_NOISE_DEFAULT_M = 0;
/**
 * How wide a drawn zone's mix fades into the vegetation beside it when it has
 * no `edgeBlend` of its own (gspro.py DEFAULT_ZONE_EDGE_BLEND_M; generated and
 * "Add to it" zones default to 0 there).
 */
export const ZONE_EDGE_BLEND_DEFAULT_M = 8;

/** Name a fresh variant gets (and its key's slug), to be typed over. */
export const NEW_VARIANT_NAME = 'New variant';

/**
 * The `vegetation_zone` attribute keys, as stored on the feature.
 * `zoneVariant` is a variant key of the zone's type; '' is the Default mix.
 * `blend` and `extraPalettes` (the attribute string, '' = none) say how the
 * zone adds up with others (shared/features/zone-layers.ts). `edgeBlend`
 * is absent until set: the pipeline's default then applies. `heightMin` and
 * `heightMax` (metres, both or neither) are the height the zone's bushes are
 * scaled to; absent = the palette's own sizes (shared/features/zone-height.ts).
 */
export interface ZoneAttributes {
    zoneType: string;
    zoneVariant: string;
    weight: number;
    feather: number;
    noise: number;
    blend: ZoneBlend;
    extraPalettes: string;
    edgeBlend?: number;
    heightMin?: number;
    heightMax?: number;
}

/** The zone-type key a feature's attributes name ('' when it has none). */
export function zoneTypeKeyOf(attributes: unknown): string {
    const key = (attributes as Record<string, unknown> | null | undefined)?.zoneType;
    return typeof key === 'string' ? key : '';
}

/** The variant key a feature's attributes name ('' = Default, also when absent). */
export function zoneVariantKeyOf(attributes: unknown): string {
    const key = (attributes as Record<string, unknown> | null | undefined)?.zoneVariant;
    return typeof key === 'string' ? key : '';
}

/** Display name → key: the server accepts `[a-z0-9_]+` only (zone types and variants alike). */
export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[åä]/g, 'a')
        .replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * A key for a new variant named `name`, unique among the type's variants:
 * the slug, then `_2`, `_3`… Chosen once at creation and never re-derived,
 * so renaming the variant later leaves the zones that name it bound.
 */
export function uniqueVariantKey(zoneType: Pick<CourseZoneType, 'variants'>, name: string): string {
    const base = slugify(name) || 'variant';
    const taken = new Set(zoneType.variants.map(v => v.key));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
    }
}

/**
 * Every distinct item name bound anywhere in the table (Default items and
 * every variant's), in first-seen order: the panel's autocomplete list.
 */
export function itemNamesOf(types: readonly CourseZoneType[]): string[] {
    const names = new Set<string>();
    for (const zoneType of types) {
        for (const binding of zoneType.items) if (binding.item.trim()) names.add(binding.item);
        for (const variant of zoneType.variants ?? []) {
            for (const binding of variant.items) if (binding.item.trim()) names.add(binding.item);
        }
    }
    return [...names];
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export class ZoneTypesService {
    readonly items = new Signal<CourseZoneType[]>([]);
    readonly loading = new Signal(false);
    readonly error = new Signal<string>('');
    /** Course the editor panel is open for; null = closed. */
    readonly panelCourseId = new Signal<string | null>(null);

    /** key → zone type, for the colour/label lookups the map and panels do. */
    readonly byKey = new Computed<Map<string, CourseZoneType>>(() =>
        new Map(this.items.get().map(z => [z.key, z])));

    private loadedCourseId: string | null = null;

    constructor(private readonly client: ZoneTypesApi = api.zoneTypes) {}

    /** Load the course's table (cached per courseId). */
    async load(courseId: string): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        this.loading.set(true);
        this.error.set('');
        try {
            const items = await this.client.list({ courseId });
            this.items.set(items);
            this.loadedCourseId = courseId;
        } catch (e) {
            this.error.set(messageOf(e));
        } finally {
            this.loading.set(false);
        }
    }

    /** Re-fetch the loaded course's table (after an edit elsewhere). */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.loadedCourseId = null;
        await this.load(courseId);
    }

    /** Open the zone-type editor for a course (loads the table first). */
    async openFor(courseId: string): Promise<void> {
        this.panelCourseId.set(courseId);
        await this.load(courseId);
    }

    close(): void {
        this.panelCourseId.set(null);
    }

    /** Editor colour for a zone-type key ('' when the key is unknown). */
    colorFor(key: string): string {
        return this.byKey.get().get(key)?.color ?? '';
    }

    /** Display name for a zone-type key (the key itself when unknown). */
    labelFor(key: string): string {
        return this.byKey.get().get(key)?.name ?? key;
    }

    /** The named variants of a zone type ([] when it has none or is unknown). */
    variantsOf(key: string): ZoneTypeVariant[] {
        return this.byKey.get().get(key)?.variants ?? [];
    }

    /**
     * The variants a zone picks from: all of them, except a creek_bank
     * `<palette>_wet` (the water half of `<palette>`, which the generator
     * splits in itself; picked alone it puts the water mix up the whole bank).
     */
    pickableVariantsOf(key: string): ZoneTypeVariant[] {
        const variants = this.variantsOf(key);
        return key === CREEK_BANK_ZONE_TYPE ? variants.filter(v => !isWetBankVariant(v.key)) : variants;
    }

    /** True when the type's Default mix binds items (a zone on it plants something). */
    hasDefaultItems(key: string): boolean {
        return (this.byKey.get().get(key)?.items.length ?? 0) > 0;
    }

    /**
     * The variant a zone of this type starts on (drawn, or retyped): Default,
     * unless Default binds nothing and the type has variants - then the first
     * pickable one, so a new zone plants something (Vreta's creek_bank has
     * only palettes).
     */
    startVariantOf(key: string): string {
        if (this.hasDefaultItems(key)) return '';
        return this.pickableVariantsOf(key)[0]?.key ?? '';
    }

    /**
     * A zone feature's attributes with the defaults filled in. The generated
     * client types `attributes` as an opaque object (the codegen cannot carry
     * an index signature), so the read goes through one place instead of a
     * cast at every call site.
     */
    attributesOf(attributes: unknown): ZoneAttributes {
        const raw = (attributes ?? {}) as Record<string, unknown>;
        const defaults = this.defaultAttributes();
        const height = zoneHeightOf(raw);
        return {
            zoneType: typeof raw.zoneType === 'string' && raw.zoneType ? raw.zoneType : defaults.zoneType,
            zoneVariant: zoneVariantKeyOf(raw),
            weight: typeof raw.weight === 'number' ? raw.weight : defaults.weight,
            feather: typeof raw.feather === 'number' ? raw.feather : defaults.feather,
            noise: typeof raw.noise === 'number' ? raw.noise : defaults.noise,
            blend: zoneBlendOf(raw),
            extraPalettes: typeof raw.extraPalettes === 'string' ? raw.extraPalettes : defaults.extraPalettes,
            ...(typeof raw.edgeBlend === 'number' ? { edgeBlend: raw.edgeBlend } : {}),
            ...(height ? { heightMin: height.min, heightMax: height.max } : {}),
        };
    }

    /**
     * Attributes for a zone the user just drew: the table's first zone type
     * (its Default mix) at full weight with the default feather and no edge
     * noise, replacing what is below it, with no extra palettes.
     */
    defaultAttributes(): ZoneAttributes {
        const zoneType = this.items.peek()[0]?.key ?? FALLBACK_ZONE_TYPE_KEY;
        return {
            zoneType,
            zoneVariant: this.startVariantOf(zoneType),
            weight: ZONE_WEIGHT_DEFAULT,
            feather: ZONE_FEATHER_DEFAULT_M,
            noise: ZONE_NOISE_DEFAULT_M,
            blend: 'replace',
            extraPalettes: '',
        };
    }

    async create(courseId: string, input: { key: string; name: string; color: string }): Promise<boolean> {
        return this.mutate(() => this.client.create({ courseId, ...input }));
    }

    async update(id: string, patch: {
        key?: string; name?: string; color?: string;
        textureIndex?: number; channel?: number; items?: ZoneTypeItem[];
        variants?: ZoneTypeVariant[];
    }): Promise<boolean> {
        return this.mutate(() => this.client.update({ id, ...patch }));
    }

    /**
     * Append a variant named `name` to a zone type, keyed by its slug made
     * unique within the type. Returns the new key ('' when the write failed).
     */
    async addVariant(zoneType: CourseZoneType, name = NEW_VARIANT_NAME): Promise<string> {
        const key = uniqueVariantKey(zoneType, name);
        const ok = await this.update(zoneType.id, {
            variants: [...zoneType.variants, { key, name, items: [] }],
        });
        return ok ? key : '';
    }

    async remove(id: string): Promise<boolean> {
        return this.mutate(() => this.client.remove({ id }));
    }

    async addDefaults(courseId: string): Promise<boolean> {
        return this.mutate(() => this.client.addDefaults({ courseId }));
    }

    /**
     * Every write re-reads the table rather than patching locally: the server
     * assigns sort order (and legacy mask slots), and the table is four to eight rows,
     * so the round trip is cheaper than keeping two copies honest.
     */
    private async mutate(op: () => Promise<unknown>): Promise<boolean> {
        this.loading.set(true);
        this.error.set('');
        try {
            await op();
            const courseId = this.loadedCourseId;
            if (courseId) this.items.set(await this.client.list({ courseId }));
            return true;
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            this.loading.set(false);
        }
    }
}
