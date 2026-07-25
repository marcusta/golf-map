// Strategy simulation worker (feature-hole-sim-and-variants V8).
//
// Deliberately THIN: it owns no state, no caching, no policy — it takes a
// serialised `ChainLeg[]` + `ChainScoreContext` (or a `VariantHoleContext`),
// calls the pure shared/strategy engine, and posts the plain result back.
// Everything about WHEN to run (explicit Simulate / branch select, never the
// drag path) and what to do with a stale answer lives on the main thread in
// hole-sim.service.ts — the worker just keeps the 800-rollout loop off the
// UI thread so drag latency is structurally protected (V8 protects DECADE
// §4.5).
//
// Imports only `shared/strategy` (zero-dep, no DOM, no framework), so the
// worker bundle stays tiny.

import { discoverVariants, simulateChain } from '../../../shared/strategy';
import type { SimWorkerRequest, SimWorkerResponse } from './sim-protocol';

const post = (message: SimWorkerResponse): void => {
    (self as unknown as Worker).postMessage(message);
};

self.onmessage = (event: MessageEvent<SimWorkerRequest>): void => {
    const request = event.data;
    try {
        const result = request.kind === 'simulate'
            ? simulateChain(request.legs, request.ctx, request.opts ?? {})
            : discoverVariants(request.ctx);
        post({ id: request.id, ok: true, result });
    } catch (error) {
        post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
