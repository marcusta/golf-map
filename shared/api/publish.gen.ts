// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PublishState {
    status: 'idle' | 'running' | 'succeeded' | 'failed';
    step: null | 'preflight' | 'bundle' | 'pack' | 'upload';
    siteId: null | string;
    courseId: null | string;
    warnings: string[];
    bundleBytes: null | number;
    error: null | string;
    configured: boolean;
    targetUrl: null | string;
    startedAt: null | string;
    finishedAt: null | string;
}

export interface PublishApi {
    start(input: { courseId: string }): Promise<PublishState>;
    status(): Promise<PublishState>;
}

export function createPublishClient(baseUrl: string): PublishApi {
    return {
        async start(input) {
            return apiFetch({ method: 'POST', url: `${baseUrl}/publish/start`, body: input });
        },
        async status() {
            return apiFetch({ method: 'GET', url: `${baseUrl}/publish/status` });
        },
    };
}
