# T7 report — DECADE UI (lights, ghost aim, club advice) + deferred-compute wiring

**Task:** DECADE doc Phase D + the "Inherited from T6" live-wiring of
`enrichPlanStrategy`. Make per-leg EV, confidence lights, ghost recommended-aim,
club advice, and computed auto-gates visible in the running planner — computed
on shot-place / drag-release only, never per drag frame.

## Files touched

- `web/src/planner/plan-overlay.ts` — pure additions:
  - `legLight(leg): 'green'|'yellow'|'red'|null` + thresholds
    (`LIGHT_TROUBLE_YELLOW/RED`, `LIGHT_GREEN_HELD`) and colour constants
    (`LIGHT_GREEN/YELLOW/RED_COLOR`). Generic terminology; no DECADE branding.
  - `ghostAimForLeg(leg): GhostAim | null` + `GhostAim` type — projects the
    recommended-aim landing point from the leg origin along
    `recommendedBearingDeg` by `adjustedCarryM`.
  - `buildPlanGeojson`: emits a `ghost-aim` Point per enriched clubbed leg and a
    `light` property on each `leg` feature; `planLayers()` gains a `ghost-aim`
    circle layer and tints the `leg` line by `light` (falls back to the amber
    `LEG_COLOR` when un-enriched / non-approach).
- `web/src/planner/planner-tool.service.ts` — live wiring:
  - Injects `FeaturesService`; adds `lieMap` (Computed over the feature store),
    `enrichedPlan` (Signal of `{ base, enriched }`), `strategyInputs`
    (drag-stable signature Computed), `overlayPlan` (identity-gated enriched/plain
    Computed), `selectedShotGhostAim` (Computed).
  - `refreshStrategy()` — microtask-coalesced `enrichPlanStrategy` runner.
  - Wired at: `placeShot` (after `addShot`), `persistDrag` (shot branch, after
    `updateShot`), `applyRecommendedAim` (after `updateShot`), and a `start()`
    effect subscribing to `strategyInputs`/`lieMap`. `overlayData` now reads
    `overlayPlan`.
  - `generateAutoGates()` — `autoGatesForPlan` over `lieMap.hazardRings()`,
    persisted via `plan.addGate(..., source:'computed')`.
  - `applyRecommendedAim()` — moves the selected shot to its ghost point + persists.
- `web/src/planner/planner-panel.component.ts` — UI:
  - Legs readout reads `overlayPlan`; each approach leg shows a coloured light
    chip (`lightChip`) + `EV x.xx`.
  - Shot rows gain a `shot-advice` line: `clubAdvice()` front/centre/back for the
    leg's plays-like distance (collapses when one club covers all slots).
  - "Apply recommended aim" button (shown when the selected shot has a ghost aim).
  - "Auto gates from hazards" button (calls `generateAutoGates`).
  - CSS for `.leg-light` chips and `.shot-advice`.
- `web/tests/plan-overlay.test.ts` — new `describe` blocks: `legLight`,
  `ghostAimForLeg`, `buildPlanGeojson strategy rendering`, `compute cadence`.

`shared/strategy` untouched. No git operations run.

## Verification (verbatim)

`cd web && bun test`:

```
bun test v1.3.11 (af24e281)

 446 pass
 0 fail
 2468 expect() calls
Ran 446 tests across 28 files. [193.00ms]
```

`bunx tsc --noEmit -p web/tsconfig.json` (from repo root): clean — no output,
exit 0.

## How the per-frame path is guaranteed never to call `optimizeAim`

Three independent guards, all structural (not "we remembered not to call it"):

