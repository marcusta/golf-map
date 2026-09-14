// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GsproExportSettings {
    dir: string;
    isDefault: boolean;
    defaultDir: string;
}

export interface CourseTerrain {
    inner: TerrainSquare;
    outer: TerrainSquare;
}

export interface GsproOrthoSource {
    source: string;
    collection: string;
    patched: boolean;
    active: boolean;
}

export interface GsproExportJob {
    id: string;
    courseId: string;
    kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'hillshade' | 'trees';
    label: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: null | string;
    result: null | GsproExportResult;
    error: null | string;
}

export interface TerrainSquare {
    square: SquareBox;
    sideM: number;
    centre: { x: number; y: number };
    wgs84: BboxWgs84;
}

export interface GsproExportResult {
    path: string;
    report: string[];
}

export interface SquareBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface BboxWgs84 {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface GsproExportApi {
    settings(input: { courseId: string }): Promise<GsproExportSettings>;
    setDir(input: { courseId: string; dir: null | string }): Promise<GsproExportSettings>;
    terrain(input: { courseId: string }): Promise<CourseTerrain>;
    orthoSources(input: { courseId: string }): Promise<GsproOrthoSource[]>;
    start(input: { source?: string; collection?: string; terrain?: 'inner' | 'outer'; darken?: number; courseId: string; kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'hillshade' | 'trees' }): Promise<GsproExportJob>;
    job(input: { jobId: string }): Promise<GsproExportJob>;
    current(input: { courseId: string }): Promise<null | GsproExportJob>;
}

export function createGsproExportClient(baseUrl: string): GsproExportApi {
    return {
        async settings(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-export/settings${qs ? '?' + qs : ''}` });
        },
        async setDir(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/dir`, body: input });
        },
        async terrain(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-export/terrain${qs ? '?' + qs : ''}` });
        },
        async orthoSources(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-export/ortho-sources${qs ? '?' + qs : ''}` });
        },
        async start(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/start`, body: input });
        },
        async job(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-export/job${qs ? '?' + qs : ''}` });
        },
        async current(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/gspro-export/current${qs ? '?' + qs : ''}` });
        },
    };
}
