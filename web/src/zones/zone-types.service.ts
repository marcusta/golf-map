// The course's vegetation zone-type table (docs/feature-vegetation-zones.md
// §5): the legend every `vegetation_zone` feature points into with its
// `zoneType` attribute, plus the VSPro binding (texture + channel) and the
// item bindings the Unity importer wires up (D-VZ9).
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
import type { CourseZoneType, ZoneTypeItem, ZoneTypesApi } from '../../../shared/api/zone-types.gen';

export type { CourseZoneType, ZoneTypeItem };

/**
 * Defaults for a newly drawn zone's attributes (§5). `zoneType` comes from
 * the course's table; this key is only the fallback for the impossible case
 * of an empty table.
 */
export const FALLBACK_ZONE_TYPE_KEY = 'shrub';
export const ZONE_WEIGHT_DEFAULT = 1;
export const ZONE_FEATHER_DEFAULT_M = 2;
export const ZONE_NOISE_DEFAULT_M = 0;

/** The four `vegetation_zone` attribute keys, as stored on the feature. */
export interface ZoneAttributes {
    zoneType: string;
    weight: number;
    feather: number;
    noise: number;
}

/** The zone-type key a feature's attributes name ('' when it has none). */
export function zoneTypeKeyOf(attributes: unknown): string {
    const key = (attributes as Record<string, unknown> | null | undefined)?.zoneType;
    return typeof key === 'string' ? key : '';
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

    /**
     * A zone feature's attributes with the defaults filled in. The generated
     * client types `attributes` as an opaque object (the codegen cannot carry
     * an index signature), so the read goes through one place instead of a
     * cast at every call site.
     */
    attributesOf(attributes: unknown): ZoneAttributes {
        const raw = (attributes ?? {}) as Record<string, unknown>;
        const defaults = this.defaultAttributes();
        return {
            zoneType: typeof raw.zoneType === 'string' && raw.zoneType ? raw.zoneType : defaults.zoneType,
            weight: typeof raw.weight === 'number' ? raw.weight : defaults.weight,
            feather: typeof raw.feather === 'number' ? raw.feather : defaults.feather,
            noise: typeof raw.noise === 'number' ? raw.noise : defaults.noise,
        };
    }

    /**
     * Attributes for a zone the user just drew: the table's first zone type
     * at full weight with the default feather and no edge noise.
     */
    defaultAttributes(): ZoneAttributes {
        return {
            zoneType: this.items.peek()[0]?.key ?? FALLBACK_ZONE_TYPE_KEY,
            weight: ZONE_WEIGHT_DEFAULT,
            feather: ZONE_FEATHER_DEFAULT_M,
            noise: ZONE_NOISE_DEFAULT_M,
        };
    }

    async create(courseId: string, input: { key: string; name: string; color: string }): Promise<boolean> {
        return this.mutate(() => this.client.create({ courseId, ...input }));
    }

    async update(id: string, patch: {
        key?: string; name?: string; color?: string;
        textureIndex?: number; channel?: number; items?: ZoneTypeItem[];
    }): Promise<boolean> {
        return this.mutate(() => this.client.update({ id, ...patch }));
    }

    async remove(id: string): Promise<boolean> {
        return this.mutate(() => this.client.remove({ id }));
    }

    async addDefaults(courseId: string): Promise<boolean> {
        return this.mutate(() => this.client.addDefaults({ courseId }));
    }

    /**
     * Every write re-reads the table rather than patching locally: the server
     * assigns mask slots and sort order, and the table is four to eight rows,
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
