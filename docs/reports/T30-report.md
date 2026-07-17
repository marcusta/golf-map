# T30 report — option chain EV (`scoreOptionChain`) + score chips

Implemented O4 without revisiting the locked decisions. `shared/strategy`
gains the pure chain scorer returning the full triple (`expectedStrokes`,
`tailStrokes`, `penaltyProb`, plus `perLeg`); the web planner renders the
triple as score chips at every multi-sibling decision point, on the map
overlay and in the panel's sibling rows, recomputed only on the existing
strategy enrich cadence. No Swift mirror (per O4). No Monte Carlo whole-hole
distributions (per O4).

## Files touched

- `shared/strategy/option-chain.ts` — new pure module: `ChainLeg`,
  `ChainScoreContext`, `ChainLegScore`, `ChainScore`, `scoreOptionChain`.
  Clubbed legs price through the exact `optimizeAim` path
  `enrichLegStrategy` runs (full sweep, best candidate, riskAversion 0);
  clubless legs are the point estimate `1 + shotsToHoleOut(remaining,
  lie(landing))` with zero tail spread / zero penalty.
- `shared/strategy/option-chain.test.ts` — the par-5 agreement fixture
  pinning all three outputs as goldens, depth-2 goldens, telescoping /
  quadrature / penalty-aggregation identities, point-estimate and
  empty-chain edges, wind passthrough.
- `shared/strategy/index.ts` — exports the new module.
- `web/src/planner/plan-overlay.ts` — `OptionChip`, `buildOptionChips`
  (chains = option shot + rank-0 continuation to the branch leaf),
  `scoreRiskTriple` / `optionChipLabel` (same vocabulary as iOS
  `ScoreRiskFormat.triple`), `option-chip` GeoJSON role +
  `plan-option-chip` symbol layer; `PlanOverlayInput.optionChips` is
  additive/optional.
- `web/src/planner/planner-tool.service.ts` — chips computed inside the
  existing `refreshStrategy` coalesced microtask, stored with the
  `{ base, chips }` guard (same pattern as `enrichedPlan`/`caddyResult`) and
  surfaced via the `optionChips` computed; fed into `buildPlanGeojson`.
- `web/src/planner/planner-panel.component.ts` — `.shot-chip` span per shot
  row (`data-testid="planner-option-chip"`): triple text on decision-point
  rows, blow-up tail in the hover tooltip, hidden (`:empty`) elsewhere.
- `web/tests/plan-overlay.test.ts` — chip builder/format/geojson/cadence
  coverage (8 new tests).
- `web/tests/planner-tool.service.test.ts` — service-level cadence test:
  chips price on the enrich pass, empty out on a drag frame, `enrichCount`
  stays flat.
- `e2e/tests/14-plan-options.spec.ts` — chip assertions in the existing
  driver-vs-4-iron journey (chips on both options, tooltip tail, chipless
  continuation rows, chips survive reload).
- `docs/reports/T30-report.md` — this report.

## Chain semantics (the subtle part, documented in the module header)

- **EV** telescopes: every leg's hole-out EV is priced under table
  continuation; the next authored leg replaces the table estimate at its
  parent's planned landing, so `expectedStrokes = Σ(legEV − baseline) +
  baselineₗₐₛₜ`. A one-leg chain degenerates to
  `1 + aim.best.expectedStrokes` — exactly the par-5 attack rule's two-shot
  chain (its `ev` omits the constant +1 it never needed for ranking).
- **Tail** (CVaR₈₀, D16): per-leg tail spreads compose in quadrature
  (`tail = EV + √Σ spread²`) — independent leg costs' CVaR excess scales
  with total σ, not with the comonotone sum. One-leg chains reduce to
  `1 + aim.best.tailStrokes`, preserving exact par-5 agreement.
- **Penalty**: `1 − Π(1 − legPenaltyProb)` (locked by the brief), leg
  probabilities from `optimizeAim`'s breakdown lie fractions.

## Par-5 agreement fixture result

Shared fixture (single go-in-2 strategy, lateral water inside the D23 stack,
riskAversion 0): `scoreOptionChain` returns exactly
`1 + aim.best.expectedStrokes` / `1 + aim.best.tailStrokes` /
`aim.breakdown.penalty` for the same `optimizeAim` call the rule makes, and
the rule's own advice detail quotes the identical EV
(`prices at 1.95 expected strokes` == `(chain.expectedStrokes − 1).toFixed(2)`).
Goldens pinned: `expectedStrokes 2.9498874708458747`, `tailStrokes
3.3586981801681906`, `penaltyProb 0.015625` (2/128 samples; exact dyadic —
off any half-rounding boundary).

## Tests / verification

Shared, from `shared/` (`bun test`):

```text
 289 pass
 0 fail
 2721 expect() calls
