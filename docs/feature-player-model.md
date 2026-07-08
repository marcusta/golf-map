# Plan: Personal Player Model — your expected strokes, your misses

**Status:** proposal (designed 2026-07-07, ready for a build session)
**Date:** 2026-07-07
**Scope:** new `shared/strategy/player/`, server fitting job + `player_model` persistence, changes to `aim.ts` sampling and `shotsToHoleOut` consumers. Absorbs the unbuilt **T15** (dispersion fitting) entirely. Hard dependency for validation-with-real-data: **T13** (iOS shot capture) must start collecting rounds.
**Related:**
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) — the engine this personalizes. D3 shipped the PGA/Broadie baseline and deferred calibration; this is that calibration, designed.
- [decisions-strategy-2026-07-06.md](decisions-strategy-2026-07-06.md) — D13 (σ semantics), D14 (deterministic Halton sampling), D16 (CVaR₈₀) are load-bearing constraints below.
- [feature-shot-capture.md](feature-shot-capture.md) — T12 schema (`target_lat/lon`, wind snapshot, `penalty_strokes`) is exactly the observation record this model consumes.
- [delegation-briefs.md](delegation-briefs.md) — supersedes T15; T18 (Monte Carlo plan scoring) becomes the evaluator that Practice ROI (§8) needs.
- [feature-putting-green-reading.md](feature-putting-green-reading.md) — its holed-probability curve is one component of this model (§4.4); coordinate, don't compete.

---

## 1. Purpose

Every number the app shows today is tour-pro advice: `shotsToHoleOut` is Broadie's PGA table,
`optimizeAim` samples a symmetric Gaussian ellipse. Real players differ from the tour baseline
in two ways that change decisions, not just scores:

1. **Level and shape of skill** — a 12-handicap's expected strokes from 150 m rough is not the
   tour's, and the *difference* varies by distance and lie (the gap is small on the tee, huge
   around the green).
2. **How they miss** — every golfer has a dominant miss (slice/hook bias, long/short
   asymmetry, and an occasional "foul ball" fat tail). A symmetric blob aims you at targets a
   fader should never aim at.

This feature replaces both assumptions with a **fitted personal model** that degrades
gracefully to the tour baseline at zero data: at 5 shots you get the prior nudged; at 500 you
get *your* game. Because everything downstream (aim EV, caddy rules, plan overlay, strokes
gained, yardage club picks) reads from these two surfaces, **every feature becomes personal at
once** — no per-feature work.

## 2. The core insight (the "thinking")

