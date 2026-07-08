# Delegation briefs — strategy features work plan

**Written 2026-07-06.** Each brief is self-contained: point the assigned model at the brief plus
the referenced docs and it has everything it needs. Model tiers reflect the task's demands —
**Opus** for anything a user sees or an API anyone calls (taste-bound), **GPT-5.5** for
spec-driven math (intelligence-bound, taste-irrelevant), **Sonnet** for mechanical composition
over existing patterns. The design decisions are all pre-made in
[decisions-strategy-2026-07-06.md](decisions-strategy-2026-07-06.md) (D1–D22) — implementing
models must not re-open them.

**Already built (do not redo):** `shared/strategy/lie.ts`, `expected-strokes.ts`, `aim.ts` +
tests (DECADE Phases A+B core), `pointInRing` export (D22), this plan's specs.

**Standing constraints for every brief:**
- `shared/strategy` stays pure/zero-dep, Swift-mirrored, meters + compass-degrees conventions
  (see its `index.ts` header). Callers pre-flatten rings; no I/O in the library.
- Match house style: 4-space indent, single quotes, convention-documenting header comments,
  `bun:test` colocated `*.test.ts`.
- Server work follows the @basics/core descriptor pattern (`api/*.api.ts` + `services/*.service.ts`
  + numbered migration + `bun run generate` for clients).
- No sub-agents when run as an agent (project memory: agents must be told this).

---

## Sequencing

```
T1 (verify tables)  — independent, do first, blocks SG display only
T2 → T3 → T4 → T5   — distances feature chain
T6 → T7             — DECADE web wiring → UI
T8 → T9             — caddy skeleton → slope rule   (independent of T2–T7)
T10, T11            — caddy EV rules, par-5 (after T6)
T12 → T13 → T14/T15/T16 — shot capture chain
T17                 — Swift mirror (any time after its TS sources settle)
T18, T19            — Monte Carlo, yardage book (later)
```

---

### T1 · Verify expected-strokes baseline anchors — **Sonnet**
Cross-check every anchor in `shared/strategy/expected-strokes.ts` against Broadie's published
PGA-Tour tables (*Every Shot Counts*; multiple published reproductions online). The encoded
values are recall-accurate to ~±0.03 (decision D19). Fix any mismatch (source-unit arrays only;
keep the D18 quirks and the synthetic 1 ft green anchor per D20), run
`bun test shared/strategy/`. **Done:** every anchor sourced or corrected; tests green; note in
the file header that D19 verification is complete.

### T2 · `sampleElevations` server endpoint — **Sonnet**
Per [feature-distances-yardages.md](feature-distances-yardages.md) §5.1. Add
`sampleElevations(courseId, points)` beside `sampleGrid` in
`server/services/analysis.service.ts`, reusing `openDem()`/`readDemWindow()`/`bilinearSample`;
no blur; NaN→null. Route `POST /analysis/sample-elevations` + regen client. Tests per §5.1.
**Done:** endpoint + tests green; a sampled point equals `sampleGrid`'s pre-blur value.

### T3 · `carry.ts` + corridor refactor — **GPT-5.5**
Per distances doc §5.2. New `shared/strategy/carry.ts` (`hazardsAlongLine`: all ray↔ring
intersection `t`s, front = min, carry = max); extract the segment-intersection loop shared with
`corridor.ts` `rayRingDistance` (no duplicated math, corridor tests must stay green). Tests per
§5.2 incl. origin-inside-ring → `frontM = 0`. **Done:** both modules share one intersection
helper; all strategy tests green; exports added to `index.ts`.

### T4 · `feature-distances.ts` engine — **Sonnet**
Per distances doc §5.3. Pure glue over `segmentStats`/`windEffect`/`playsAsM`/`clubAdvice`/T3.
Golden-hole fixture test; null-propagation rules per §5.3 exactly (missing wind → `windDeltaM`
null; missing elevation → `playsLikeM` null, `lineM` always present). **Done:** engine + tests
green; exported from index.

### T5 · Distances panel UI + adapters — **Opus**
Per distances doc §5.4 + §4.4. Planner adapters (`Green`/`CourseFeature`/`AimPoint` →
`DistanceTarget[]`), `ServerElevationProvider` (one batched call), sorted panel with separable,
individually toggleable deltas (`148 · +9↑ · +4wind → 6i`). Hazard listing per D5, bearing per
D6. Respect the reactive-cascade gotcha (coalesce derived-geometry effects via queueMicrotask —
see project memory). **Done:** panel renders on a real course; deltas toggle; no per-frame
recompute.