Ran 289 tests across 24 files. [682.00ms]
```

Web, from `web/` (`bun test`; `bun run check:client` completed with no
diagnostics):

```text
 639 pass
 0 fail
 6497 expect() calls
Ran 639 tests across 48 files. [668.00ms]
```

Full E2E (`bun run e2e`, default ports): `21 passed, 1 failed (1.5m)`. The
one failure is the pre-existing cross-spec state leak documented in
T29-report.md (07-furniture-editor adds hole 3 to the shared serial DB;
11-course-list expects the 2-hole seed) — unrelated to T30 and left alone.
The extended 14-plan-options journey (now including chip assertions) and the
03-drag-cadence `enrichCount` regression both passed.

## Deviations from the brief / locked decisions

- None. O1–O6, R1–R8, D1–D27 untouched.

## Under-specified choices

- **Tail composition across legs** (the brief flags "σ compounding, tail
  composition" as the risk): quadrature (root-sum-square) of per-leg tail
  spreads, not the additive comonotone bound — rationale in the module
  header; single-leg chains stay exactly par-5-agreeing either way.
- **An option's chain follows rank-0 descendants** of the option shot (its
  own planned line); nested decision points inside a branch are priced from
  their own chips, not enumerated combinatorially.
- **Leaf→green synthetic legs are NOT chain legs** — the terminal expected
  strokes from the last authored landing already price the approach/putts;
  including the synthetic edge would double-count a stroke.
- **"Tail on hover/expand"**: panel = hover tooltip (`title`); map = the
  SELECTED option's chip label expands with `, blow-up X.X` (selection is the
  map's expand affordance; no new hover machinery).
- **Chip anchor** = the option shot's landing node, label offset below the
  existing `2a`-style node glyph, collision-hidden before overlapping
  (guide §03).
- **`strokesBefore` = tree depth** of the option shot (strokes played to
  reach the decision point), so tee decisions show the pure chain EV.

## For T32 (iOS options consumption) — triple formatting contract

- Web now speaks iOS `ScoreRiskFormat.triple`'s exact vocabulary:
  `prob. %.1f · %d%% pen` with an optional `, blow-up %.1f` suffix
  (`scoreRiskTriple` in `web/src/planner/plan-overlay.ts`). Keep the Swift
  formatter the single source on device; do not fork the wording.
- Probable hole score is `strokesBefore + chain.expectedStrokes` where
  `strokesBefore` = the option shot's tree depth — on-course the analogue is
  strokes already taken on the hole (T33 already does this for decide
  choices).
- Penalty renders as a whole percent from a 0..1 share (`Math.round`;
  Swift `.rounded()` — half-boundary shares are unreachable in practice, all
  sample fractions are /128 dyadics).
- Per O4 there is still NO Swift `scoreOptionChain`; T32 shows authored
  options unpriced or with planner-cached labels and should note the gap.

## Open concerns for the reviewer

- Chip pricing re-runs `optimizeAim` per clubbed option leg on the enrich
  pass (third sweep family after leg enrichment and the caddy). On the
  place/release cadence this is negligible, but if plans ever grow very
  option-heavy the enrichment microtask could share per-leg `AimResult`s
  across the three consumers — an optimisation seam, not a correctness one.
- The known 07→11 E2E state leak remains (T29 report); not touched here.
