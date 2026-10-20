import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PaintRule, PaintService, PaintStroke } from '../services/paint.service';

// --- Input schemas ---

const CourseInput = Type.Object({
    courseId: Type.String(),
});

const Pair = Type.Tuple([Type.Number(), Type.Number()]);

/** A stroke as paint.json keeps it (the service checks it strictly; no id = the next `stroke-<n>`). */
const StrokeSchema = Type.Object({
    id: Type.Optional(Type.String({ maxLength: 80 })),
    geometry: Type.Union([Type.Literal('line'), Type.Literal('polygon'), Type.Literal('circle')]),
    points3006: Type.Optional(Type.Array(Pair, { maxItems: 2000 })),
    centre3006: Type.Optional(Pair),
    radiusM: Type.Optional(Type.Number()),
    widthM: Type.Optional(Type.Number()),
    featherM: Type.Optional(Type.Number()),
    channel: Type.Union([Type.Literal('red'), Type.Literal('green'), Type.Literal('blue'), Type.Literal('black')]),
    strength: Type.Optional(Type.Number()),
    mode: Type.Optional(Type.Union([Type.Literal('replace'), Type.Literal('overlay')])),
    surfaces: Type.Optional(Type.Array(Type.String(), { maxItems: 13 })),
    match: Type.Optional(Type.String({ maxLength: 200 })),
    enabled: Type.Optional(Type.Boolean()),
});

const ChangeFlags = {
    /** Preview only: nothing written. */
    dryRun: Type.Optional(Type.Boolean()),
    /** Afterwards the shaping apply, so Blender paints it and exports the FBX. */
    sync: Type.Optional(Type.Boolean()),
};

const StrokeInput = Type.Object({
    courseId: Type.String(),
    stroke: StrokeSchema,
    ...ChangeFlags,
});

const RuleInput = Type.Object({
    courseId: Type.String(),
    /** A paint.json rule (kinds object, road, edge); the paint engine checks the rest of its keys. */
    rule: Type.Record(Type.String(), Type.Unknown()),
    /** EPSG:3006 [minE, minN, maxE, maxN] the preview fetches meshes in (default: the whole inner square). */
    within: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),
    ...ChangeFlags,
});

const ItemInput = Type.Object({
    courseId: Type.String(),
    id: Type.String(),
    ...ChangeFlags,
});

const RemoveInput = Type.Object({
    courseId: Type.String(),
    id: Type.String(),
});

// --- API descriptor ---

/**
 * Vertex paint of the course meshes (paint.json rules and hand-paint strokes): checked, previewed in the open
 * Unity editor, saved, and painted for good by the Blender shaping step (paint.service.ts). Builder-only
 * (routes.ts): it runs the pipeline Python and the Unity bridge.
 */
export function createPaintApi(svc: PaintService) {
    const mw = [requireAuth()];
    return {
        list: {
            method: 'GET' as const,
            path: '/courses/:courseId/paint',
            fn: (input: Static<typeof CourseInput>) => svc.list(input.courseId),
            schema: CourseInput,
            middleware: mw,
        },
        /** Add a stroke or replace the one with its id. */
        stroke: {
            method: 'POST' as const,
            path: '/courses/:courseId/paint/strokes',
            fn: (input: Static<typeof StrokeInput>) => svc.stroke(input.courseId, input.stroke as PaintStroke, { dryRun: input.dryRun, sync: input.sync }),
            schema: StrokeInput,
            middleware: mw,
        },
        /** Add a rule or replace the one with its id. */
        rule: {
            method: 'POST' as const,
            path: '/courses/:courseId/paint/rules',
            fn: (input: Static<typeof RuleInput>) => svc.ruleSet(input.courseId, input.rule as PaintRule, {
                dryRun: input.dryRun, sync: input.sync, within: input.within,
            }),
            schema: RuleInput,
            middleware: mw,
        },
        /** Keep a rule (or stroke) without painting it. */
        disable: {
            method: 'POST' as const,
            path: '/courses/:courseId/paint/items/:id/disable',
            fn: (input: Static<typeof ItemInput>) => svc.ruleDisable(input.courseId, input.id, { dryRun: input.dryRun, sync: input.sync }),
            schema: ItemInput,
            middleware: mw,
        },
        /** Remove a stroke or rule. */
        remove: {
            method: 'DELETE' as const,
            path: '/courses/:courseId/paint/items/:id',
            fn: (input: Static<typeof RemoveInput>) => svc.remove(input.courseId, input.id),
            schema: RemoveInput,
            middleware: mw,
        },
    };
}
