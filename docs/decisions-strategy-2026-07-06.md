# Decision register — strategy engine trio (locked 2026-07-06)

**Status:** decided. This register resolves every open question in the three proposals and adds
the cross-cutting decisions they deferred. Implementation follows this document; if code and this
document disagree, this document wins until amended here.

Covers:
- [decade-planner-strategy-engine.md](decade-planner-strategy-engine.md) §8
- [feature-distances-yardages.md](feature-distances-yardages.md) §9
- [feature-smart-caddy.md](feature-smart-caddy.md) §9
- Cross-cutting model decisions (σ semantics, sampling, risk, tables) that Phase A/B code needs.

---

## 1. DECADE engine (§8)

**D1. `deep_rough` and `trees` map to `recovery`.** Amended 2026-07-08 by
[decisions-course-overlays-2026-07-08.md](decisions-course-overlays-2026-07-08.md): `deep_rough`
is low vegetation and `trees` is vertical obstruction, so they are distinct course-feature types
even though the current single-lie model maps both to `recovery`. Both are included in
`DEFAULT_HAZARD_TYPES` for corridor scans.

**D2. EV is derived client-side, never persisted.** No schema change, no migration. Revisit only
if server-side plan scoring becomes a feature (then it is a new endpoint, still not a column).

**D3. Single baseline table (PGA Tour / Broadie), no skill tiers.** Two supporting arguments
beyond the doc's: (a) in aim optimisation only *differences* across candidate aims matter, and a
uniform additive skill offset cancels in the argmin; (b) player skill enters through their own
carry + dispersion, which changes the *inputs* to the table, which is the dominant effect.
Slope-of-table differences between skill levels are second-order; ship, then calibrate.

**D4. Penalty model:** `shotsToHoleOut(d, 'penalty') = 1 + shotsToHoleOut(d, 'rough')`.
Approximates stroke-and-drop near the point of entry with a rough-equivalent lie, no drop-back
distance in v1. Simple, monotone, and errs slightly optimistic (real drops lose position) — an
acceptable bias flagged for calibration, not a correctness issue.

## 2. Feature distances (§9)

**D5. Hazard listing:** only hazards the shot line crosses (`hazardsAlongLine`), plus green
front/centre/back and aim points always. No "every ring on the hole" mode in v1.

**D6. Default carry bearing:** origin → green centre; a selected aim point overrides. Confirmed.

**D7. Elevation batching:** one batched POST per recompute is accepted for the web planner.
No caching layer in v1 (recomputes are user-action-paced, not per-frame).

**D8. Plays-like stays `playsLikeSimpleM`** (horizontal + signed elevation) in v1, behind the
separable-delta UI. Ballistic refinement is a later phase and slots in behind the same fields.

## 3. Smart caddy (§9)

**D9. "Front approach clean" test:** reuse `hazardsAlongLine` on the origin → green-front line
and flag *unclean* if any hazard ring intersects the final **30 m** before the front edge. No new
geometry. The 30 m window is a named constant to calibrate.

**D10. `GreenSlopeSummary` shape:** dominant fall-line bearing + magnitude (%), **plus** a
front-half/back-half slope split so rules can say *which* half. (Doc default, confirmed.)

**D11. Risk knob is transient** planner state in v1, not persisted with club config. Mirrors
"EV is derived". Promote to per-player persistence only when shot capture gives us data to
calibrate it against.

**D12. Advice ranking = priority × confidence** simple product, risk-weighted per rule where the
rule declares it. No learned blend in v1.

## 4. Cross-cutting model decisions (new)