### T6 · DECADE web wiring (lie-map + plan EV) — **Sonnet, Opus review**
Per DECADE doc Phase C. `web/src/planner/lie-map.ts` (flatten features once per hole via
`bezier.ts`, expose `classifyLie` + `hazardRings()`), extend `buildHolePlan()` with
`expectedStrokes`/`lieBreakdown` via `optimizeAim`/`shotsToHoleOut` (compute on shot-place /
drag-release only — D-cadence, DECADE §4.5). Auto-gates from `corridorWidth()` + rings with
`source:'computed'`. **Done:** per-leg EV visible in state; auto-gates generated; drag stays
per-frame-pure.

### T7 · DECADE UI (lights, ghost aim, club advice) — **Opus**
Per DECADE doc Phase D. Green/yellow/red chip per approach leg from `lieBreakdown` thresholds +
short-side check; ghost recommended-aim marker with "apply"; wire `clubAdvice()` into the
shot-edit popover. Generic terminology only (no DECADE branding — DECADE doc §9). **Done:**
lights + ghost aim render from T6 outputs; apply writes shot/gate.

**Inherited from T6 (do this, it was deliberately deferred):** T6 built `enrichLegStrategy` /
`enrichPlanStrategy` / `autoGatesForPlan` in `web/src/planner/plan-overlay.ts` as pure, tested
functions but did NOT wire live call sites — nothing invokes them in the running planner yet, so
EV is not in state. T7 owns that wiring: call `enrichPlanStrategy` on **shot-place and
drag-release only** (in `PlannerToolService.placeShot` / `persistDrag`), NEVER on the per-frame
drag path (`applyDrag`/`patchShotLocal`). This is where the real cadence risk lives — respect the
reactive-cascade gotcha (coalesce derived-geometry effects via `queueMicrotask`; @basics/core
signals are push-based eager). Add the "Auto gates" button that calls `autoGatesForPlan` +
persists `source:'computed'` gates. Verify web tests from the `web/` dir (`cd web && bun test`) —
the DOM preload only loads there; `bun test web/` from repo root gives false DOMParser failures.

### T10 depends on T7's wiring landing first (it consumes the assembled planner `CaddyContext`).

### T8 · Caddy rule-engine skeleton — **Opus**
Per [feature-smart-caddy.md](feature-smart-caddy.md) Phase A + §4. `shared/strategy/caddy/`
(`rule.ts`, `run.ts`, index re-export), one trivial rule, tests: ranking order (D12
priority×confidence), veto removes/demotes, empty context → no advice. `RiskProfile` = the D16
`riskAversion` number. **Done:** evaluator + tests green; no engine dependency.

### T9 · Green-slope rule + adapter — **Opus**
Per caddy doc Phase B. `caddy/rules/green-slope-half.ts` + web `GreenSlopeSummary` adapter over
`computeSlopeGrid` (shape per D10: dominant fall-line + front/back split; front-clean per D9:
`hazardsAlongLine` on the last 30 m, needs T3). Panel row + overlay hint. **Done:** rule tests
per caddy §6-B; advice renders on a hole with a known back-to-front green.

### T10 · EV-backed caddy rules + live caddy context — **Opus**
Per caddy doc Phase C: `short-side-guard`, `no-doubles` (consumes `tailStrokes` per D16),
`take-your-medicine`, `specific-target` over `AimResult`/`shotsToHoleOut`. Each rule one file,
pure, fixture-tested.

**Also owns the caddy's live wiring (deferred by T8/T9):** assemble a `CaddyContext` per leg in
the planner from the outputs that now exist — `enrichedPlan` legs' `AimResult`/`lieBreakdown`
(T7), `featureDistances` (T4), the `greenSlopeSummary` signal + hazard rings (T9 left the seam
settable but unfed), player clubs, wind — and feed `runCaddy(ctx, rules)` into the caddy panel
section T9 stubbed. Same shot-place/drag-release cadence as T7 (reuse `refreshStrategy`; never
per-frame). **Leg contract (locked):** the par-5 second shot must be passed as `leg: 'layup'`
(that is what `par5-attack.appliesTo` checks — T11); a par-4/5 approach is `leg: 'approach'`, tee
shot `leg: 'tee'`, recovery `leg: 'recovery'`. Get this mapping right or rules silently never fire.
**Done:** rules + tests green; caddy advice renders live from the assembled context; green-slope +
par-5 advice (T9/T11) now actually appear in the planner.

