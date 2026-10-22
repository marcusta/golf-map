// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface GsproExportSettings {
    dir: string;
    courseDir: null | string;
    gkdFile: null | string;
    meta: null | { courseName: string; city: string; state: string; country: string; designer: string; homage: string; description: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] };
    gkdMeta: null | { courseName: string; city: string; state: string; country: string; designer: string; homage: string; description: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] };
    opcdCourseName: null | string;
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
    kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'unity-ortho' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'arborist' | 'creeks' | 'ramroads' | 'waterfalls' | 'gkd';
    label: string;
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    finishedAt: null | string;
    result: null | GsproExportResult;
    error: null | string;
}

export interface SvgCheckReport {
    courseId: string;
    checkedAt: string;
    errors: number;
    warnings: number;
    notes: number;
    accepted: number;
    findings: SvgCheckFinding[];
}

export interface RamRoadsProposal {
    format: string;
    course: { id: string; name: string };
    rules: Record<string, unknown>;
    candidates: RamRoadCandidate[];
    already: (string | number)[];
    rejected: ({ featureNo: null | number; featureId: string; reason: string })[];
}

export interface RoadRenderResult {
    render: 'ram' | 'opcd';
    changed: string[];
    unchanged: string[];
    dryRun: boolean;
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
    needsPlanting?: boolean;
    reason?: string;
}

export interface SvgCheckFinding {
    key: string;
    code: string;
    severity: 'note' | 'error' | 'warning';
    accepted: boolean;
    message: string;
    shapes: SvgCheckShape[];
    at: null | [number, number];
    geometry: null | { type: string; coordinates: unknown };
}

export interface RamRoadCandidate {
    featureId: string;
    featureNo: null | number;
    surface: string;
    widthM: number;
    lengthM: number;
    distanceToPlayM: null | number;
    touches: (string | number)[];
    reason: string;
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

export interface SvgCheckShape {
    name: string;
    type: string;
    featureIds: string[];
}

export interface GsproExportApi {
    settings(input: { courseId: string }): Promise<GsproExportSettings>;
    setDir(input: { courseId: string; dir: null | string }): Promise<GsproExportSettings>;
    setCourseDir(input: { courseId: string; dir: null | string }): Promise<GsproExportSettings>;
    setOpcdCourseName(input: { courseId: string; name: null | string }): Promise<GsproExportSettings>;
    setMeta(input: { courseId: string; meta: null | { description: string; courseName: string; city: string; state: string; country: string; designer: string; homage: string; difficulty: number; keywords: ('BeginnerFriendly' | 'Coastal' | 'Desert' | 'Fantasy' | 'Heathland' | 'Historic' | 'Links' | 'LowPoly' | 'MajorVenue' | 'Mountain' | 'Parkland' | 'TourStop' | 'Training' | 'Tropical')[] } }): Promise<GsproExportSettings>;
    readGkdMeta(input: { courseId: string }): Promise<GsproExportSettings>;
    readGkdRatings(input: { courseId: string }): Promise<GsproExportSettings>;
    terrain(input: { courseId: string }): Promise<CourseTerrain>;
    orthoSources(input: { courseId: string }): Promise<GsproOrthoSource[]>;
    start(input: { force?: boolean; source?: string; collection?: string; terrain?: 'inner' | 'outer'; darken?: number; tint?: boolean; tintOpacity?: number; forestFloor?: boolean; floorColor?: string; floorMix?: number; removeBuildings?: boolean; excludeFeatureIds?: string[]; variant?: string; zoneIds?: string[]; plantIfNeeded?: boolean; courseId: string; kind: 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'unity-ortho' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'arborist' | 'creeks' | 'ramroads' | 'waterfalls' | 'gkd' }): Promise<GsproExportJob>;
    job(input: { jobId: string }): Promise<GsproExportJob>;
    current(input: { courseId: string }): Promise<null | GsproExportJob>;
    svgCheck(input: { courseId: string }): Promise<SvgCheckReport>;
    acceptSvgFinding(input: { note?: string; courseId: string; key: string; accepted: boolean }): Promise<{ file: string; keys: string[] }>;
    ramRoadsProposal(input: { minDistanceM?: number; courseId: string }): Promise<RamRoadsProposal>;
    setRoadRender(input: { dryRun?: boolean; courseId: string; featureIds: string[]; render: 'ram' | 'opcd' }): Promise<RoadRenderResult>;
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
        async setOpcdCourseName(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/opcd-course-name`, body: input });
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
        async svgCheck(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/svg-check`, body: input });
        },
        async acceptSvgFinding(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/gspro-export/svg-check/accept`, body: input });
        },
        async ramRoadsProposal(input) {
            const pathParams = new Set(['courseId']);
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k) && v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/courses/${input.courseId}/gspro/ram-roads/proposal${qs ? '?' + qs : ''}` });
        },
        async setRoadRender(input) {
            const pathParams = new Set(['courseId']);
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input as any))
                if (!pathParams.has(k)) body[k] = v;
            return apiFetch({ method: 'POST', url: `${baseUrl}/courses/${input.courseId}/gspro/ram-roads/render`, body });
        },
    };
}
