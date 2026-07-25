# Plan: Hole Simulation & Strategy Variants — score distributions and auto-discovered lines

**Status:** proposal (designed 2026-07-19, ready for brief-writing — next wave starts at **T57**
per the terrain-edit numbering note). Absorbs the unbuilt **T18** (Monte Carlo plan scoring) from
[delegation-briefs.md](delegation-briefs.md) entirely.
**Scope:** `shared/strategy` (rollout simulator, closeout-distribution model, variant graph,
hole value map), `web/src/planner` (simulate panel, scatter overlay, suggest-lines UI, heatmap).
**No server changes** — suggested variants persist through the existing option-tree API
(`addShot` + `parentShotId`, O1/O6); sim results are derived and never persisted (O4 precedent).
**No iOS scope** — planning-mode only; Swift mirror deferred exactly as O4 defers
`scoreOptionChain` (revisit when an on-course consumer needs live distributions).
**Related:**
- [feature-plan-shot-options.md](feature-plan-shot-options.md) — the option tree is this
  feature's persistence and render layer: a discovered variant IS an option branch. O4
  explicitly deferred "full hole-score distribution … Monte Carlo whole-hole simulation (the
  old T18 sketch)" to a later feature. This is that feature.
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — `optimizeAim`,
  `shotsToHoleOut`, D13 (σ semantics), D14 (determinism), D16 (CVaR₈₀), D21 (independent
  shots) are the primitives and constraints everything below builds on.
- [feature-player-model.md](feature-player-model.md) — owns asymmetric/personal dispersion
  ("how you miss") and the personal ES surface. This feature consumes whatever sampler
  `ClubSpec` exposes; it must NOT grow its own miss-shape model (§V9).
- [feature-smart-caddy.md](feature-smart-caddy.md) — the par-5 attack rule
  (`enumerateStrategies`, 3 templated strategies on the straight line to the green) is the
  seed this feature generalises to lateral, multi-leg, hole-shaped variant discovery.
- [feature-putting-green-reading.md](feature-putting-green-reading.md) — its holed-probability
  heuristic (uncalibrated, `putt.ts` §3.5) is a future refinement of the green closeout row;
  v1 closeout uses the Broadie putting anchors only (§V2).

---

## 1. Purpose

The planner prices a line as **one number plus risk garnish**: expected strokes, CVaR₈₀ tail,
penalty%. That answers "which line is better on average" but not the two questions players
actually argue about:

1. **"If I play it this way, what will I actually score?"** — P(birdie), P(par), P(double or
   worse). Expectation 4.4 can be a boring two-putt-par machine or a birdie/blow-up coin flip;
   the distribution is the decision, especially in match play or when protecting a card.
2. **"What are the ways to play this hole at all?"** — a par 5 usually admits a handful of
   *genuinely different* lines (rip driver left of the bunkers and go in two; 3-wood short,
   lay to a full wedge; iron out right and play it as a three-shotter). Today the player must
   author every branch by hand; the engine only volunteers strategies on the straight line to
   the green (par-5 attack rule) and only off the tee.

This feature adds both: a **whole-hole Monte Carlo simulator** that turns any option branch
into a score distribution with a landing scatter you can see on the map, and a **variant
discovery** pass that proposes the distinct lines as ghost branches the player can accept into
the plan with one click. Together with the option tree, the planner becomes a lab: pick a hole,
see the 3–4 real ways to play it, and compare them as score histograms instead of a single EV.

## 2. The core insight (the "thinking")

