import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TeeSetsService } from '../services/tee-sets.service';
import { GKD_TEE_TYPES } from '../../shared/tee-sets';

// --- Input schemas ---

const ListByCourseInput = Type.Object({
    courseId: Type.String(),
});

const CreateTeeSetInput = Type.Object({
    courseId: Type.String(),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const Rating = Type.Union([Type.Number({ minimum: 40, maximum: 90 }), Type.Null()]);
const Slope = Type.Union([Type.Integer({ minimum: 55, maximum: 155 }), Type.Null()]);

/** Fields left out stay as they are; a rating or slope of null clears it. */
const UpdateTeeSetInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ratingMen: Type.Optional(Rating),
    slopeMen: Type.Optional(Slope),
    ratingWomen: Type.Optional(Rating),
    slopeWomen: Type.Optional(Slope),
    gsproRating: Type.Optional(Type.Union([Type.Literal('men'), Type.Literal('women')])),
    /** The GreenKeeper tee type the set is exported as (null = not in GSPro); it moves from the set that had it. */
    gsproTee: Type.Optional(Type.Union([...GKD_TEE_TYPES.map(t => Type.Literal(t)), Type.Null()])),
    /** The set exists for GSPro alone and stays out of the course guide. */
    gsproOnly: Type.Optional(Type.Boolean()),
});

const RemoveTeeSetInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

/** A course's tee sets: name, colour, men's and women's course rating and slope. */
export function createTeeSetsApi(svc: TeeSetsService) {
    const mw = [requireAuth()];
    return {
        listByCourse: {
            method: 'GET' as const,
            path: '/tee-sets/by-course',
            fn: (input: Static<typeof ListByCourseInput>) => svc.listByCourse(input.courseId),
            schema: ListByCourseInput,
            middleware: mw,
        },
        create: {
            method: 'POST' as const,
            path: '/tee-sets/create',
            fn: (input: Static<typeof CreateTeeSetInput>) => svc.create(input),
            schema: CreateTeeSetInput,
            middleware: mw,
        },
        /** A new name or colour goes onto every tee of the set. */
        update: {
            method: 'POST' as const,
            path: '/tee-sets/update',
            fn: ({ id, version, ...patch }: Static<typeof UpdateTeeSetInput>) => svc.update(id, version, patch),
            schema: UpdateTeeSetInput,
            middleware: mw,
        },
        /** 409 while hole tees still belong to the set. */
        remove: {
            method: 'POST' as const,
            path: '/tee-sets/remove',
            fn: (input: Static<typeof RemoveTeeSetInput>) => svc.remove(input.id, input.version),
            schema: RemoveTeeSetInput,
            middleware: mw,
        },
    };
}
