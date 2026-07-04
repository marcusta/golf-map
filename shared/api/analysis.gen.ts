// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface SampleGrid {
    heights: (null | number)[];
    insideMask: number[];
    origin: { e: number; n: number };
    resolution: number;
    width: number;
    height: number;
}

export interface AnalysisApi {
    sampleGrid(input: { featureId?: string; geometry?: { crs: string; rings: { points: { hIn?: { x: number; y: number }; hOut?: { x: number; y: number }; x: number; y: number }[] }[] }; bufferM?: number; resolutionM?: number; courseId: string }): Promise<SampleGrid>;
}

export function createAnalysisClient(baseUrl: string): AnalysisApi {
    return {
        async sampleGrid(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/analysis/sample-grid`, body: input });
        },
    };
}
