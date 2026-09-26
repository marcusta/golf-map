// Main-thread handle on the surface-stack worker (surface-stack.worker.ts),
// same shape as planner/sim-client.ts: the module Worker is created lazily on
// first use, and when Worker is unavailable (happy-dom) or fails, the same
// memoized resolver runs inline — slower, never broken.

import type { FeatureCollection } from 'geojson';
import { createSurfaceStackResolver } from '../../../shared/render/resolved-surface-stack';

export interface SurfaceStackRequest {
    id: number;
    source: FeatureCollection;
}

export type SurfaceStackResponse =
    | { id: number; ok: true; result: FeatureCollection }
    | { id: number; ok: false; error: string };

export interface SurfaceStackClient {
    /** `resolveSurfaceStack(source)`, computed off the calling thread when possible. */
    resolve(source: FeatureCollection): Promise<FeatureCollection>;
    dispose(): void;
}

/** The same resolver on the calling thread (worker fallback, tests). */
export function createInlineSurfaceStackClient(): SurfaceStackClient {
    const resolve = createSurfaceStackResolver();
    return {
        async resolve(source) {
            return resolve(source);
        },
        dispose() {},
    };
}

export function createWorkerSurfaceStackClient(): SurfaceStackClient {
    let worker: Worker | null = null;
    let fallback: SurfaceStackClient | null = null;
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: FeatureCollection) => void; reject: (error: Error) => void }>();

    const failAll = (error: Error): void => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };

    const ensureWorker = (): Worker | null => {
        if (worker) return worker;
        if (fallback) return null;
        if (typeof Worker === 'undefined') {
            fallback = createInlineSurfaceStackClient();
            return null;
        }
        try {
            worker = new Worker(new URL('./surface-stack.worker.ts', import.meta.url), { type: 'module' });
        } catch {
            fallback = createInlineSurfaceStackClient();
            return null;
        }
        worker.onmessage = (event: MessageEvent<SurfaceStackResponse>): void => {
            const message = event.data;
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new Error(message.error));
        };
        worker.onerror = (): void => {
            failAll(new Error('Surface stack worker failed'));
            worker?.terminate();
            worker = null;
            fallback = createInlineSurfaceStackClient();
        };
        return worker;
    };

    return {
        resolve(source) {
            const active = ensureWorker();
            if (!active) return fallback!.resolve(source);
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                active.postMessage({ id, source } satisfies SurfaceStackRequest);
            });
        },
        dispose() {
            failAll(new Error('Surface stack client disposed'));
            worker?.terminate();
            worker = null;
        },
    };
}
