import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { PinsService } from '../services/pins.service';

// --- Input schemas ---

const ListByGreenInput = Type.Object({
    greenId: Type.String(),
});

const ListByCourseInput = Type.Object({
    courseId: Type.String(),
});

const CreatePinInput = Type.Object({
    greenId: Type.String(),
    name: Type.String(),
    lat: Type.Number(),
    lon: Type.Number(),
    difficulty: Type.Optional(Type.String()),
});

const UpdatePinInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String()),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    difficulty: Type.Optional(Type.String()),
});

const RemovePinInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const SetActivePinInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createPinsApi(svc: PinsService) {
    const mw = [requireAuth()];
    return {
        listByGreen:  { method: 'GET'  as const, path: '/pins',              fn: (input: Static<typeof ListByGreenInput>)  => svc.listByGreen(input.greenId),                                                                       schema: ListByGreenInput,  middleware: mw },
        listByCourse: { method: 'GET'  as const, path: '/pins/by-course',    fn: (input: Static<typeof ListByCourseInput>) => svc.listByCourse(input.courseId),                                                                     schema: ListByCourseInput, middleware: mw },
        create:       { method: 'POST' as const, path: '/pins/create',       fn: (input: Static<typeof CreatePinInput>)    => svc.create(input),                                                                                     schema: CreatePinInput,    middleware: mw },
        update:       { method: 'POST' as const, path: '/pins/update',       fn: (input: Static<typeof UpdatePinInput>)    => svc.update(input.id, input.version, { name: input.name, lat: input.lat, lon: input.lon, difficulty: input.difficulty }), schema: UpdatePinInput, middleware: mw },
        remove:       { method: 'POST' as const, path: '/pins/remove',       fn: (input: Static<typeof RemovePinInput>)    => svc.remove(input.id, input.version),                                                                   schema: RemovePinInput,    middleware: mw },
        setActive:    { method: 'POST' as const, path: '/pins/set-active',   fn: (input: Static<typeof SetActivePinInput>) => svc.setActive(input.id, input.version),                                                               schema: SetActivePinInput, middleware: mw },
    };
}
