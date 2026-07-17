import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { GamePlansService } from '../services/game-plans.service';

// --- Input schemas ---

const GetGamePlanInput = Type.Object({
    courseId: Type.String(),
    userId: Type.Optional(Type.String()),
});

const UpsertGamePlanInput = Type.Object({
    courseId: Type.String(),
    userId: Type.Optional(Type.String()),
    version: Type.Optional(Type.Number()),
    windSpeedMps: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    windDirectionDeg: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

const RemoveGamePlanInput = Type.Object({
    courseId: Type.String(),
    userId: Type.Optional(Type.String()),
    version: Type.Number(),
});

const SetHoleInput = Type.Object({
    planId: Type.String(),
    holeNumber: Type.Number(),
    version: Type.Optional(Type.Number()),
    teeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    preferredClubId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    plannedDirectionDeg: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    windSpeedMps: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    windDirectionDeg: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const AddShotInput = Type.Object({
    gamePlanHoleId: Type.String(),
    parentShotId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    lat: Type.Number(),
    lon: Type.Number(),
    elevation: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    clubId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const UpdateShotInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    clubId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const RemoveShotInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    mode: Type.Optional(Type.Union([Type.Literal('splice'), Type.Literal('cascade')])),
});

const ReorderShotsInput = Type.Object({
    gamePlanHoleId: Type.String(),
    orderedIds: Type.Array(Type.String()),
});

const SetPrimaryInput = Type.Object({
    id: Type.String(),
});

const GateSourceSchema = Type.Union([Type.Literal('manual'), Type.Literal('computed')]);

const AddGateInput = Type.Object({
    gamePlanHoleId: Type.String(),
    lat: Type.Number(),
    lon: Type.Number(),
    directionDeg: Type.Number(),
    halfWidthLeftM: Type.Number(),
    halfWidthRightM: Type.Number(),
    source: Type.Optional(GateSourceSchema),
});

const UpdateGateInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    directionDeg: Type.Optional(Type.Number()),
    halfWidthLeftM: Type.Optional(Type.Number()),
    halfWidthRightM: Type.Optional(Type.Number()),
    source: Type.Optional(GateSourceSchema),
});

const RemoveGateInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createGamePlansApi(svc: GamePlansService) {
    const mw = [requireAuth()];
    return {
        getByCourse:  { method: 'GET'  as const, path: '/game-plans/by-course',        fn: (input: Static<typeof GetGamePlanInput>)    => svc.getByCourse(input.courseId, input.userId),                                                                                     schema: GetGamePlanInput,    middleware: mw },
        upsert:       { method: 'POST' as const, path: '/game-plans/upsert',           fn: (input: Static<typeof UpsertGamePlanInput>) => svc.upsertByCourse(input.courseId, { userId: input.userId, version: input.version, windSpeedMps: input.windSpeedMps, windDirectionDeg: input.windDirectionDeg }), schema: UpsertGamePlanInput, middleware: mw },
        remove:       { method: 'POST' as const, path: '/game-plans/remove',           fn: (input: Static<typeof RemoveGamePlanInput>) => svc.removeByCourse(input.courseId, input.version, input.userId),                                                                    schema: RemoveGamePlanInput, middleware: mw },
        setHole:      { method: 'POST' as const, path: '/game-plans/set-hole',         fn: (input: Static<typeof SetHoleInput>)        => svc.setHole(input.planId, input.holeNumber, { version: input.version, teeId: input.teeId, preferredClubId: input.preferredClubId, plannedDirectionDeg: input.plannedDirectionDeg, windSpeedMps: input.windSpeedMps, windDirectionDeg: input.windDirectionDeg, notes: input.notes }), schema: SetHoleInput, middleware: mw },
        addShot:      { method: 'POST' as const, path: '/game-plans/shots/add',        fn: (input: Static<typeof AddShotInput>)        => svc.addShot(input.gamePlanHoleId, { parentShotId: input.parentShotId, lat: input.lat, lon: input.lon, elevation: input.elevation, clubId: input.clubId, label: input.label }), schema: AddShotInput, middleware: mw },
        updateShot:   { method: 'POST' as const, path: '/game-plans/shots/update',     fn: (input: Static<typeof UpdateShotInput>)     => svc.updateShot(input.id, input.version, { lat: input.lat, lon: input.lon, elevation: input.elevation, clubId: input.clubId, label: input.label }),           schema: UpdateShotInput,     middleware: mw },
        removeShot:   { method: 'POST' as const, path: '/game-plans/shots/remove',     fn: (input: Static<typeof RemoveShotInput>)     => svc.removeShot(input.id, input.version, input.mode),                                                                                    schema: RemoveShotInput,     middleware: mw },
        reorderShots: { method: 'POST' as const, path: '/game-plans/shots/reorder',    fn: (input: Static<typeof ReorderShotsInput>)   => svc.reorderShots(input.gamePlanHoleId, input.orderedIds),                                                                               schema: ReorderShotsInput,   middleware: mw },
        setPrimary:   { method: 'POST' as const, path: '/game-plans/shots/set-primary', fn: (input: Static<typeof SetPrimaryInput>)     => svc.setPrimary(input.id),                                                                                                               schema: SetPrimaryInput,     middleware: mw },
        addGate:      { method: 'POST' as const, path: '/game-plans/gates/add',        fn: (input: Static<typeof AddGateInput>)        => svc.addGate(input.gamePlanHoleId, { lat: input.lat, lon: input.lon, directionDeg: input.directionDeg, halfWidthLeftM: input.halfWidthLeftM, halfWidthRightM: input.halfWidthRightM, source: input.source }), schema: AddGateInput, middleware: mw },
        updateGate:   { method: 'POST' as const, path: '/game-plans/gates/update',     fn: (input: Static<typeof UpdateGateInput>)     => svc.updateGate(input.id, input.version, { lat: input.lat, lon: input.lon, directionDeg: input.directionDeg, halfWidthLeftM: input.halfWidthLeftM, halfWidthRightM: input.halfWidthRightM, source: input.source }), schema: UpdateGateInput, middleware: mw },
        removeGate:   { method: 'POST' as const, path: '/game-plans/gates/remove',     fn: (input: Static<typeof RemoveGateInput>)     => svc.removeGate(input.id, input.version),                                                                                                schema: RemoveGateInput,     middleware: mw },
    };
}
