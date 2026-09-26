import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseZoneTypesTable } from '../db/schema';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

// --- Constants ---

/** Zone-type keys are lowercase identifiers: they name a mask channel, not a label. */
const KEY_PATTERN = /^[a-z0-9_]+$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** RGBA: one texture carries four zone types (docs/feature-vegetation-zones.md §4). */
export const CHANNELS_PER_TEXTURE = 4;

/**
 * The starter legend, seeded on a course's FIRST `listByCourse` (see the
 * service doc). Texture 0's four channels: tall rough, shrubs, ferns,
 * meadow — the lower vegetation the OPCD courses need before anyone has
 * authored anything — and the woodland floor on texture 1. Every field is editable afterwards, and a course that
 * deletes them all keeps them deleted (seeding is keyed on "this course has
 * never had a zone type", not "has none right now").
 */
export const DEFAULT_ZONE_TYPES: readonly {
    key: string;
    name: string;
    color: string;
    textureIndex: number;
    channel: number;
}[] = [
    { key: 'rough_tall', name: 'Tall rough', color: '#8a9a3c', textureIndex: 0, channel: 0 },
    { key: 'shrub', name: 'Shrubs', color: '#6b8f3a', textureIndex: 0, channel: 1 },
    { key: 'fern', name: 'Ferns', color: '#4f8c5a', textureIndex: 0, channel: 2 },
    { key: 'meadow', name: 'Meadow', color: '#b8a94a', textureIndex: 0, channel: 3 },
    // The floor of closed stands (D-VZ10): lidar proposes these zones
    // (`woodland-features`, source `lidar-woodland`), the understory items bind here.
    { key: 'woodland_floor', name: 'Woodland floor', color: '#6b5a34', textureIndex: 1, channel: 0 },
];

// --- Output types ---

/**
 * One VSPro vegetation item bound to a zone type (D-VZ9): the item's name in
 * the package, and the density range its texture-mask density rule maps the
 * sampled channel value (0..1) onto.
 */
export interface ZoneTypeItem {
    item: string;
    minDensity: number;
    maxDensity: number;
}

/**
 * A named item mix of a zone type (e.g. Tall rough -> "Dry straw"). A
 * `vegetation_zone` feature picks one by `key` in its `zoneVariant`
 * attribute; a zone with no variant uses the type's own `items` (the
 * Default mix). The key is the stable binding — renaming changes `name` only.
 */
export interface ZoneTypeVariant {
    key: string;
    name: string;
    items: ZoneTypeItem[];
}

export interface CourseZoneType {
    id: string;
    courseId: string;
    key: string;
    name: string;
    color: string;
    /** Mask texture this type's channel lives on (four channels per texture). */
    textureIndex: number;
    /** RGBA channel 0..3 within that texture. */
    channel: number;
    sortOrder: number;
    /** The Default item mix: what zones with no `zoneVariant` get. */
    items: ZoneTypeItem[];
    /** Named alternative mixes, in the order the panel lists them. */
    variants: ZoneTypeVariant[];
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type ZoneTypeRow = Selectable<CourseZoneTypesTable>;

function toZoneType(row: ZoneTypeRow): CourseZoneType {
    return {
        id: row.id,
        courseId: row.course_id,
        key: row.key,
        name: row.name,
        color: row.color,
        textureIndex: row.texture_index,
        channel: row.channel,
        sortOrder: row.sort_order,
        items: parseItems(row.items_json),
        variants: parseVariants(row.variants_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Defensive: a malformed items_json must not break the whole list. */
function parseItems(raw: string): ZoneTypeItem[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ZoneTypeItem[]) : [];
    } catch {
        return [];
    }
}

/** Same defensive parse as items: malformed variants_json reads as no variants. */
function parseVariants(raw: string): ZoneTypeVariant[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ZoneTypeVariant[]) : [];
    } catch {
        return [];
    }
}

// --- Validation ---

export class InvalidZoneTypeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidZoneTypeError';
    }
}

function assertValidKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        throw new InvalidZoneTypeError(`key must match ${KEY_PATTERN.source} (got ${JSON.stringify(key)})`);
    }
}

function assertValidName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new InvalidZoneTypeError('name must be a non-empty string');
    }
}

function assertValidColor(color: unknown): asserts color is string {
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
        throw new InvalidZoneTypeError(`color must be #rrggbb (got ${JSON.stringify(color)})`);
    }
}

