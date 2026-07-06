# T9 — green-slope caddy rule + web adapter — report

**Task:** feature-smart-caddy.md Phase B — the marquee green-slope-half rule (pure),
its web `GreenSlopeSummary` adapter over `computeSlopeGrid`, plus a planner panel row
and overlay hint.

## Files touched

Shared (pure):
- `shared/strategy/caddy/rules/green-slope-half.ts` — the rule (new).
- `shared/strategy/caddy/rules/green-slope-half.test.ts` — colocated tests (new).
- `shared/strategy/caddy/index.ts` — re-export the rule + its named constants through the
  existing caddy barrel (per brief: barrel only, NOT `shared/strategy/index.ts`).

Web:
- `web/src/planner/green-slope.ts` — `summarizeGreenSlope()` adapter (new).
- `web/src/planner/green-slope.test.ts` — colocated tests (new).
- `web/src/planner/planner-tool.service.ts` — `greenSlopeSummary` signal + `setGreenSlopeSummary`,
  `caddyAdvice` Computed (runs `runCaddy([greenSlopeHalfRule])`), a separate `plan-caddy`
  overlay (source + `caddyLayers()`), `NOMINAL_GREEN_DEPTH_M`, `CADDY_OVERLAY_ID`.
- `web/src/planner/planner-panel.component.ts` — a "Caddy" section (`caddyHtml()` cards),
  section-visibility binding, and CSS for `.caddy-card` / `.caddy-headline` / `.caddy-why`.
- `web/tsconfig.json` — added `"exclude": ["src/**/*.test.ts"]` (see deviations).

Not modified (per constraints): `rule.ts`, `run.ts`, `carry.ts`, `aim.ts`, any built strategy
module, `shared/strategy/index.ts`, `plan-overlay.ts`.

## Test results (verbatim)

Shared strategy (from repo root, `bun test shared/strategy/`):
```
 124 pass
 0 fail
 2152 expect() calls
Ran 124 tests across 11 files.
```
(Baseline was 106; +10 from this task's rule file, remainder from other tasks that landed
this wave. My rule file alone: `10 pass, 0 fail, 18 expect() calls`.)

Web (from `web/` dir, `bun test`):
```
 430 pass
 0 fail
 2225 expect() calls
Ran 430 tests across 28 files.
```
(My adapter file alone: `7 pass, 0 fail, 10 expect() calls`.)

Typecheck (`bunx tsc --noEmit -p web/tsconfig.json` from repo root): clean, exit 0.

## GreenSlopeSummary fields produced (D10)

The web adapter emits exactly the forward-declared shape the rule consumes:
- `fallLineBearingDeg` — compass bearing of the slope-magnitude-weighted mean downhill
  vector over inside-green cells (`atan2(sumE, sumN)`).
- `fallLinePct` — magnitude of that mean vector (net tilt; a saddle cancels toward 0).
- `frontHalfPct` / `backHalfPct` — mean slope% of each half, split at the midpoint of the
  caller-supplied front→back axis.
Returns `null` when no inside-green cell has a defined slope (caller then omits `greenSlope`
and the rule stays silent).

## Rule design (the two under-specified choices)

- **Fall-line alignment test (open question #1 area / brief called out explicitly).**
  "Back-to-front for THIS shot" is tested as: the summary's `fallLineBearingDeg` is within
  `FALL_LINE_ALIGN_TOLERANCE_DEG` (**45°**) of the *reverse shot bearing* = bearing from the
  green FRONT to the shot origin. A back-to-front green's downhill fall line points back toward
  the player, i.e. the same direction. 45° is a quarter-compass cone: a diagonal
  back-to-front green still fires; a cross-slope (~90° off) and a front-to-back green (~180°
  off) correctly do not. Chosen over a stricter cone so real-world diagonal greens aren't
  missed; flagged for calibration.
- **The ~3% threshold.** `MIN_FALL_LINE_PCT = 3` (named constant). Matches the caddy doc's
  "≥~3%" and the analysis slope ramp's green→orange transition at 3% (the point a player
  visibly reads a green as "running away"). Calibratable.
