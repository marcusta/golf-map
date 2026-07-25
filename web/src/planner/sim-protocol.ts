// Wire types for the strategy simulation worker (feature-hole-sim-and-variants
// V8: distributions are computed OFF the main thread on an explicit action).
//
// TYPES ONLY — this module is erased at build time, so both the worker entry
// (sim.worker.ts) and the main-thread client (sim-client.ts) can import it
// without either pulling the other into its bundle.
//
// Everything crossing postMessage here is plain JSON-shaped data (numbers,
// arrays, `{x, y}` records) — the shared/strategy input types are already
// dependency-free plain objects, so structured clone handles them with no
// serialisation layer of our own.

import type {
    ChainLeg,
    ChainScoreContext,
    ScoredVariant,
    SimulateChainOptions,
    SimulateChainResult,
    VariantHoleContext,
} from '../../../shared/strategy';

/** Run `simulateChain(legs, ctx, opts)` in the worker. */
export interface SimulateRequest {
    id: number;
    kind: 'simulate';
    legs: ChainLeg[];
    ctx: ChainScoreContext;
    opts?: SimulateChainOptions;
}

/** Run `discoverVariants(ctx)` in the worker (V5/V7 suggest-lines). */
export interface DiscoverRequest {
    id: number;
    kind: 'discover';
    ctx: VariantHoleContext;
}

export type SimWorkerRequest = SimulateRequest | DiscoverRequest;

/**
 * A request before the client stamps its correlation id. Written as a union of
 * Omits rather than `Omit<SimWorkerRequest, 'id'>`, which would collapse the
 * discriminated union into one member-less object and lose narrowing on `kind`.
 */
export type SimWorkerRequestBody =
    | Omit<SimulateRequest, 'id'>
    | Omit<DiscoverRequest, 'id'>;

export interface SimWorkerOk {
    id: number;
    ok: true;
    /** `SimulateChainResult` for 'simulate', `ScoredVariant[]` for 'discover'. */
    result: SimulateChainResult | ScoredVariant[];
}

export interface SimWorkerErr {
    id: number;
    ok: false;
    error: string;
}

export type SimWorkerResponse = SimWorkerOk | SimWorkerErr;