function assertValidTextureIndex(textureIndex: unknown): asserts textureIndex is number {
    if (!Number.isInteger(textureIndex) || (textureIndex as number) < 0) {
        throw new InvalidZoneTypeError('textureIndex must be an integer >= 0');
    }
}

function assertValidChannel(channel: unknown): asserts channel is number {
    if (!Number.isInteger(channel) || (channel as number) < 0 || (channel as number) >= CHANNELS_PER_TEXTURE) {
        throw new InvalidZoneTypeError(`channel must be an integer 0..${CHANNELS_PER_TEXTURE - 1}`);
    }
}

function assertValidItems(items: unknown, path = 'items'): asserts items is ZoneTypeItem[] {
    if (!Array.isArray(items)) throw new InvalidZoneTypeError(`${path} must be an array`);
    items.forEach((raw, i) => {
        const item = raw as Partial<ZoneTypeItem>;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new InvalidZoneTypeError(`${path}[${i}] must be an object`);
        }
        if (typeof item.item !== 'string' || item.item.trim().length === 0) {
            throw new InvalidZoneTypeError(`${path}[${i}].item must be a non-empty string`);
        }
        for (const field of ['minDensity', 'maxDensity'] as const) {
            const value = item[field];
            if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 1) {
                throw new InvalidZoneTypeError(`${path}[${i}].${field} must be a number 0..1`);
            }
        }
        if ((item.minDensity as number) > (item.maxDensity as number)) {
            throw new InvalidZoneTypeError(`${path}[${i}].minDensity must be <= maxDensity`);
        }
    });
}

/**
 * Variant keys follow the zone-type key pattern and are unique within the
 * type; names are non-empty; items are validated exactly like the Default's.
 */
function assertValidVariants(variants: unknown): asserts variants is ZoneTypeVariant[] {
    if (!Array.isArray(variants)) throw new InvalidZoneTypeError('variants must be an array');
    const seen = new Set<string>();
    variants.forEach((raw, i) => {
        const variant = raw as Partial<ZoneTypeVariant>;
        if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
            throw new InvalidZoneTypeError(`variants[${i}] must be an object`);
        }
        if (typeof variant.key !== 'string' || !KEY_PATTERN.test(variant.key)) {
            throw new InvalidZoneTypeError(
                `variants[${i}].key must match ${KEY_PATTERN.source} (got ${JSON.stringify(variant.key)})`,
            );
        }
        if (seen.has(variant.key)) {
            // A conflict, like a duplicate type key: `mount()` maps it to 409 (the
            // API schema already pins every other variant field to a 400).
            throw new ConflictError(`Variant key '${variant.key}' is used twice in this zone type`);
        }
        seen.add(variant.key);
        if (typeof variant.name !== 'string' || variant.name.trim().length === 0) {
            throw new InvalidZoneTypeError(`variants[${i}].name must be a non-empty string`);
        }
        assertValidItems(variant.items, `variants[${i}].items`);
    });
}

function normalizeItems(items: ZoneTypeItem[]): ZoneTypeItem[] {
    return items.map((i) => ({ item: i.item, minDensity: i.minDensity, maxDensity: i.maxDensity }));
}

function normalizeVariants(variants: ZoneTypeVariant[]): ZoneTypeVariant[] {
    return variants.map((v) => ({ key: v.key, name: v.name, items: normalizeItems(v.items) }));
}

/**
 * The course's vegetation zone-type table (docs/feature-vegetation-zones.md
 * §5): the legend a `vegetation_zone` feature's `zoneType` attribute names,
 * and the only thing that assigns a zone type to a VSPro texture-mask channel.
 *
 * Seeding is "on first list" (the plan's cheaper option): `listByCourse`
 * inserts `DEFAULT_ZONE_TYPES` when the course has no rows, so the editor
 * panel, the selection panel's picker and the pipeline's export all get a
 * usable legend without anyone running a bootstrap step. `addDefaults` is the
 * same insert, exposed for the panel's "Add the default zone types" button
 * (it fills in only the keys the course is missing).
 *
 * There is no `version` column and so no optimistic locking: the table is a
 * short, course-level legend edited by one builder at a time, unlike the
 * feature stack.
 */
export class ZoneTypesService {
    constructor(private db: Kysely<Database>) {}

