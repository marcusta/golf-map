// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GsproExportSettings {
    dir: string;
    courseDir: null | string;
    gkdFile: null | string;
    meta: null | { courseName: string; city: string; state: string; country: string; designer: string; homage: string; description: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] };
    gkdMeta: null | { courseName: string; city: string; state: string; country: string; designer: string; homage: string; description: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] };
    gkdRatings: string[];
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
    cleaned: boolean;
    active: boolean;
}

export interface GsproExportJob {
    id: string;
    courseId: string;
    kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'unity-ortho' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'arborist' | 'creeks' | 'gkd';
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
    setCourseDir(input: { courseId: string; dir: null | string }): Promise<GsproExportSettings>;
    setMeta(input: { courseId: string; meta: null | { description: string; courseName: string; city: string; state: string; country: string; designer: string; homage: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] } }): Promise<GsproExportSettings>;
    readGkdMeta(input: { courseId: string }): Promise<GsproExportSettings>;
    readGkdRatings(input: { courseId: string }): Promise<GsproExportSettings>;
    terrain(input: { courseId: string }): Promise<CourseTerrain>;
    orthoSources(input: { courseId: string }): Promise<GsproOrthoSource[]>;
    start(input: { source?: string; collection?: string; terrain?: 'inner' | 'outer'; darken?: number; tint?: boolean; tintOpacity?: number; forestFloor?: boolean; floorColor?: string; floorMix?: number; removeBuildings?: boolean; excludeFeatureIds?: string[]; variant?: string; zoneIds?: string[]; courseId: string; kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'unity-ortho' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'arborist' | 'creeks' | 'gkd' }): Promise<GsproExportJob>;
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
        async setCourseDir(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/course-dir`, body: input });
        },
        async setMeta(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/meta`, body: input });
        },
        async readGkdMeta(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/meta/read-gkd`, body: input });
        },
        async readGkdRatings(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/ratings/read-gkd`, body: input });
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
