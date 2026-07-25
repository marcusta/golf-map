// Main-thread handle on the strategy simulation worker (V8).
//
// Two implementations behind one interface:
//   - `createWorkerSimClient()` — the production path: a module Worker
//     (Vite's `new Worker(new URL('./sim.worker.ts', import.meta.url))`
//     form), created LAZILY on first use so merely constructing the planner
//     never spawns a thread. Falls back to the inline client when Worker is
//     unavailable (SSR, happy-dom, an old browser) or construction throws —
//     the feature degrades to "slower", never to "broken".
//   - `createInlineSimClient()` — runs the SAME pure engine on the calling
//     thread. This is the seam the service tests inject: a real object
//     exercising the real math (house rule: no mocking library), just without
//     a worker the test environment cannot host.
//
// Requests are correlated by an incrementing id, so an in-flight simulate and
// a discover can overlap without either clobbering the other; the service
// layer adds its own sequence token for "drop the stale answer".

import { discoverVariants, simulateChain } from '../../../shared/strategy';
import type {
    ChainLeg,
    ChainScoreContext,
    ScoredVariant,
    SimulateChainOptions,
    SimulateChainResult,
    VariantHoleContext,
} from '../../../shared/strategy';
import type { SimWorkerRequest, SimWorkerRequestBody, SimWorkerResponse } from './sim-protocol';

export interface SimClient {
    /** §V1 rollout distribution for one authored branch. */
    simulate(
        legs: readonly ChainLeg[],
        ctx: ChainScoreContext,
        opts?: SimulateChainOptions,
    ): Promise<SimulateChainResult>;
    /** §V5 variant enumeration for the whole hole (suggest lines). */
    discover(ctx: VariantHoleContext): Promise<ScoredVariant[]>;
    /** Terminate the worker (if any). Safe to call repeatedly. */
    dispose(): void;
}

/** Same engine, calling thread. Used as the worker fallback and in tests. */
export function createInlineSimClient(): SimClient {
    return {
        async simulate(legs, ctx, opts) {
            return simulateChain(legs, ctx, opts ?? {});
        },
        async discover(ctx) {
            return discoverVariants(ctx);
        },
        dispose() {
            // Nothing to tear down.
        },
    };
}

export function createWorkerSimClient(): SimClient {
    let worker: Worker | null = null;
    /** Set once the worker proves unusable; every later call goes inline. */
    let fallback: SimClient | null = null;
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

    const failAll = (error: Error): void => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };

    const ensureWorker = (): Worker | null => {
        if (worker) return worker;
        if (fallback) return null;
        if (typeof Worker === 'undefined') {
            fallback = createInlineSimClient();
            return null;
        }
        try {
            worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
        } catch {
            fallback = createInlineSimClient();
            return null;
        }
        worker.onmessage = (event: MessageEvent<SimWorkerResponse>): void => {
            const message = event.data;
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            if (message.ok) entry.resolve(message.result as never);
            else entry.reject(new Error(message.error));
        };
        worker.onerror = (): void => {
            // A worker-level failure (bundle didn't load, engine threw out of
            // band): drop it, fail the in-flight calls, and serve every later
            // request inline so the panel keeps working.
            failAll(new Error('Simulation worker failed'));
            worker?.terminate();
            worker = null;
            fallback = createInlineSimClient();
        };
        return worker;
    };

    const send = <T>(request: SimWorkerRequestBody): Promise<T> => {
        const active = ensureWorker();
        if (!active) {
            const inline = fallback ?? createInlineSimClient();
            fallback = inline;
            return request.kind === 'simulate'
                ? inline.simulate(request.legs, request.ctx, request.opts) as Promise<T>
                : inline.discover(request.ctx) as Promise<T>;
        }
        const id = ++nextId;
        return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve: resolve as (value: never) => void, reject });
            active.postMessage({ ...request, id } as SimWorkerRequest);
        });
    };

    return {
        simulate(legs, ctx, opts) {
            return send<SimulateChainResult>({
                kind: 'simulate',
                legs: legs as ChainLeg[],
                ctx,
                ...(opts ? { opts } : {}),
            });
        },
        discover(ctx) {
            return send<ScoredVariant[]>({ kind: 'discover', ctx });
        },
        dispose() {
            failAll(new Error('Simulation client disposed'));
            worker?.terminate();
            worker = null;
        },
    };
}