    private zoneTypes() {
        return this.db.selectFrom('course_zone_types').selectAll();
    }

    private byId(id: string) {
        return this.zoneTypes().where('id', '=', id);
    }

    private async rowOrThrow(id: string): Promise<ZoneTypeRow> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Zone type ${id} not found`);
        return row;
    }

    /**
     * The course's zone types, bottom -> top by `sort_order`. Seeds the four
     * defaults when the course has none yet (and exists) — a course that has
     * had its table emptied on purpose gets them back on the next list, which
     * is the accepted cost of not carrying a per-course "seeded" flag: an
     * empty legend is never a useful state, since every zone needs a type.
     */
    async listByCourse(courseId: string): Promise<CourseZoneType[]> {
        const rows = await this.rowsByCourse(courseId);
        if (rows.length > 0) return rows.map(toZoneType);
        const course = await this.db
            .selectFrom('courses').select('id').where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        await this.addDefaults(courseId);
        return (await this.rowsByCourse(courseId)).map(toZoneType);
    }

    private rowsByCourse(courseId: string) {
        return this.zoneTypes()
            .where('course_id', '=', courseId)
            .orderBy('sort_order')
            .orderBy('key')
            .execute();
    }

    async get(id: string): Promise<CourseZoneType> {
        return toZoneType(await this.rowOrThrow(id));
    }

    /**
     * Inserts the defaults this course does not have yet (by key), appended
     * after its existing rows. Called by `listByCourse` on an empty table and
     * exposed so the panel can offer "add the defaults" after a purge, or to
     * pick up a default added later (`woodland_floor`). A preset whose mask
     * slot the course already uses for another type takes the first free slot.
     */
    async addDefaults(courseId: string): Promise<CourseZoneType[]> {
        const existing = await this.rowsByCourse(courseId);
        const haveKeys = new Set(existing.map((r) => r.key));
        const taken = new Set(existing.map((r) => `${r.texture_index}:${r.channel}`));
        const created: CourseZoneType[] = [];
        for (const preset of DEFAULT_ZONE_TYPES) {
            if (haveKeys.has(preset.key)) continue;
            const { textureIndex, channel, ...rest } = preset;
            const slot = taken.has(`${textureIndex}:${channel}`) ? {} : { textureIndex, channel };
            const row = await this.create({ courseId, ...rest, ...slot });
            taken.add(`${row.textureIndex}:${row.channel}`);
            created.push(row);
        }
        return created;
    }

    async create(input: {
        id?: string;
        courseId: string;
        key: string;
        name: string;
        color: string;
        textureIndex?: number;
        channel?: number;
        sortOrder?: number;
        items?: ZoneTypeItem[];
        variants?: ZoneTypeVariant[];
    }): Promise<CourseZoneType> {
        assertValidKey(input.key);
        assertValidName(input.name);
        assertValidColor(input.color);
        const items = input.items ?? [];
        assertValidItems(items);
        const variants = input.variants ?? [];
        assertValidVariants(variants);

        const siblings = await this.rowsByCourse(input.courseId);
        const { textureIndex, channel } = input.textureIndex === undefined && input.channel === undefined
            ? firstFreeSlot(siblings)
            : { textureIndex: input.textureIndex ?? 0, channel: input.channel ?? 0 };
        assertValidTextureIndex(textureIndex);
        assertValidChannel(channel);
        this.assertFree(siblings, { key: input.key, textureIndex, channel });

        const id = input.id ?? crypto.randomUUID();
        const sortOrder = input.sortOrder ?? siblings.length;
        await this.db.insertInto('course_zone_types').values({
            id,
            course_id: input.courseId,
            key: input.key,
            name: input.name,
            color: input.color,
            texture_index: textureIndex,
            channel,
            sort_order: sortOrder,
            items_json: JSON.stringify(normalizeItems(items)),
            variants_json: JSON.stringify(normalizeVariants(variants)),
        }).execute();
        return this.get(id);
    }

    async update(
        id: string,
        patch: {
            key?: string;
            name?: string;
            color?: string;
            textureIndex?: number;
            channel?: number;
            items?: ZoneTypeItem[];
            variants?: ZoneTypeVariant[];
        },
    ): Promise<CourseZoneType> {
        const row = await this.rowOrThrow(id);

        if (patch.key !== undefined) assertValidKey(patch.key);
        if (patch.name !== undefined) assertValidName(patch.name);
        if (patch.color !== undefined) assertValidColor(patch.color);
        if (patch.textureIndex !== undefined) assertValidTextureIndex(patch.textureIndex);
        if (patch.channel !== undefined) assertValidChannel(patch.channel);
        if (patch.items !== undefined) assertValidItems(patch.items);
        if (patch.variants !== undefined) assertValidVariants(patch.variants);

        const siblings = (await this.rowsByCourse(row.course_id)).filter((r) => r.id !== id);
        this.assertFree(siblings, {
            key: patch.key ?? row.key,
            textureIndex: patch.textureIndex ?? row.texture_index,
            channel: patch.channel ?? row.channel,
        });

        const dbInput: Record<string, unknown> = {};
        if (patch.key !== undefined) dbInput.key = patch.key;
        if (patch.name !== undefined) dbInput.name = patch.name;
        if (patch.color !== undefined) dbInput.color = patch.color;
        if (patch.textureIndex !== undefined) dbInput.texture_index = patch.textureIndex;
        if (patch.channel !== undefined) dbInput.channel = patch.channel;
        if (patch.items !== undefined) dbInput.items_json = JSON.stringify(normalizeItems(patch.items));
        if (patch.variants !== undefined) dbInput.variants_json = JSON.stringify(normalizeVariants(patch.variants));

        await this.db.updateTable('course_zone_types').where('id', '=', id).set({
            ...dbInput,
            updated_at: sql`(datetime('now'))`,
        }).execute();
        return this.get(id);
    }

    /**
     * Deletes one zone type. Features naming it keep their `zoneType`
     * attribute — the string is the binding, and a zone whose type is gone is
     * simply not rasterized until it is pointed at a live type. Deliberately
     * not a cascade: dropping the drawn polygons because their legend row went
     * would lose authoring work.
     */
    async remove(id: string): Promise<void> {
        await this.rowOrThrow(id);
        await this.db.deleteFrom('course_zone_types').where('id', '=', id).execute();
    }

    /**
     * Rewrites the course's table order in one shot (house pattern — see
     * CourseFeaturesService.reorder). `orderedIds` must be exactly the
     * course's current zone types.
     */
    async reorder(courseId: string, orderedIds: string[]): Promise<CourseZoneType[]> {
        await this.db.transaction().execute(async (trx) => {
            const existing = await trx.selectFrom('course_zone_types')
                .select('id').where('course_id', '=', courseId).execute();
            const existingIds = new Set(existing.map((r) => r.id));
            const sameSize = existingIds.size === new Set(orderedIds).size;
            if (!sameSize || !orderedIds.every((id) => existingIds.has(id))) {
                throw new ConflictError(`orderedIds must exactly match the zone types of course ${courseId}`);
            }
            for (let i = 0; i < orderedIds.length; i++) {
                await trx.updateTable('course_zone_types')
                    .where('id', '=', orderedIds[i])
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .execute();
            }
        });
        return (await this.rowsByCourse(courseId)).map(toZoneType);
    }

    /** Key and mask channel are both unique within a course. */
    private assertFree(
        siblings: readonly ZoneTypeRow[],
        candidate: { key: string; textureIndex: number; channel: number },
    ): void {
        if (siblings.some((r) => r.key === candidate.key)) {
            throw new ConflictError(`Zone type key '${candidate.key}' is already used by this course`);
        }
        if (siblings.some((r) => r.texture_index === candidate.textureIndex && r.channel === candidate.channel)) {
            throw new ConflictError(
                `Texture ${candidate.textureIndex} channel ${candidate.channel} is already used by this course`,
            );
        }
    }
}

/**
 * Lowest free (texture, channel) slot for a course: fill a texture's four
 * channels before opening the next texture, which is what the rasterizer
 * wants (one PNG per four zone types).
 */
function firstFreeSlot(siblings: readonly ZoneTypeRow[]): { textureIndex: number; channel: number } {
    const taken = new Set(siblings.map((r) => `${r.texture_index}:${r.channel}`));
    for (let textureIndex = 0; ; textureIndex++) {
        for (let channel = 0; channel < CHANNELS_PER_TEXTURE; channel++) {
            if (!taken.has(`${textureIndex}:${channel}`)) return { textureIndex, channel };
        }
    }
}