1. **Fit the shot model, derive the ES surface — never fit ES directly.** Expected strokes
   from (distance, lie) is a *consequence* of how you hit shots. Fitting ES tables directly
   needs thousands of observations per cell; fitting a low-dimensional per-club shot model
   needs tens, and the personal ES surface then falls out by value iteration over that model
   (§5). This is also what makes #1 and #4 the same feature: asymmetric dispersion (#4) is
   just parameters of the shot model that the derived ES surface (#1) automatically inherits.

2. **Stay conjugate; no MCMC, no fitting framework.** Every parameter gets a closed-form
   empirical-Bayes update (pseudo-count shrinkage). The entire fitting job is arithmetic over
   residuals — pure TS, unit-testable, Swift-mirrorable, and its behavior at n=0, n=5, n=500
   is inspectable by hand. The design goal is *trustworthy at low n*, not maximally expressive.

3. **The prior is skill-indexed, not tour-only.** Broadie's published amateur benchmark tables
   (scratch / 80 / 90 / 100-shooter) give a prior *ladder*. A player's handicap selects the
   prior mean; data moves them off it. A 20-handicap with 5 logged shots should get
   20-handicap advice, not tour advice — that alone fixes today's biggest advice error before
   any personal data exists.

4. **Determinism is a hard constraint (D14).** `optimizeAim` uses Halton(2,3) → Box–Muller.
   The personal distribution must be sampleable by inverse-CDF from the same Halton uniforms —
   which dictates the parameterization choice in §4.1 (two-piece normal: closed-form inverse
   CDF; skew-normal: not).

## 3. Model overview

```
θ (skill vector)
├─ per club c:                       LongGameModel
│    carryMeanM[c]                   — actual vs bag-listed carry
│    σ_long[c], σ_short[c]           — two-piece distance dispersion (long/short of mean)
│    σ_left[c], σ_right[c]           — two-piece direction dispersion (relative to aim line)
│    biasDeg[c]                      — directional bias: mean start/curve offset (the slice)
│    pFoul[c], foulScale[c]          — small mixture weight for the big miss (fat tail)
├─ short game (per lie, distance band ≤ ~50 m):   ShortGameModel
│    proximity distribution params (log-normal median + spread)
├─ putting:                          PuttingModel
│    makeCurve: logistic in distance (a, b) ; lagError: proportional σ_lag
└─ meta: nEff per parameter group, lastFitAt, modelVersion
```

Personal ES surface = value iteration over θ (§5), cached as the same anchor-table shape as
`EXPECTED_STROKES_ANCHORS_M` so `shotsToHoleOut` consumers are unchanged.

## 4. Parameterization decisions (lock before building)

### 4.1 Asymmetric dispersion = two-piece normal per axis (not skew-normal, not free 2D)

Each axis (distance, direction) is a **two-piece (split) normal**: one mean, different σ on
each side. Chosen because it is:
- **interpretable & robustly fittable**: σ_left/σ_right are per-side spread estimates —
  side-conditioned residual moments with shrinkage, no optimizer;
- **inverse-CDF in closed form** → deterministic Halton sampling (D14) with *one* uniform per
  axis (today's Box–Muller pair becomes two independent inverse-CDF draws — simpler);
- **a strict superset of today**: σ_left = σ_right reproduces the current symmetric ellipse
  exactly, giving a golden regression test and a zero-data fallback.

Directional bias enters as a mean offset (`biasDeg`), NOT as asymmetry — a slicer's cloud is
*shifted* right and *skewed* right; the model captures both, and keeps "aim adjusts for bias"
(mean) separable from "tail risk differs by side" (σ split), which is what CVaR₈₀ (D16) needs.

### 4.2 The big miss is a mixture component, not a wider σ

With probability `pFoul` (order 2–8%, club-dependent) the shot is drawn from a wide
symmetric component (`foulScale` × base σ, mean shortened). Widening σ to cover shanks/tops
corrupts the core pattern that aim optimization needs; a mixture keeps the core tight and
lets CVaR₈₀ see the real tail. Deterministic sampling: the Halton uniform for the distance
axis is also the mixture selector (u < pFoul → foul branch, rescale u) — still one sequence,
still reproducible.

### 4.3 Lie multipliers, not per-lie refits

Per-club parameters are fitted from fairway/tee shots; rough/sand apply *global* (not
per-club) multipliers on σ and carry, each with its own prior and shrinkage. There will never
be enough per-club-per-lie data; global multipliers are 4 numbers with plenty.

### 4.4 Short game and putting are direct low-param fits, not derived

Below ~50 m, shot-model simulation adds noise without insight. Fit proximity distributions
per (lie, band) and the putting make-curve/lag directly — few parameters each, same shrinkage
machinery. The putting make-curve is shared state with
[feature-putting-green-reading.md](feature-putting-green-reading.md) §9 Q6: that feature may
later *condition* it on green/slope context; this model owns the marginal curve.

## 5. From θ to the personal ES surface (value iteration)

```
ES_θ(d, lie) = 1 + E_{shot ~ θ, policy}[ ES_θ(d′, lie′) ]        (+ penalty terms)
```

- **Policy:** the player follows the caddy — club/aim chosen by `optimizeAim` under their own
  θ. (Assuming optimal-for-you policy is both simpler and the honest definition of "your
  potential with this app"; observed-policy modeling is a non-goal, §11.)
- **Terrain:** abstract hole ensembles (fairway-width / hazard-density archetypes calibrated
  so tour-θ reproduces the Broadie table — the same trick as the prior anchoring), NOT
  per-course geometry. Per-course ES is what T18 Monte Carlo plan scoring does with real
  holes; this table is course-generic by design, matching what `shotsToHoleOut` means today.
- **Boundary:** below 50 m, close the recursion with the §4.4 direct fits (proximity → one
  more lookup; putting → make curve + lag recursion, ~2 iterations to converge).
- **Output:** anchor table in `EXPECTED_STROKES_ANCHORS_M` shape (§3), computed server-side
  after each fit, persisted with `modelVersion`, shipped to clients like any other player
  asset. Interpolation code is reused as-is.
- **Anchor test:** value iteration with θ = tour prior must reproduce the T1-verified Broadie
  anchors within tolerance. This single test validates the whole generative pipeline.

## 6. Fitting (absorbs T15)

Server job per player, triggered after round upload:

1. **Residuals:** T12 shots carry `target_lat/lon` → residual = actual − target, rotated into
   (along, across) by shot bearing; wind snapshot → normalize with `wind.ts` before fitting;
   `penalty_strokes`/`shot_type` gate which observations feed which parameter group.
2. **Robust gate (T15's median/MAD survives here):** per club, flag |residual| > k·MAD as
   foul-candidates — they feed `pFoul`/`foulScale`, not the core σs. Nothing is discarded;
   outliers are *routed*, not dropped.
3. **Shrinkage updates (all closed-form):**
   - variances: inverse-gamma/Normal — `σ²_post = (n₀·σ²_prior + Σwᵢrᵢ²) / (n₀ + Σwᵢ)`,
     applied per side (two-piece: side-conditioned residuals, ×2 correction for
     half-sample);
   - means/bias: Normal–Normal — same pseudo-count form;
   - pFoul: Beta–Binomial;
   - make curve: logistic via distance-binned Beta–Binomial then curve fit through posterior
     means.
   - **n₀ (prior pseudo-counts) are the shrinkage schedule:** default ~20 per club-axis,
     ~40 for pFoul, ~50 per putting bin. At 5 shots the prior dominates (~80%); at 500 the
     data does (~96%). These constants are named, central, and tuned by the synthetic-data
     coverage test (§9).
4. **Drift = exponential decay, time-based:** observation weight `wᵢ = 0.5^(Δtᵢ/τ)`,
   τ ≈ 12 months. Bounded effective sample size ⇒ the prior never fully vanishes and genuine
   skill change (lessons, age, new swing) tracks with ~a-season lag. Per-club **reset** action
   for equipment changes (new driver ⇒ that club's history zeroed, prior re-centered on bag
   spec).
5. **Persist** `player_model` row: θ, per-group nEff, ES anchor table, modelVersion.

## 7. Blend entry into the engine (the API surface)

- **`aim.ts`:** sampling loop swaps Box–Muller pairs for two inverse-CDF draws (two-piece +
  mixture, §4.1–4.2) from the same Halton(2,3) sequence; ellipse semi-axes generalize to the
  four σs + bias. `sigmaScale` display semantics (D13) keep working per side. Symmetric θ ⇒
  bit-identical current behavior (regression test).
- **`shotsToHoleOut`:** new `PlayerES` provider — personal anchor table if fitted, else
  handicap-ladder prior, else tour table. Signature unchanged for consumers; the provider is
  injected where the engine is constructed (planner context, caddy context, SG baseline
  choice stays tour for comparability — SG vs tour is the industry-standard yardstick, note
  in UI).
- **`ellipse.ts` rendering:** planner ellipse becomes the two-piece contour (egg, not
  ellipse) — the visual payoff that makes the model legible to the user.
- **Caddy:** rules already consume EV/dispersion through CaddyContext; they become personal
  with zero rule changes. One new rule unlocked: dominant-miss guard ("water lives on your
  miss side — aim off it") reads biasDeg/σ-split directly.

## 8. Practice ROI (designed-in consumer, built later)

"Which improvement buys most strokes?" = sensitivity of expected score to θ:

```
ROI_k = [ EV_course(θ) − EV_course(θ ⊕ improve_k) ] / effort_k
```

`improve_k` = standard perturbations (driver σ −10%, bias −50%, pFoul −2pts, make-rate from
2 m +10pts, 100 m proximity −15%...). `EV_course` = T18 Monte Carlo plan scoring over a real
course — **T18 is the evaluator; this model is the θ; ROI is a ~day of glue once both
exist.** The hook this spec must guarantee: θ is a plain serializable value object, and every
engine entry point takes θ as data (no singletons), so perturbed copies are free.

## 9. Validation without real data (build-time tests)

1. **Recovery:** synthesize shots from known θ*, fit at n = 5/50/500 — posterior means
   converge to θ*, monotone in n.
2. **Coverage:** with prior-drawn θ*, ~68% of parameters inside 1-σ posterior bands (checks
   the n₀ schedule is honest, not just plausible).
3. **Tour anchor:** §5 value iteration at tour-θ reproduces Broadie anchors (T1 values).
4. **Symmetry regression:** symmetric θ through new `aim.ts` = current `aim.ts`, bit-exact.
5. **Ladder sanity:** ES(90-shooter prior) ≥ ES(scratch prior) ≥ ES(tour) pointwise; gaps
   widen toward the green (matches Broadie's published amateur data).

## 10. Implementation phases

- **Phase A — `shared/strategy/player/` core** ⭐ keystone (Fable-designed, any-model built):
  types for θ, two-piece + mixture distribution (pdf/inverse-CDF/moments), shrinkage updates,
  drift weights, synthetic tests §9.1–9.2. Pure, zero-dep.
- **Phase B — engine entry:** `aim.ts` sampling swap + `PlayerES` provider + symmetry
  regression + handicap prior ladder (digitize Broadie amateur tables, verify like T1).
- **Phase C — value iteration:** archetype ensembles, tour-anchor test, ES table generation.
- **Phase D — server fit job:** residual pipeline over T12 shots, `player_model` persistence,
  refit trigger. (T15 is closed by this phase.)
- **Phase E — surfacing:** planner egg-contour rendering, caddy dominant-miss rule, model
  inspector UI ("your driver: 12 m long-side / 22 m short-side, 4° right bias, n=87").
- **Parallel, unblocking:** **T13 capture UI** (existing brief, unchanged) — start collecting
  rounds now; Phases A–C are validated synthetically and don't wait for it.

## 11. Open questions to resolve

1. **Handicap prior ladder source:** Broadie's amateur benchmark tables — confirm exact
   values/licensing; else fit the ladder from published SG-by-handicap aggregates.
2. **Archetype ensemble design (§5):** how many hole archetypes to reproduce Broadie within
   tolerance? Start ~6 (wide/narrow × hazard density × par), calibrate.
3. **Carry-mean vs bag spec:** does fitted carryMeanM override `ClubSpec` everywhere or only
   inside sampling? (Leaning: everywhere, with UI showing "listed 205 / actual 193".)
4. **Wind normalization fidelity:** residuals depend on `wind.ts` inversion quality — decide
   acceptable error and whether to down-weight high-wind observations.
5. **Putting capture granularity:** make-curve fitting needs putt distances — confirm T13
   scope records them (T12 schema supports it).
6. **SG baseline toggle:** tour-only (comparable) vs also-personal ("vs your model") in the
   T14 views — product call, engine supports both for free.

## 12. Explicitly out of scope / non-goals

- **Observed-policy modeling** (fitting what the player *chooses*, not just executes) — the
  policy is `optimizeAim` under their θ, by design.
- **Per-course personal ES tables** — that's T18's job with real geometry.
- **Full 2D copula/skew-normal dispersion** — two-piece per-axis + mixture covers the
  observable structure at amateur data volumes; revisit at n ≫ 500 if residual diagnostics
  demand it.
- **Shot-shape simulation (curvature in flight)** — the model is about landing distributions.
- **Session-level effects** (warm-up, fatigue, weather beyond wind) — absorbed into σ.
- **Wind forecast integration, ballistic plays-like (D8 follow-up), club-gapping/bag
  analysis, handicap/scorecard scoring** — separate catalogue candidates, deliberately not in
  this package; club-gapping is the cheapest future spin-off since §3's carry/σ per club *is*
  the gapping data.