**D13. σ semantics (supersedes DECADE §4.4's "~2σ" sketch).** Club dispersion values are FULL
extents (v1 gotcha #1), so the ellipse semi-axes are half-extents. We define:
`σ_axis = semiAxis / sigmaScale`, with **default `sigmaScale = 2`**, i.e. the drawn ellipse is a
≈95% containment region (±2σ per axis). Rationale: when a player states "my 7-iron is 30 m
wide", they mean nearly all shots, not 68% of them; and v1's ±4% dispersion *bands* around the
stated value indicate the stated value is a near-max envelope. `sigmaScale = 1` reproduces the
looser reading (drawn ellipse = ±1σ) if calibration demands it. One knob, documented, default 2.

**D14. Sampling is deterministic low-discrepancy, not `Math.random`.** Standard-normal pairs via
Halton(2,3) → Box–Muller. Three reasons: (a) identical inputs give identical EV — no flicker
between recomputes and no test flakiness; (b) low-discrepancy converges ~O(1/N) vs O(1/√N), so
128 samples behave like thousands of random ones; (c) `shared/strategy` stays reproducible for
the Swift mirror (same sequence, same numbers, fixture-comparable). **Default 128 samples,
13 aim candidates.**

**D15. Candidate sweep default** derives from the club: `sweepDeg = clamp(atan(0.75 ·
dispersionM / carryM), 4°, 15°)` each side of the target bearing (i.e. aim can shift ~1.5 lateral
semi-axes). Callers can override. Ties on score prefer the candidate nearest the target bearing
(don't aim off-line for zero gain).

**D16. Aim scoring carries a tail term from day one.** Per candidate we compute both
`expectedStrokes` (mean) and `tailStrokes` (CVaR₈₀ — mean of the worst 20% of samples), and rank
by `score = expected + riskAversion · (tail − expected)` with **`riskAversion` default 0** (pure
EV — DECADE orthodoxy). This is the `RiskProfile` formulation: one number, 0..1. Computing the
tail now is free (the samples are in hand); retrofitting it later would touch the Swift mirror
twice. The caddy's `no-doubles` rule consumes `tailStrokes` directly instead of inventing its own
risk math.

**D17. Lie classification in the optimiser:** among all containing rings pick the
smallest-area one (handles nesting: green inside fairway); no containing ring → **`rough`**
fallback (mapped holes are rough-bounded in practice; `outside` polygons carry the penalty).
Ring areas and bboxes are precomputed once per `optimizeAim` call; bbox pre-reject before
point-in-ring.

**D18. Baseline table quirks are preserved, and tests must not "fix" them.** The published Broadie
tables are non-monotonic in places (tee 120→140 yd dips; sand has the awkward-distance hump at
60–140 yd; recovery is flat-ish 100–140 yd). These are real features. Monotonicity tests apply to
`fairway`, `rough`, `green` only. Ordering tests: at 135 m sand > rough (the hump), at 18 m
sand < rough (greenside sand is *easier* than greenside rough) — both are correct behaviours.

**D19. Table values need one verification pass.** The anchors encoded in `expected-strokes.ts`
are from Broadie's published PGA Tour tables (converted yd/ft → m) reproduced from memory —
expected accurate to ±0.03 strokes, which does not change any aim decision, but a cheap
(Sonnet-tier) task must cross-check every anchor against the book / published reproductions
before the numbers are shown to users as strokes-gained analytics. Aim *decisions* are robust to
this error band; SG *reporting* is not.

**D20. Boundary conventions:** `shotsToHoleOut(d < 0.05 m, any lie) = 0` (holed). Below the first
anchor of a lie, clamp to the first anchor (a 5 m chip prices as the 18 m value — slightly
pessimistic, calibratable). Above the last anchor, extrapolate linearly along the final segment.
Green table gets one synthetic anchor at 1 ft = 1.00 (from ≤1 ft, pros hole ~100%) so tap-ins
don't price at the 3 ft value.

**D21. Monte Carlo plan scoring (future) ignores shot-to-shot correlation** in v1. Each shot in a
chained simulation samples independently from its dispersion. Documented simplification.

**D22. `pointInRing` moves to a shared export.** `corridor.ts`'s private `pointInRing` is needed
by `aim.ts` (and next by `carry.ts`). Export it from `corridor.ts` and re-export from the index —
one implementation, no drift.

## 5. Two-shot EV chain (par-5 / layup — spec for caddy Phase D)

Locked shape so the implementing model doesn't design it: for each strategy in
{go-in-2, lay-up-to-full-number, lay-back-of-pinch}, EV = `optimizeAim` for shot 1 (club per
strategy) where each sample's value is `shotsToHoleOut(remaining, lie)` — i.e. the chain reuses
the *table* for shot 2+, not a second sampled simulation. Nested sampling (sample shot 2 from
shot 1's outcomes) is explicitly out of scope until Monte Carlo plan scoring (D21) lands. The
strategies differ only in `club` and `targetBearingDeg`/target point; the comparison is therefore
apples-to-apples inside one framework.
