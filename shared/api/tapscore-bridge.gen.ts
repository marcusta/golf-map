// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface TapscoreLinkStatus {
    roundId: string;
    linked: boolean;
    token: null | string;
    ballId: null | string;
}

export interface TapscoreBridgeApi {
    status(input: { roundId: string }): Promise<TapscoreLinkStatus>;
    link(input: { ballId?: string; roundId: string; token: string }): Promise<TapscoreLinkStatus>;
    unlink(input: { roundId: string }): Promise<TapscoreLinkStatus>;
}

export function createTapscoreBridgeClient(baseUrl: string): TapscoreBridgeApi {
    return {
        async status(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/rounds/tapscore-link${qs ? '?' + qs : ''}` });
        },
        async link(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/tapscore-link`, body: input });
        },
        async unlink(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/rounds/tapscore-unlink`, body: input });
        },
    };
}
