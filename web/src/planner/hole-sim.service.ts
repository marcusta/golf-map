// Hole-simulation state (feature-hole-sim-and-variants Phase B + C, V7/V8).
//
// Owns everything about the SIMULATE panel that is not geometry: which
// branches have a distribution, whether that distribution still matches the
// plan on screen, the scatter toggle, and the transient suggest-lines ghosts.
// The planner tool builds the inputs (it owns holePlan / lieMap / green) and
// hands them here; this service never reads the plan itself, which is exactly
// what makes it testable without a map.
//
// THE CADENCE CONTRACT (V8), and why it looks like this:
//   - Nothing here is wired to an effect. Simulation runs ONLY when someone
//     calls `simulate()` — the explicit "Simulate" button or a branch
//     selection. It can therefore never be dragged into the enrich cadence,
//     let alone the per-frame drag path (DECADE §4.5).
//   - Invalidation is a COMPARISON, not a recompute: results are stored with
//     the plan signature they were computed from, and `stale` is true while
//     that differs from the live `planSignature` the tool pushes in. Any plan
//     edit — including a drag frame — therefore GREYS the histogram and
//     leaves it grey until the user asks again. No auto-recompute, ever.
//   - Results are derived state: they live in signals, never in the store,
//     never on the wire (O4/V8).
//
// Ghost variants (V7) are the same deal: transient planner state, cleared on
// hole switch, materialised into ordinary `plan_shots` only on accept (which
// the tool performs, since it owns PlanService).

import { Computed, Signal } from '@basics/core/client/core';
import type {
    ChainLeg,
    ChainScoreContext,
    ScoredVariant,
    VariantHoleContext,
    Vec2,
} from '../../../shared/strategy';
import { DEFAULT_ROLLOUTS } from '../../../shared/strategy';
import { createWorkerSimClient, type SimClient } from './sim-client';
import { buildHistogram, shiftPmf, type ScoreBucket } from './sim-histogram';
import { SCATTER_MAX_PER_LEG, subsample, variantSignatureLabel, type GhostVariant } from './sim-overlay';

/**
 * Sentinel branch id for the hole's PRIMARY line (the rank-0 walk). Options
 * use their own shot id, but the primary chain starts at the tee and has no
 * single owning shot, so it needs a name of its own.
 */
export const PRIMARY_BRANCH_ID = 'primary';

/** One branch to simulate: the chain, its context, and how to label it. */
export interface SimBranchRequest {
    /** Stable id — the option shot's id, or 'primary' for the main line. */
    branchId: string;
    /** Panel label ("1A", "Primary line", …). */
    label: string;
    /** The hole's par, for par-relative bucket labels. */
    par: number;
    /** Strokes already played to reach this branch's decision point. */
    strokesBefore: number;
    legs: readonly ChainLeg[];
    ctx: ChainScoreContext;
}

/** One branch's simulated distribution, expressed in HOLE SCORE. */
export interface SimBranchResult {
    branchId: string;
    label: string;
    par: number;
    strokesBefore: number;
    /** pmf over integer hole scores (already shifted by `strokesBefore`). */
    pmf: readonly number[];
    /** Mean hole score (shifted) — shown beside the branch's EV chip. */
    mean: number;
    /** Fraction of rollouts that played every authored leg (§5 "plan survives"). */
    onScriptRate: number;
    /** The five par-relative histogram buckets. */
    buckets: ScoreBucket[];
    /** Subsampled sampled landings per leg depth, for the scatter overlay. */
    perLegLandings: Vec2[][];
    rollouts: number;
}

export class HoleSimService {
    /**
     * The simulation engine. Defaults to the worker client; service tests
     * inject the inline one (the same pure engine, no thread) — the seam is a
     * constructor parameter for the same reason PlannerToolService takes its
     * AnalysisApi that way.
     */
    constructor(private readonly client: SimClient = createWorkerSimClient()) {}

    // ── Distribution state (V8) ────────────────────────────────────────────

    /**
     * A signature of the live plan, pushed in by the tool. Unlike DECADE's
     * `strategyInputs` this INCLUDES shot positions: V8 wants ANY plan edit to
     * invalidate, and "the shot I dragged moved" is the most obvious edit of
     * all. Cheap to compare, and nothing recomputes off it.
     */
    readonly planSignature = new Signal<string>('');

    /** Last completed run, tagged with the signature it was computed from. */
    private readonly resultState =
        new Signal<{ signature: string; branches: readonly SimBranchResult[] } | null>(null);

    /** The branches currently shown in the panel (empty before a first run). */
    readonly branches = new Computed<readonly SimBranchResult[]>(
        () => this.resultState.get()?.branches ?? []);

