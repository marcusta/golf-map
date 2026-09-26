import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { ZoneTypesService } from '../services/zone-types.service';

// --- Input schemas ---
//
// The shapes are pinned here as well as asserted in the service: `mount()` maps
// a schema miss to a 400 with the offending path, while a service error it does
// not know is a 500 — and these are fields a person types.

/** One VSPro vegetation item bound to the zone type (D-VZ9). */
const ItemSchema = Type.Object({
    item: Type.String({ minLength: 1 }),
    minDensity: Type.Number({ minimum: 0, maximum: 1 }),
    maxDensity: Type.Number({ minimum: 0, maximum: 1 }),
});

/** Zone-type key: a lowercase identifier, unique within the course. */
const KeySchema = Type.String({ pattern: '^[a-z0-9_]+$' });
const NameSchema = Type.String({ minLength: 1 });
const ColorSchema = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
/** Mask texture index and its RGBA channel (four zone types per texture). */
const TextureIndexSchema = Type.Integer({ minimum: 0 });
const ChannelSchema = Type.Integer({ minimum: 0, maximum: 3 });
const ItemsSchema = Type.Array(ItemSchema);
/**
 * Named alternative item mixes (e.g. Tall rough -> "Dry straw"); a zone picks
 * one by `key` in its `zoneVariant` attribute. The service also rejects keys
 * repeated within one type.
 */
const VariantSchema = Type.Object({
    key: KeySchema,
    name: NameSchema,
    items: ItemsSchema,
});
const VariantsSchema = Type.Array(VariantSchema);

const ListZoneTypesInput = Type.Object({
    courseId: Type.String(),
});

const AddDefaultZoneTypesInput = Type.Object({
    courseId: Type.String(),
});

const CreateZoneTypeInput = Type.Object({
    courseId: Type.String(),
    key: KeySchema,
    name: NameSchema,
    color: ColorSchema,
    // Omit both to take the course's lowest free mask slot.
    textureIndex: Type.Optional(TextureIndexSchema),
    channel: Type.Optional(ChannelSchema),
    items: Type.Optional(ItemsSchema),
    variants: Type.Optional(VariantsSchema),
});

const UpdateZoneTypeInput = Type.Object({
    id: Type.String(),
    key: Type.Optional(KeySchema),
    name: Type.Optional(NameSchema),
    color: Type.Optional(ColorSchema),
    textureIndex: Type.Optional(TextureIndexSchema),
    channel: Type.Optional(ChannelSchema),
    items: Type.Optional(ItemsSchema),
    variants: Type.Optional(VariantsSchema),
});

const RemoveZoneTypeInput = Type.Object({
    id: Type.String(),
});

const ReorderZoneTypesInput = Type.Object({
    courseId: Type.String(),
    orderedIds: Type.Array(Type.String()),
});

// --- API descriptor ---

export function createZoneTypesApi(svc: ZoneTypesService) {
    const mw = [requireAuth()];
    return {
        list:        { method: 'GET'  as const, path: '/zone-types',              fn: (input: Static<typeof ListZoneTypesInput>)       => svc.listByCourse(input.courseId),                                     schema: ListZoneTypesInput,       middleware: mw },
        addDefaults: { method: 'POST' as const, path: '/zone-types/add-defaults', fn: (input: Static<typeof AddDefaultZoneTypesInput>) => svc.addDefaults(input.courseId),                                     schema: AddDefaultZoneTypesInput, middleware: mw },
        create:      { method: 'POST' as const, path: '/zone-types/create',       fn: (input: Static<typeof CreateZoneTypeInput>)      => svc.create(input),                                                   schema: CreateZoneTypeInput,      middleware: mw },
        update:      { method: 'POST' as const, path: '/zone-types/update',       fn: (input: Static<typeof UpdateZoneTypeInput>)      => svc.update(input.id, input),                                          schema: UpdateZoneTypeInput,      middleware: mw },
        remove:      { method: 'POST' as const, path: '/zone-types/remove',       fn: (input: Static<typeof RemoveZoneTypeInput>)      => svc.remove(input.id),                                                 schema: RemoveZoneTypeInput,      middleware: mw },
        reorder:     { method: 'POST' as const, path: '/zone-types/reorder',      fn: (input: Static<typeof ReorderZoneTypesInput>)    => svc.reorder(input.courseId, input.orderedIds),                        schema: ReorderZoneTypesInput,    middleware: mw },
    };
}