1. **Simulate the authored legs, close out the rest with a distribution — never build an
   autonomous golfer.** A full policy simulation ("after the tree miss, the sim punches out to
   its favourite spot, then …") means building and trusting a robot player; its choices, not the
   plan, would dominate the result. Instead: the plan's own legs are simulated geometrically
   (dispersion sample → lie → next leg from where it landed), and the moment a sample leaves
   the script (water, trees, or the chain simply ends off the green) it is priced by a
   **distributionised expected-strokes table** — the same Broadie baseline the whole engine
   already trusts, upgraded from a mean to a pmf over integer strokes (§V2). The distribution
   the player sees is driven by the geometry they authored — the part they control — and the
   closeout stays consistent with every EV number already on screen.

2. **A "way to play a hole" is a topological signature, not a coordinate.** Two paths that
   carry the same hazards on the same sides with the same shot count are the *same strategy*
   with jiggled points; a path that goes left of the bunker is *different* even if its EV is
   nearly identical. Variant discovery therefore enumerates paths through a candidate-landing
   graph but **dedupes by signature** (hazards carried / side passed / shot count, §V5) and
   presents the best path per signature. That, not top-k by EV, is what makes the output read
   as "the 3 ways to play this hole" instead of "10 near-identical drives".

3. **Discovered variants and authored options are one system.** The options feature locked
   "authored options and engine candidates are the same thing at consumption time" (shot-options
   §2.3). Discovery output is therefore *transient ghost branches* in the same overlay language
   (dashed, dimmed, chipped); accepting one writes ordinary `plan_shots` rows through the
   existing tree API. No second persistence path, no "suggestion" schema (§V7).

4. **The hole value map is the honest long-term answer — but it's Phase D, not the entry
   point.** Backward value iteration over a spatial grid ("expected strokes from every point on
   this hole") is the principled generalisation: it discovers routes no template enumerates
   (adjacent-fairway lines, dogleg shortcuts) and doubles as a compelling heatmap overlay. It
   is also the only piece with real compute cost and new math. The graph enumeration (Phase C)
   ships the visible feature first and becomes the fixture the value map must beat.

## 3. Key design decisions (lock before building)

### V1 — Hybrid rollout: geometric legs + table closeout

One rollout of a branch (root-first legs from the decision point, same input shape as
`scoreOptionChain`):

1. Sample the current leg's landing from the club's dispersion pattern (same σ semantics as
   `optimizeAim`: ellipse semi-axes are `sigmaScale` σ, D13), aimed at the leg's **recommended
   bearing** (the enriched `recommendedBearingDeg` when present, else the authored bearing).
2. Classify the landing lie (D23 topmost-first rings — reuse `classifyLie`).
3. **On-script** (§V4): play the next authored leg *from the sampled landing*, keeping the
   next leg's club and aiming at its authored target point (not its authored bearing — the
   target is the invariant, the bearing shifts with the miss).
4. **Off-script or chain exhausted**: draw the strokes-to-hole-out from the closeout
   distribution (§V2) at the sample's (distance-to-green, lie) and terminate the rollout.
5. Penalty lie: apply D4 semantics (stroke + rough-equivalent at the same distance) — i.e.
   closeout draw from `1 + rough(distance)` distribution. No drop-geometry modelling in v1.

Score for the rollout = strokes played in-sim + closeout draw. Default **N = 800 rollouts**
(measure; budget §6). Output: pmf over integer hole scores, mean, and the per-leg landing
sample clouds (for the scatter overlay).

### V2 — Closeout distribution: a pmf whose mean is pinned to the Broadie table

New pure module `shared/strategy/score-distribution.ts`:

```ts
strokesDistribution(distanceM: number, lie: Lie): ReadonlyArray<number>
// index k = P(hole out in k strokes), k ≥ 1 (k = 0 only for distanceM < HOLED_DISTANCE_M)
```

Construction (deterministic, no sampling):
- μ = `shotsToHoleOut(distanceM, lie)` — the existing table value, unchanged and untouched.
- Support `{⌊μ⌋, ⌊μ⌋+1, ⌊μ⌋+2}` with mass placed to match the mean exactly and a per-lie
  **overdispersion constant** deciding how much of the upper mass sits at ⌊μ⌋+2 vs ⌊μ⌋+1
  (green lowest, fairway low, rough/sand mid, recovery highest — constants in one table in the
  file header, marked as calibration targets for the player model).
- Green row < ~3 m additionally respects the one-putt anchors (P(1) from the make% implied by
  the putting table; the green-reading heuristic curve is explicitly NOT used until calibrated).

Property tests: mean of pmf ≡ table μ to 1e-9 at every anchor and between; pmf sums to 1;
monotonicity in distance for fairway/rough/green (same rows D18 guarantees for the mean).

### V3 — Rollout randomness: counter-based hash RNG, not nested Halton

D14 (deterministic Halton) stays untouched for `optimizeAim`. Rollouts need randomness indexed
by (rollout, shot depth) — reusing one Halton stream across nested draws correlates the tee
miss with the approach miss and biases the tails. Lock: a **counter-based generator**
(splitmix64-style hash of `(seed, rolloutIndex, depth, drawIndex)` → uniforms → Box–Muller),
fixed default seed. Same inputs → identical histogram, no ordering sensitivity, trivially
portable to Swift later. Shots remain independent across legs per D21.

### V4 — On-script rule (crisp, no judgement calls in the sim)

A sample stays on script for the next authored leg iff **all** of:
- landing lie ∈ {fairway, tee-as-fairway, rough} (sand/recovery/penalty/green terminate:
  green → closeout = putting row; sand/recovery → closeout; penalty → V1.5);
- the next leg exists and has a club;
- distance from sampled landing to the next leg's target ≤ the club's wind-adjusted max carry
  + `LAYUP_TARGET_TOLERANCE_M` (can't reach ⇒ the plan is broken for this sample ⇒ closeout —
  the table absorbs it rather than the sim inventing a layup).

Rationale: rough stays on script because playing the planned next shot from light rough is
what players actually do and the lie penalty is already priced by the *following* landing
distribution and closeout; sand/trees are where real re-planning happens, exactly what we
refuse to model (§2.1).

### V5 — Variant discovery v1: candidate-landing graph + signature dedupe

New pure module `shared/strategy/variant-graph.ts`:

- **Nodes:** tee (origin), green center (terminal), plus candidate landings: the hole's aim
  points; layup-engine targets (`layupOptions` full-number distances, back-of-pinch per the
  par-5 constants); and **lateral triples** — at each aim point / layup distance band, offsets
  left/center/right within the containing fairway ring (offset = clamp to ring with a margin).
  Cap ~30 nodes/hole.
- **Edges:** A→B when some club's wind-adjusted carry covers |AB| within
  `LAYUP_TARGET_TOLERANCE_M` (reuse `bestReachClub`/`closestClubWithin`). Forward-progress
  constraint: chainage(B) > chainage(A) along the browse route (no backtracking edges).
- **Paths:** DFS tee→green, depth ≤ 4 legs. Price each with `scoreOptionChain` (already
  handles depth n, tail, penalty aggregation).
- **Signature:** ordered list of (hazard id, relation ∈ {carried, passed-left, passed-right,
  short-of}) for every hazard ring intersecting the path corridor, plus shot count. Hazard
  relation computed from the leg segment vs ring bbox/centroid — coarse is fine; the signature
  only needs to separate lines a golfer would call different.
- **Output:** best path per signature, ranked by chain EV, top 5. Each with its
  `ChainScore` and (lazily, on selection) its §V1 distribution.

### V6 — Hole value map (Phase D): grid value iteration seeded by the table

`shared/strategy/value-map.ts`, computed in a web worker:

- Grid over the hole corridor (browse-route buffer ∪ all feature rings), default **5 m**.
- `V⁰(x) = shotsToHoleOut(distToGreen(x), lie(x))`; sweep:
  `Vⁿ(x) = 1 + min over (club, aim) of E[Vⁿ⁻¹(landing)]` with the same ellipse sampling and a
  pruned action set (clubs whose carry ≤ remaining + tolerance; ~7 aim bearings). **Two sweeps,
  fixed** — the table baseline is close enough that further sweeps move numbers less than the
  sampling noise; fixing the count keeps it deterministic and budgetable.
- Uses: (a) "strokes from here" **heatmap overlay**; (b) variant discovery upgrade — distinct
  local optima of the tee-shot (club × aim) EV landscape, followed greedily through the grid,
  then deduped by the same V5 signature (so Phase C's UI is unchanged, only the generator
  improves); (c) the honest continuation for `optimizeAim` on this hole (out of scope to wire
  in v1 — §9).
- Cache key: (feature-geometry versions, tee, wind, club set, grid params). Invalidate on any
  component change; recompute is seconds, not frames.

### V7 — Suggestions are transient until accepted; accepting writes ordinary shots

"Suggest lines" renders discovered variants as **ghost branches** (new overlay layer, same
dash/dim language as non-primary options, distinct tint). They live in planner state only.
Accepting one calls the existing `addShot(parentShotId)` chain to materialise it as a real
option branch (label prefilled from the signature, e.g. "left of bunkers · 2 shots"); it then
IS an authored option — provenance ends at creation (shot-options §2.3). Dismissing forgets
it. No schema change, no suggestion persistence, no sync question.

### V8 — Sim cadence: explicit action, worker-computed, never persisted

Distributions are NOT part of the enrich cadence (DECADE §4.5 protects drag latency; a
distribution per drag-release would blow the budget). The simulate panel computes on explicit
"Simulate" / branch-select, in a worker, and invalidates (greys out, doesn't auto-recompute)
on any plan edit. Chain EV chips (existing) remain the always-fresh cheap number; the
histogram is the on-demand deep number. Results are derived state, never persisted (O4).

### V9 — Player-model boundary: consume the sampler, don't own the miss

This feature reads dispersion exclusively through the existing club sampling path. When
[feature-player-model.md](feature-player-model.md) ships asymmetric/personal patterns, rollouts
inherit them with zero changes here (same sampler), and the §V2 overdispersion constants +
closeout rows become fitting targets there. Nothing in this feature encodes miss bias, skew,
or per-player anything. (The "driver blocks right" ask lands in the player model; this feature
is what makes it *visible* — the scatter and the histogram are where an asymmetric pattern
finally shows its cost.)

## 4. Module layout (shared, pure — same conventions as the rest of `shared/strategy`)

```
shared/strategy/
  score-distribution.ts     V2 — strokesDistribution(distanceM, lie)
  simulate-chain.ts         V1/V3/V4 — simulateChain(legs, ctx, opts) → { pmf, mean,
                            perLegLandings, onScriptRate }
  variant-graph.ts          V5 — buildVariantGraph(holeCtx) → candidates;
                            discoverVariants(holeCtx) → ScoredVariant[]
  value-map.ts              V6 — buildValueMap(holeCtx, grid) → { grid, V, meta } (Phase D)
```

All zero-dep, projected meters, compass bearings, surfaces topmost-first (D23). `simulateChain`
takes the same `ChainLeg[]`/`ChainScoreContext` as `scoreOptionChain` so every call site that
can price a branch can simulate it.

**Agreement fixture (the keystone test):** on the shot-options reference hole, for each
authored branch, `mean(simulateChain(...))` must land within a pinned tolerance of
`scoreOptionChain(...).expectedStrokes` (they are different models — telescoped table EV vs
rollout with closeout pmf — the fixture pins the divergence and documents its two sources:
on-script re-origin vs planned-landing baseline, and pmf vs mean closeout). Any drift outside
tolerance is a bug in one of them.

## 5. Planner UX (web)

- **Simulate panel** (extends the existing planner panel, branch-scoped):
  - Score histogram — P(eagle)…P(double+), integer buckets, par-relative labels; mean and
    the existing EV chip side by side (they should agree; that's the point).
  - Branch comparison: selecting 2+ sibling options shows histograms stacked/overlaid — the
    "coin-flip birdie line vs boring par line" money shot.
  - `onScriptRate` shown as "plan survives: 78%" — how often the hole actually plays out as
    drawn. Low survival is itself advice.
- **Landing scatter overlay:** per-leg sampled landings as a dot cloud (subsampled ~200/leg),
  colored by lie class (map palette tokens — note the map-marker palette gap in the design
  tokens memo). Toggled from the simulate panel; renders under vector feature fills like other
  derived overlays.
- **Suggest lines:** button on the hole (planner toolbar) → ghost branches (V7) with signature
  labels + `ChainScore` chips; hover previews the corridor; accept/dismiss per ghost. Ghosts
  clear on hole switch.
- **Value heatmap (Phase D):** overlay toggle rendering `V(x)` as a translucent cost surface
  with a legend; the natural home is the existing analysis-overlay infrastructure
  (`analysis-overlay.ts` already renders sampled grids with color ramps).

## 6. Implementation phases (→ T57+ briefs)

### Phase A — Distribution core (shared, pure) ⭐ keystone
`score-distribution.ts` + `simulate-chain.ts` + the agreement fixture. Everything else renders
what this returns. Perf gate: 800 rollouts × 4-leg branch < 100 ms in a worker (measure in the
brief; N is tunable, determinism is not).

### Phase B — Simulate surfacing (web)
Worker plumbing, simulate panel, histogram + comparison, scatter overlay, invalidation per V8.

### Phase C — Variant discovery v1 (shared + web)
`variant-graph.ts`, signature dedupe, ghost-branch overlay + accept flow (V7). The par-5
attack rule is untouched (it stays the on-course/caddy voice); a follow-up may re-seed its
strategy set from the graph — noted in §8, not this wave.

### Phase D — Hole value map (shared + web, later)
`value-map.ts` in a worker + heatmap overlay + generator upgrade per V6. Ship only after C
proves the UI; the value map swaps the engine under an unchanged surface.

### Phase E — Player-model integration (later, other doc)
Personal sampler + calibrated closeout rows flow in via V9. No work here beyond not blocking
it.

A and C are independent after locking V5's output shape (C uses `scoreOptionChain` for pricing,
not the simulator); B depends on A; D depends on C's UI and A's sampling utilities. Suggested
wave: A+C in parallel, then B, then D as its own wave.

## 7. Effort / value / risk

| Phase | Effort | Value | Risk |
|---|---|---|---|
| A | S–M | The number everyone asked for | Closeout pmf shape is a modelling call — mitigated by mean-pinning + overdispersion constants being one tunable table |
| B | M | Makes A visible; comparison UI is the retention feature | Worker + invalidation plumbing; watch drag-latency regressions (V8 protects) |
| C | M | "Show me the ways to play this hole" — the demo feature | Signature coarseness (too many/few variants) — tune on 3 real holes before polishing UI |
| D | L | Honest discovery + the best-looking overlay in the app | Compute cost & grid edge cases; de-risked by shipping behind C's proven UI |

## 8. Open questions (resolve during briefs, none block Phase A)

1. §V2 overdispersion constants — initial values per lie (propose: green .02, fairway .08,
   rough .12, sand .15, recovery .25 as mass-at-+2 weights; sanity-check the implied double%
   against published amateur distributions before pinning goldens).
2. N=800 vs histogram stability — pin N after measuring the seed-to-seed wobble of P(double+)
   on the reference hole; wobble > ~1pp argues for N=1500 + a coarser scatter subsample.
3. Lateral-offset generation inside narrow fairways (V5) — margin and minimum-width rules.
4. Should the par-5 attack rule eventually read from `variant-graph` (one strategy enumerator
   for planner + caddy)? Attractive, but touches Swift parity — separate decision later.
5. Match-play framing (P(beat net par), Stableford EV) — pure presentation over the pmf;
   decide if it's Phase B or a fast-follow.

## 9. Explicitly out of scope / non-goals

- **Autonomous-golfer policy simulation** — recovery/punch-out decisions are never simulated
  geometrically; the table closes out (V1). Revisit only if the value map (D) someday prices
  recovery corridors.
- **Asymmetric / personal dispersion and closeout calibration** — owned by
  [feature-player-model.md](feature-player-model.md) (V9).
- **Wiring the value map in as `optimizeAim`'s continuation** — changes every EV in the app;
  its own decision with its own parity questions. The map ships as overlay + generator only.
- **Swift mirrors** of any module here (O4 precedent; planning-mode is web).
- **Persisting simulations, distributions, or suggestions** (V7/V8).
- **Drop-geometry modelling for penalties** (D4 semantics stand).
- **Green-reading holed-prob integration** into V2 before that curve is calibrated.
