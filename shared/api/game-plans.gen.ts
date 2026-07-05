// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GamePlan {
    id: string;
    courseId: string;
    userId: null | string;
    windSpeedMps: null | number;
    windDirectionDeg: null | number;
    holes: GamePlanHole[];
    version: number;
}

export interface GamePlanHole {
    id: string;
    gamePlanId: string;
    holeNumber: number;
    teeId: null | string;
    preferredClubId: null | string;
    plannedDirectionDeg: null | number;
    windSpeedMps: null | number;
    windDirectionDeg: null | number;
    notes: null | string;
    shots: PlanShot[];
    gates: PlanGate[];
    version: number;
}

export interface PlanShot {
    id: string;
    gamePlanHoleId: string;
    sortOrder: number;
    lat: number;
    lon: number;
    elevation: null | number;
    clubId: null | string;
    label: null | string;
    version: number;
}

export interface PlanGate {
    id: string;
    gamePlanHoleId: string;
    lat: number;
    lon: number;
    directionDeg: number;
    halfWidthLeftM: number;
    halfWidthRightM: number;
    source: 'manual' | 'computed';
    sortOrder: number;
    version: number;
}

export interface GamePlansApi {
    getByCourse(input: { userId?: string; courseId: string }): Promise<null | GamePlan>;
    upsert(input: { userId?: string; version?: number; windSpeedMps?: null | number; windDirectionDeg?: null | number; courseId: string }): Promise<GamePlan>;
    remove(input: { userId?: string; courseId: string; version: number }): Promise<{ ok: boolean }>;
    setHole(input: { version?: number; notes?: null | string; windSpeedMps?: null | number; windDirectionDeg?: null | number; teeId?: null | string; preferredClubId?: null | string; plannedDirectionDeg?: null | number; planId: string; holeNumber: number }): Promise<GamePlanHole>;
    addShot(input: { elevation?: null | number; clubId?: null | string; label?: null | string; lat: number; lon: number; gamePlanHoleId: string }): Promise<PlanShot>;
    updateShot(input: { lat?: number; lon?: number; elevation?: null | number; clubId?: null | string; label?: null | string; id: string; version: number }): Promise<PlanShot>;
    removeShot(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    reorderShots(input: { orderedIds: string[]; gamePlanHoleId: string }): Promise<{ ok: boolean }>;
    addGate(input: { source?: 'manual' | 'computed'; lat: number; lon: number; gamePlanHoleId: string; directionDeg: number; halfWidthLeftM: number; halfWidthRightM: number }): Promise<PlanGate>;
    updateGate(input: { lat?: number; lon?: number; directionDeg?: number; halfWidthLeftM?: number; halfWidthRightM?: number; source?: 'manual' | 'computed'; id: string; version: number }): Promise<PlanGate>;
    removeGate(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createGamePlansClient(baseUrl: string): GamePlansApi {
    return {
        async getByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/game-plans/by-course${qs ? '?' + qs : ''}` });
        },
        async upsert(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/upsert`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/remove`, body: input });
        },
        async setHole(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/set-hole`, body: input });
        },
        async addShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/shots/add`, body: input });
        },
        async updateShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/shots/update`, body: input });
        },
        async removeShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/shots/remove`, body: input });
        },
        async reorderShots(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/shots/reorder`, body: input });
        },
        async addGate(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/gates/add`, body: input });
        },
        async updateGate(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/gates/update`, body: input });
        },
        async removeGate(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/game-plans/gates/remove`, body: input });
        },
    };
}