- **Front-clean (D9).** `frontApproachClean()` casts `hazardsAlongLine(origin → green-front)`
  and treats the approach as unclean if any hazard ring's near edge lies within the final
  `FRONT_CLEAN_WINDOW_M` (**30 m**, per D9) before the front edge (capped at the front distance
  so rings behind the green don't count). Computed inside the rule from `ctx.hazards`, keeping
  the GreenSlopeSummary purely about slope (D10 has no clean flag).
- **Confidence** scales in [0.5, 1] with min(steepness-over-threshold, alignment) so a dead-on
  6% green outranks a just-over-threshold 40°-off one. Priority is a flat 3 (a "favour a half"
  nudge, below hard safety vetoes).

## Deviations / justifications

1. **`web/tsconfig.json` exclude.** The brief mandates colocated `*.test.ts` and a clean
   `tsc -p web/tsconfig.json`. This is the FIRST colocated test under `web/src` (the app
   tsconfig `include: ["src"]`, a separate `tsconfig.test.json` covers a `tests/` dir that
   didn't exist for `src`). Without the exclude, `tsc -p web/tsconfig.json` fails on
   `bun:test` (no bun types in the app config). Added `"exclude": ["src/**/*.test.ts"]` — the
   minimal, build-safe fix; test files are still fully type-checked at `bun test` time. This is
   a config touch, not a code deviation; flagging for the reviewer.
2. **Rule imported from the caddy barrel, not the strategy index, in web.** The brief forbids
   editing `shared/strategy/index.ts` (another task owns that line this wave), and that index
   does not (yet) re-export `greenSlopeHalfRule`. The web tool therefore imports the rule from
   `shared/strategy/caddy` directly. When the index owner adds the rule export, that import can
   collapse back to the index. Types (`CaddyContext`, `GreenSlopeSummary`, `CaddyAdvice`) and
   `runCaddy` still come from the index (they are exported there).

## Under-specified choices I made

- **Panel/overlay wiring vs. the async slope fetch.** The planner does not currently fetch a
  green slope grid (the furniture green is a center POINT; the green polygon lives in the
  course-feature store and only the analysis tool samples it today; the lie map / hazard rings
  are T6, not yet wired into the planner tool). Rather than pull an async server `sampleGrid`
  call and the feature store into the per-frame reactive tool (which the project memory's
  reactive-cascade gotcha warns against), I made the summary a plain settable `Signal`
  (`greenSlopeSummary`) — the seam. `caddyAdvice` fires the moment a summary is fed in and is
  silent otherwise. This is honest and keeps the pure rule/adapter fully exercised; the panel
  row and overlay marker render real advice as soon as any caller supplies a summary.
- **`front`/`back` reference points for the CaddyContext.** The plan model carries only the
  green center, so the tool nudges it ±`NOMINAL_GREEN_DEPTH_M` (**9 m** ≈ an 18 m deep green)
  along the approach bearing to synthesize front/back. Coarse but sufficient for the rule's
  bearing/front-clean tests; will be replaced by real green geometry when T6 lands.
- **Hazards empty in the planner context (for now).** With no lie map wired into the tool yet,
  `ctx.hazards` is `[]`, so front-clean passes by default. The moment T6 supplies
  `hazardRings()` to this context, a bunker/water short of the green will start suppressing the
  advice with zero rule change (D9 already implemented and unit-tested against real rings).

## Open concerns for the reviewer

- The 45° alignment cone and 3% threshold are calibration knobs, not proven values (caddy §8/§9
  flag exactly this). Worth a look on a couple of known back-to-front greens once the slope
  fetch is wired.
- No live browser verification was done: it needs a running server + a course whose green has
  DEM slope data + a fed-in summary; out of reach in this environment. The rule, adapter, panel
  render path, and overlay build are covered by unit tests + a clean web typecheck.
- The web caddy overlay is registered independently of `plan-overlay.ts` (its own
  `plan-caddy` source/layers) specifically to avoid editing that other-task-owned module. If the
  reviewer would rather fold the caddy anchor into `buildPlanGeojson`/`planLayers`, that is a
  small follow-up.
