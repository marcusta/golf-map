import { Type, type Static } from '@sinclair/typebox';
import { requireAuth, requireUser } from '@basics/core/server/auth';
import type { Context } from 'hono';
import type { RoundsService } from '../services/rounds.service';

// --- Input schemas ---

const ListRoundsInput = Type.Object({
    courseId: Type.String(),
});

const GetRoundInput = Type.Object({
    id: Type.String(),
});

const StartRoundInput = Type.Object({
    courseId: Type.String(),
    startedAt: Type.Optional(Type.String()),
});

const EndRoundInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    endedAt: Type.String(),
    notes: Type.Optional(Type.String()),
});

const RemoveRoundInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const AddShotInput = Type.Object({
    roundId: Type.String(),
    holeNumber: Type.Number(),
    lat: Type.Number(),
    lon: Type.Number(),
    clubId: Type.Optional(Type.String()),
    lie: Type.Optional(Type.String()),
    recordedAt: Type.Optional(Type.String()),
});

const UpdateShotInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    holeNumber: Type.Optional(Type.Number()),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    clubId: Type.Optional(Type.String()),
    lie: Type.Optional(Type.String()),
    recordedAt: Type.Optional(Type.String()),
});

const RemoveShotInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createRoundsApi(svc: RoundsService) {
    const mw = [requireAuth()];
    return {
        listByCourse: {
            method: 'GET' as const,
            path: '/rounds/by-course',
            fn: (input: Static<typeof ListRoundsInput>) => svc.listByCourse(input.courseId),
            schema: ListRoundsInput,
            middleware: mw,
        },
        get: {
            method: 'GET' as const,
            path: '/rounds/get',
            fn: (input: Static<typeof GetRoundInput>) => svc.get(input.id),
            schema: GetRoundInput,
            middleware: mw,
        },
        start: {
            method: 'POST' as const,
            path: '/rounds/start',
            fn: (input: Static<typeof StartRoundInput>, c: Context) =>
                svc.start(input.courseId, requireUser(c).id, input.startedAt),
            schema: StartRoundInput,
            middleware: mw,
        },
        end: {
            method: 'POST' as const,
            path: '/rounds/end',
            fn: (input: Static<typeof EndRoundInput>) => svc.end(input.id, input.version, input.endedAt, input.notes),
            schema: EndRoundInput,
            middleware: mw,
        },
        remove: {
            method: 'POST' as const,
            path: '/rounds/remove',
            fn: (input: Static<typeof RemoveRoundInput>) => svc.remove(input.id, input.version),
            schema: RemoveRoundInput,
            middleware: mw,
        },
        addShot: {
            method: 'POST' as const,
            path: '/rounds/shots/add',
            fn: (input: Static<typeof AddShotInput>) => svc.addShot(input.roundId, {
                holeNumber: input.holeNumber,
                lat: input.lat,
                lon: input.lon,
                clubId: input.clubId,
                lie: input.lie,
                recordedAt: input.recordedAt,
            }),
            schema: AddShotInput,
            middleware: mw,
        },
        updateShot: {
            method: 'POST' as const,
            path: '/rounds/shots/update',
            fn: (input: Static<typeof UpdateShotInput>) => svc.updateShot(input.id, input.version, {
                holeNumber: input.holeNumber,
                lat: input.lat,
                lon: input.lon,
                clubId: input.clubId,
                lie: input.lie,
                recordedAt: input.recordedAt,
            }),
            schema: UpdateShotInput,
            middleware: mw,
        },
        removeShot: {
            method: 'POST' as const,
            path: '/rounds/shots/remove',
            fn: (input: Static<typeof RemoveShotInput>) => svc.removeShot(input.id, input.version),
            schema: RemoveShotInput,
            middleware: mw,
        },
    };
}
