// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface HydroFetchResult {
    bbox: HydroBbox;
    source: string;
    attribution: string;
    suggestedCreekWidthM: number;
    water: HydroWaterPolygon[];
    creeks: HydroCreekLine[];
}

export interface HydroBbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface HydroWaterPolygon {
    sourceRef: null | string;
    rings: number[][][];
}

export interface HydroCreekLine {
    sourceRef: null | string;
    points: number[][];
}

export interface HydroApi {
    fetchHydro(input: { courseId: string }): Promise<HydroFetchResult>;
}

export function createHydroClient(baseUrl: string): HydroApi {
    return {
        async fetchHydro(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/course-features/fetch-hydro`, body: input });
        },
    };
}