1. **`buildHolePlan` / `buildPlanGeojson` never optimise.** The per-frame path is
   `applyDrag → patchShotLocal → holePlan recompute → buildPlanGeojson`. None of
   those touch `optimizeAim`/`enrichPlanStrategy`; only `enrichLegStrategy`
   (called exclusively by `enrichPlanStrategy`) does. Tested: a 30-frame drag
   loop asserts no leg ever gets `expectedStrokes/lieBreakdown/recommendedBearingDeg`
   and no `ghost-aim` feature is emitted; a spying `LieMap.surfaces()` records
   **0** reads across per-frame builds but **>0** on `enrichPlanStrategy`
   (surfaces() is on `optimizeAim`'s hot path).

2. **Enrichment is only ever invoked at safe sites.** `refreshStrategy()` is
   called from `placeShot`, `persistDrag` (shot release), `applyRecommendedAim`,
   and one `start()` effect. The effect subscribes to `strategyInputs` — a
   Computed whose value is a signature of `{hole, tee, preferredClub, wind, shot
   ids+clubIds, club ids}` that **excludes shot lat/lon**. A drag frame mutates
   only lat/lon via `patchShotLocal`, so the signature string is unchanged;
   @basics/core `Computed` is `Object.is`-memoized (core.ts:98 —
   `if (!Object.is(self.val, next))`), so the effect is **not notified** and
   `refreshStrategy` is **not scheduled** during a drag. Release re-enriches
   explicitly via `persistDrag`.

3. **The overlay never shows stale strategy mid-drag.** `overlayPlan` renders the
   enriched plan only while `enrichedPlan.base === holePlan` (reference identity).
   A drag frame recomputes `holePlan` into a fresh object, breaking the match →
   the overlay falls back to plain live geometry (marker moves, no stale
   lights/ghost); the next release re-enriches. Tested via the identity-gate unit
   test.

`refreshStrategy` additionally coalesces onto a `queueMicrotask` (same pattern as
`attachHoleFraming`) so a burst of eager signal updates collapses into one
`optimizeAim` sweep over the settled plan (reactive-cascade gotcha).

## Design choices where the brief under-specified

- **"Short-side check" for the lights.** The plan model carries only the green
  centre (no pin geometry — same limitation T6/T9 flagged), so short-side is
  modelled as the *trouble share* of the dispersion pattern (sand + penalty +
  recovery). Thresholds: any penalty OR trouble ≥ 25% → red; trouble ≥ 10% OR
  green-held < 60% → yellow; else green. All three are exported named constants
  for calibration. Lights are emitted for approach legs only (leg lands on the
  green).
- **"Shot-edit popover."** No popover component exists; the shot row (club select
  + label) is the shot editor. Club advice is surfaced as an inline advice line
  under each shot row.
- **Ghost "apply" affordance.** Implemented as a panel button ("Apply recommended
  aim") gated on the selected shot having a ghost — it moves + persists the shot
  to the ghost landing point. Kept off the map (no new click-hit-testing surface)
  to match the existing panel-button idiom.
- **Auto-gates button** placed in the Gates section; it appends computed gates
  (does not clear existing manual gates) via the existing `plan.addGate` path.

## Open concerns for the reviewer

- Light thresholds (25% / 10% / 60%) are first-pass guesses; they want calibration
  against known holes once real course data is exercised (flagged like the σ /
  penalty-model calibration items in the decision register).
- The ghost marker uses `adjustedCarryM` (wind-adjusted nominal carry) as the aim
  distance; if a future change wants the ghost pinned to the actual leg length
  rather than the club's carry, that projection is the one line to revisit in
  `ghostAimForLeg`.
- No `PlannerToolService` DI-harness test exists in the suite (none did before);
  the cadence guarantee is asserted at the pure-function seam plus the
  memoized-signature reasoning above rather than by driving the live service. If a
  service harness lands later, an integration test that spies `optimizeAim` while
  simulating `onMouseMove` frames would be the belt-and-suspenders addition.
- Auto-gates append rather than replace; re-clicking stacks gates. Left as-is
  (matches manual gate placement, which also appends); a "clear computed gates
  first" refinement is a possible follow-up.
