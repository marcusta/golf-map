// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Photo {
    id: string;
    siteId: string;
    courseId: null | string;
    hole: null | number;
    capturedAt: string;
    lat: number;
    lon: number;
    hAccM: number;
    gpsAltM: null | number;
    vAccM: null | number;
    x3006: number;
    y3006: number;
    attitudeQuat: null | AttitudeQuat;
    yawDeg: number;
    pitchDeg: number;
    rollDeg: number;
    headingAccDeg: null | number;
    magCalibration: null | number;
    hfovDeg: number;
    vfovDeg: number;
    width: number;
    height: number;
    eyeHeightM: number;
    deviceModel: null | string;
    lens: string;
    tags: string[];
    note: null | string;
    originalSha256: null | string;
    originalBytes: null | number;
    originalUploadedAt: null | string;
    originalDeletedAt: null | string;
    previewSha256: null | string;
    previewBytes: null | number;
    previewUploadedAt: null | string;
    pulledAt: null | string;
    refinedYawDeg: null | number;
    refinedPitchDeg: null | number;
    refinedRollDeg: null | number;
    refineMethod: null | 'skyline' | 'manual';
    refineResidualDeg: null | number;
    refinedAt: null | string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface AttitudeQuat {
    w: number;
    x: number;
    y: number;
    z: number;
}

export interface PhotosApi {
    create(input: { courseId?: null | string; hole?: null | number; gpsAltM?: null | number; vAccM?: null | number; attitudeQuat?: null | { x: number; y: number; w: number; z: number }; headingAccDeg?: null | number; magCalibration?: null | number; eyeHeightM?: number; deviceModel?: null | string; lens?: string; tags?: string[]; note?: null | string; id: string; capturedAt: string; siteId: string; lat: number; lon: number; hAccM: number; yawDeg: number; pitchDeg: number; rollDeg: number; hfovDeg: number; vfovDeg: number; width: number; height: number }): Promise<Photo>;
    list(input: { siteId: string }): Promise<Photo[]>;
    get(input: { id: string }): Promise<Photo>;
    update(input: { hole?: null | number; tags?: string[]; note?: null | string; id: string; version: number }): Promise<Photo>;
    remove(input: { id: string; version: number }): Promise<{ ok: boolean }>;
}

export function createPhotosClient(baseUrl: string): PhotosApi {
    return {
        async create(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photos/create`, body: input });
        },
        async list(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/photos/list${qs ? '?' + qs : ''}` });
        },
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/photos/get${qs ? '?' + qs : ''}` });
        },
        async update(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photos/update`, body: input });
        },
        async remove(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/photos/remove`, body: input });
        },
    };
}