    /**
     * True when a result exists but the plan has changed under it. The panel
     * GREYS the histogram on this — it does not clear it and it does not
     * recompute (V8): a stale distribution is still informative, a wrong one
     * presented as fresh is not.
     */
    readonly stale = new Computed<boolean>(() => {
        const state = this.resultState.get();
        return state !== null && state.signature !== this.planSignature.get();
    });

    readonly running = new Signal<boolean>(false);
    readonly error = new Signal<string | null>(null);

    /** Landing-scatter overlay toggle (off by default — it's a lot of dots). */
    readonly scatterVisible = new Signal<boolean>(false);

    /** Drops a late worker answer after a newer run (or a clear) superseded it. */
    private simSeq = 0;

    /**
     * Simulate one or more branches and publish them together (branch
     * comparison stacks them in one result set, so they must share a run and
     * a signature). A no-op for an empty request list.
     */
    async simulate(
        requests: readonly SimBranchRequest[],
        opts: { rollouts?: number } = {},
    ): Promise<void> {
        if (requests.length === 0) return;
        const seq = ++this.simSeq;
        const signature = this.planSignature.peek();
        this.running.set(true);
        this.error.set(null);
        try {
            const branches = await Promise.all(requests.map(async request => {
                const result = await this.client.simulate(request.legs, request.ctx, {
                    rollouts: opts.rollouts ?? DEFAULT_ROLLOUTS,
                    maxLandingsPerLeg: SCATTER_MAX_PER_LEG,
                });
                const pmf = shiftPmf(result.pmf, request.strokesBefore);
                return {
                    branchId: request.branchId,
                    label: request.label,
                    par: request.par,
                    strokesBefore: request.strokesBefore,
                    pmf,
                    mean: result.mean + request.strokesBefore,
                    onScriptRate: result.onScriptRate,
                    buckets: buildHistogram(pmf, request.par),
                    perLegLandings: result.perLegLandings.map(
                        landings => subsample(landings, SCATTER_MAX_PER_LEG)),
                    rollouts: result.rollouts,
                } satisfies SimBranchResult;
            }));
            if (seq !== this.simSeq) return; // superseded
            this.resultState.set({ signature, branches });
        } catch (error) {
            if (seq !== this.simSeq) return;
            this.error.set(error instanceof Error ? error.message : String(error));
        } finally {
            if (seq === this.simSeq) this.running.set(false);
        }
    }

    /** Forget the current distributions (hole switch, panel teardown). */
    clear(): void {
        this.simSeq++;
        this.resultState.set(null);
        this.running.set(false);
        this.error.set(null);
    }

    // ── Suggest lines (V7) ─────────────────────────────────────────────────

    /** Ghost branches for the selected hole. Transient — never persisted. */
    readonly variants = new Signal<readonly GhostVariant[]>([]);

    /** The ghost whose corridor is previewed (hover). */
    readonly hoveredVariantId = new Signal<string | null>(null);

    readonly discovering = new Signal<boolean>(false);

    private discoverSeq = 0;

    /**
     * Enumerate the hole's distinct playable lines and keep them as ghosts.
     * `hazardKindById` turns the graph's hazard ids back into feature types so
     * the signature reads as a label ("left of the bunkers · 2 shots").
     * Returns the number of ghosts produced.
     */
    async discover(
        ctx: VariantHoleContext,
        hazardKindById: ReadonlyMap<string, string>,
    ): Promise<number> {
        const seq = ++this.discoverSeq;
        this.discovering.set(true);
        this.error.set(null);
        try {
            const found: ScoredVariant[] = await this.client.discover(ctx);
            if (seq !== this.discoverSeq) return 0;
            const ghosts = found.map(variant => ({
                id: variant.signature.key,
                label: variantSignatureLabel(variant.signature, hazardKindById),
                variant,
            } satisfies GhostVariant));
            this.variants.set(ghosts);
            return ghosts.length;
        } catch (error) {
            if (seq !== this.discoverSeq) return 0;
            this.error.set(error instanceof Error ? error.message : String(error));
            return 0;
        } finally {
            if (seq === this.discoverSeq) this.discovering.set(false);
        }
    }

    /** Forget one ghost (V7 "dismiss" — no persistence, so nothing to record). */
    dismissVariant(id: string): void {
        this.variants.set(this.variants.peek().filter(g => g.id !== id));
        if (this.hoveredVariantId.peek() === id) this.hoveredVariantId.set(null);
    }

    /** Drop every ghost (hole switch, accept, teardown). */
    clearVariants(): void {
        this.discoverSeq++;
        this.variants.set([]);
        this.hoveredVariantId.set(null);
        this.discovering.set(false);
    }

    /** Full reset — both halves. Used when the selected hole changes. */
    reset(): void {
        this.clear();
        this.clearVariants();
    }

    dispose(): void {
        this.reset();
        this.client.dispose();
    }
}