### T11 · Par-5 attack rule — **GPT-5.5 (math) per locked spec, Opus (wording)**
Per caddy doc Phase D and **decision D22→§5 of the register** (two-shot chain: table for shot 2+,
no nested sampling). Tests per caddy doc (awkward 42 m loses to full 100 m wedge; go-in-2 only
when `maxCarryM ≥ remaining` and carry clears). **Done:** rule + tests green; headlines reviewed
for tone by Opus.

### T12 · Shot-capture migration + API — **Sonnet**
Per [feature-shot-capture.md](feature-shot-capture.md) §3. Additive migration (rounds:
`game_plan_id`, wind snapshot; shots: `shot_type`, `target_lat/lon`, `penalty_strokes`), extend
rounds service/api/gen-client, service tests. Existing rows stay valid. **Done:** migration +
tests green; client regenerated.

### T13 · iOS capture UI — **Opus**
Per shot-capture doc §4. One-tap capture flow, auto club/type/target defaults, offline queue.
**Done:** a full hole can be captured one-handed in the field; syncs to server.

### T14 · SG computation + follow-up analytics — **Sonnet (math), Opus (views)**
Per shot-capture doc §5, formula verbatim (blocked on T1 for display). Distance-band table is
the headline view. **Done:** per-round SG by category matches hand-computed fixtures.

### T15 · Dispersion fitting job — **SUPERSEDED, do not build**
Superseded 2026-07-07 by [feature-player-model.md](feature-player-model.md) (Phase D), which
absorbs this scope into the full player model (asymmetric two-piece dispersion + personal ES
surface). The median/MAD gating below survives there as the foul-shot router (§6.2).
Original brief kept for reference:
Per shot-capture doc §6 verbatim — sample gating, wind/elevation back-out via shared functions,
median/MAD, k=8 shrinkage, D13 unit conversions. Suggestion UI ("based on n shots — apply?") is
Opus if split. **Done:** synthetic-data tests recover known σ within tolerance; 5-shot case stays
near the prior; applying writes an ordinary club record.

### T16 · Plan-vs-actual view — **Opus**
Per shot-capture doc §7. Per-hole table + overlay (planned ellipse vs actual points). **Done:**
renders for a round linked to a plan.

### T17 · Swift mirror of new strategy modules — **GPT-5.5**
Mirror `lie.ts`, `expected-strokes.ts`, `aim.ts` (+ later `carry.ts`, `feature-distances.ts`,
caddy) function-for-function per the established ios/ mirroring pattern. The D14 deterministic
sampler must produce bit-comparable sequences — share JSON fixtures generated from the TS side.
**Done:** fixture parity tests pass on both platforms.

### T18 · Monte Carlo plan scoring — **GPT-5.5**
After T6. Chain per-shot sampling per D21 (independent shots), report score distribution per
plan; surfaces in the planner as "plan averages X.Y". Spec small enough to design-in-PR, math
per existing `optimizeAim` internals. **Done:** two plans on a known hole rank correctly with a
stable distribution.

### T19 · Yardage-book PDF export — **Opus**
Print-quality per-hole page: geometry render, T4 numbers, slope-grid green detail, plan arrows.
Pure rendering over existing data; taste-driven. **Done:** an A5 booklet PDF for one course that
a player would actually carry.

---

## Reporting protocol (all tasks)

1. **One commit per task**, message starting `T<n>:`. No unrelated changes in the commit.
2. **Write `docs/reports/T<n>-report.md`** (committed with the work) containing:
   - files touched (paths);
   - the verbatim final `bun test` summary line (and typecheck result where relevant);
   - any deviation from the brief or the decision register, with justification;
   - anything the brief under-specified and what you chose;
   - open concerns for the reviewer.
3. **Never amend `docs/decisions-strategy-2026-07-06.md`.** If a decision seems wrong, say so in
   the report and stop rather than working around it.
4. Do not spawn sub-agents.
