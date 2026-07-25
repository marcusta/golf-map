// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Round {
    id: string;
    courseId: string;
    userId: null | string;
    startedAt: string;
    endedAt: null | string;
    notes: null | string;
    gamePlanId: null | string;
    windSpeedMps: null | number;
    windDirectionDeg: null | number;
    stimpFt: null | number;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface RoundWithShots {
    shots: Shot[];
    id: string;
    courseId: string;
    userId: null | string;
    startedAt: string;
    endedAt: null | string;
    notes: null | string;
    gamePlanId: null | string;
    windSpeedMps: null | number;
    windDirectionDeg: null | number;
    stimpFt: null | number;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface Shot {
    id: string;
    roundId: string;
    holeNumber: number;
    sortOrder: number;
    lat: number;
    lon: number;
    clubId: null | string;
    lie: null | string;
    shotType: string;
    targetLat: null | number;
    targetLon: null | number;
    penaltyStrokes: number;
    recordedAt: string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface RoundsApi {
    listByCourse(input: { courseId: string }): Promise<Round[]>;
    get(input: { id: string }): Promise<RoundWithShots>;
    start(input: { stimpFt?: number; windSpeedMps?: number; windDirectionDeg?: number; startedAt?: string; gamePlanId?: string; courseId: string }): Promise<Round>;
    end(input: { stimpFt?: number; notes?: string; windSpeedMps?: number; windDirectionDeg?: number; gamePlanId?: string; id: string; version: number; endedAt: string }): Promise<Round>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
    addShot(input: { clubId?: string; lie?: string; shotType?: 'full' | 'partial' | 'putt' | 'recovery'; targetLat?: number; targetLon?: number; penaltyStrokes?: number; recordedAt?: string; lat: number; lon: number; holeNumber: number; roundId: string }): Promise<Shot>;
    updateShot(input: { lat?: number; lon?: number; holeNumber?: number; clubId?: string; lie?: string; shotType?: 'full' | 'partial' | 'putt' | 'recovery'; targetLat?: number; targetLon?: number; penaltyStrokes?: number; recordedAt?: string; id: string; version: number }): Promise<Shot>;
    removeShot(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createRoundsClient(baseUrl: string): RoundsApi {
    return {
        async listByCourse(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/rounds/by-course${qs ? '?' + qs : ''}` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/rounds/get${qs ? '?' + qs : ''}` });
        },
        async start(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/start`, body: input });
        },
        async end(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/end`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/remove`, body: input });
        },
        async addShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/shots/add`, body: input });
        },
        async updateShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/shots/update`, body: input });
        },
        async removeShot(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/shots/remove`, body: input });
        },
    };
}
