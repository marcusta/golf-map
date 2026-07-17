# T33 report — Decide moment + caddy rule ports (round loop R4)

## Files touched

### Part (a) — caddy rule ports, parity-pinned

- `shared/strategy/caddy/rules/can-you-carry-it.ts` — NEW. The §5 carry rule
  (smart-caddy doc): landing window (±5% band, per-club forward wind) vs the
  crossed hazard's `hazardsAlongLine` interval; remedies = club up (shortest
  club whose short miss clears the far edge, within
  `CLUB_UP_MAX_PAST_TARGET_M = 20` of the target) / lay up (longest club whose
  long miss stays short) / plain warning. Penalty hazards outrank sand
  (priority 4 vs 3); risk-weighted; confidence scales with the overlap share.
- `shared/strategy/caddy/rules/can-you-carry-it.test.ts` — NEW, 13 tests.
- `shared/strategy/caddy/index.ts` — barrel export.
- `shared/strategy/generate-swift-fixtures.ts` — `caddy.carry` fixture section
  (7 cases through the shared `ruleFixture` harness).
- `ios/GolfMapTests/Strategy/Fixtures/strategy-goldens.json` — regenerated with
  `bun generate-swift-fixtures.ts` (642 added lines, zero changed lines —
  purely additive; never hand-edited).
- `ios/GolfMap/Strategy/Caddy/CanYouCarryItRule.swift` — NEW, faithful mirror.
- `ios/GolfMap/Strategy/Caddy/CaddyRules.swift` — registered in `caddyRules()`.
- `ios/GolfMapTests/Strategy/CaddyGoldenParityTests.swift` — `carry` fixture
  decode + `testCanYouCarryItMatchesTS` + constant-parity test.

### Part (b) — decide-mode assembly + card UI + working target

- `ios/GolfMap/Screens/OnCourseModel.swift` —
  - `RoundStroke` gains `penaltyStrokes` (default 0) so the R4 probable-score
    baseline counts penalties; `setActiveRound` clears the working target when
    the stroke list changes; `holeDidChange` clears it too.
  - NEW section *Decide moment (R4 — T33)*: `DecideChoice` (kind / headline /
    club / target / distance / probableScore / penaltyShare / tailScore +
    `triple` via the shared formatter), `DecideContent` (≤3 choices + top
    caddy headline), `decideContent` memoised on `DecideKey` (hole, strokes,
    plan line, surfaces/hazards versions, bag, wind, competition flag — the
    ball only moves on capture, so recompute is capture-driven, never
    continuous), `authoredDecideCandidates()` (the T32 merge seam, returns
    `[]`), `buildDecideContent` (engine trio go / lay-up-to-full-number /
    lay-back-of-pinch from the actual ball, + recovery punch-out, + a
    longest-layup fallback; one `optimizeAim` sweep per candidate over the
    installed surface stack; one `CaddyContext` from the ball through
    `runCaddy(caddyRules())`; veto-driven reordering; cap 3).
  - NEW section *Working target*: `WorkingTarget`, `selectDecideChoice`
    (tap-again toggles off), `clearWorkingTarget`; the working target owns
    `selectedLadderRow` (banner + advice ellipse + wind hold = the ghost aim,
    with the CHOICE's club, not a re-derived closest club), the overlays
    distance line (`[origin, target]`), and terrain elevation sampling.
- `ios/GolfMap/Screens/ScoreRiskFormat.swift` — NEW. THE one triple formatter
  (`"prob. 4.1 · 1% pen"` / `"prob. 3.9 · 18% pen, blow-up 5.6"`), for decide
  choices now and option chips in T32.
- `ios/GolfMap/Screens/ShotCapture.swift` — `defaultTarget` gains a leading
  `workingTarget: LatLon? = nil` that wins over pin/plan/green (T34 formalises
  the rest of the order).
- `ios/GolfMap/Screens/CourseScreen.swift` — decide card UI (ranked tappable
  choice rows: club chip + headline + triple + distance, working highlight,
  caddy "why" line; placeholder remains for competition/degraded states);
  `armCapture`/`rearmCapture` pass the working target; `-roundState` hook
  extended: decide mode appends `choices=[kind:club@dist|triple;…]`, and
  `-decidePick 1` taps the top choice and reports
  `working=… line=…pts prefillHitsWorking=…`.
- `ios/GolfMapTests/Screens/DecideMomentTests.swift` — NEW, 14 tests (golden
  hole: T31's synthetic course + 6-club bag + green/trees surfaces + mid-line
  bunker): off-plan ⇒ ≤3 sane EV-ranked choices; par-5-trio shape (go targets
  green centre); shared-formatter triple; penalties shift probable score by
  exactly 1; recovery lie promotes punch-out and demotes go (veto path);
  working-target tap → distance line / banner club / ghost ellipse / capture
  prefill; toggle-off; capture consumes; hole change clears; competition mode
  withholds; nil-round regression; memoisation; formatter vocabulary.
- `GolfMap.xcodeproj` regenerated via `xcodegen generate` (three new files;
  project is gitignored).

## Test results

Shared TS (`cd shared && bun test`):

```
 279 pass
 0 fail
 2695 expect() calls
Ran 279 tests across 23 files. [587.00ms]
```

(70 of those are the caddy files — 57 before T33, +13 new.) `bunx tsc
--noEmit` in `web/` (which compiles `shared/`): clean.

Full iOS suite (`xcodebuild … -scheme GolfMap -destination 'platform=iOS
Simulator,name=iPhone 17 Pro' test`):

```
Executed 1025 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.311 (14.567) seconds
** TEST SUCCEEDED **
```

(1009 after T31 → +16: 14 DecideMomentTests + 2 new CaddyGoldenParityTests.
The 2 skips are the same pre-existing unrelated suites.)

## Headless verify (live, Landeryd Masters hole 1, `-planDemo 1`)

`-roundState "<tee>;<off-plan>" -decidePick 1`, outcome from
`roundDebug.lastResult`:

- Reachable divergence (ball ~154 m off the landing, 132 m out):
  `…mode=decide choices=[go:8i@132|prob. 5.0 · 0% pen, blow-up 5.6]
  working=8i@58.36394…,15.70735… line=2pts prefillHitsWorking=true` — the tail
  renders exactly where the gap crosses the no-doubles gate, the working
  target is the green centre, the distance line collapses to origin→target,
  and capture prefill reads it first.
- Out-of-reach divergence (~267 m out): `…choices=[layup-full:6i@167|prob. 5.9
  · 0% pen;lay-back:9i@125|prob. 6.0 · 0% pen] working=6i@… line=2pts
  prefillHitsWorking=true` — no go without a reaching club; the full-number
  layup and the lay-back short of a real pinch rank by probable score.
- On-plan control (capture at the planned landing):
  `…currentLeg=0 mode=plan(leg:2)` with no decide tokens — T31 behaviour
  byte-identical.

No new entries in `~/Library/Logs/DiagnosticReports/GolfMap*` across the runs.

## Deviations / interpretations

1. **take-your-medicine and short-side-guard were already ported** (commits
   9f231e1e/c387077d, parity-pinned in `CaddyGoldenParityTests`). The brief's
   list of three ports reduced to one real gap: `can-you-carry-it`, which
   existed on NEITHER side — I authored the TS rule per smart-caddy §5 first,
   then extended goldens and mirrored. Existing ports untouched.
2. **`can-you-carry-it` is registered in the iOS `caddyRules()` but not in the
   web `CADDY_RULES`** — web wiring is smart-caddy Phase E, and
   `web/src/planner` belonged to the active T29 session. Noted in the
   `CaddyRules.swift` doc comment.
3. **Rounding-parity trap avoided by fixture choice**: JS `toFixed(0)` rounds
   half away from zero, Swift `%.0f` half to even, so a 150 m club (band edge
   exactly 142.5/157.5) would have broken string parity. Golden clubs use
   152/166 to keep every formatted figure off the .5 boundary. Worth knowing
   for future rules that format club-band numbers.
4. **Punch-out EV is priced by the aim sweep, not medicine's punch model.**
   The punch-out candidate (recovery lie) prices through the same
   `optimizeAim` as everything else (full escape-club carry), which is
   slightly optimistic vs the medicine rule's 0.6-fraction escape. Ranking is
   still correct because take-your-medicine's firing pins the punch-out first
   regardless of EV. A dedicated punch pricing would be new math on device —
   out of scope by the O4/no-new-math rule.
5. **Veto → candidate mapping**: `runCaddy` vetoes name RULE ids, not
   candidates. The decide assembly interprets "any emitted advice that vetoes
   `specific-target`" (medicine / short-side / no-doubles all do) as "don't
   fire at it" and demotes the GO candidate to last; medicine firing
   additionally puts the punch-out first. This is the smallest faithful
   reading of "caddy rules rank and veto" over engine candidates.
6. **Probable score counts penalties** via the new
   `RoundStroke.penaltyStrokes` (wired from `RoundModel.shots` in
   `roundLoopStrokes`); strokes taken = captures + penalties on the hole.
7. **"Go — 178 plays 186"** uses the wind plays-as on the remaining distance
   only; ball elevation is unknown between captures (no synchronous DEM
   sample), so slope is not folded into the headline figure. The banner's
   plays-as (after tapping the choice) does sample terrain asynchronously,
   same as layup rungs.
8. **`decideContent` is nil in competition mode** (EV + club choice is advice
   — the `planCaddyAdvice` gate); the card then shows T31's placeholder. The
   mode machine itself is untouched.
9. **Choice list can legitimately be 1 long** (reachable green, no rankable
   layup within the ±18 m club tolerance, no pinch) — observed live. The
   longest-layup fallback only kicks in when the trio yields nothing.

## Open concerns for the reviewer

- The engine trio reuses par5-attack's public constants
  (`FULL_NUMBER_LAYUP_M`, `LAY_BACK_OF_PINCH_BUFFER_M`,
  `LAYUP_TARGET_TOLERANCE_M`) on every hole, not just par 5s — deliberate (R4
  names the trio shape), but it means tuning those constants moves both
  surfaces.
- `hazardsAlongLine` for the lay-back pinch runs over ALL installed hazard
  rings (not hole-scoped); on parallel-hole layouts a foreign greenside trap
  exactly on the line would count as a pinch. The carries card has
  ownership/corridor logic that could be reused if this shows up on course.
- Working-target banner title is the choice headline verbatim; at very narrow
  widths it truncates (lineLimit 1), same as other banner titles.

## What T34 / T35 / T32 need to know

- **T34 (capture drivetrain):** `ShotCaptureDefaults.defaultTarget` already
  takes `workingTarget:` as the FIRST slot — extend the order behind it. The
  working target self-clears when `setActiveRound` sees a changed stroke list,
  so capture → advance → clear needs no extra call. `RoundStroke` now carries
  `penaltyStrokes`; keep `roundLoopStrokes` passing it (already wired).
- **T35 (green handoff):** insert the `.green` derivation ABOVE the
  past-plan-count decide check (unchanged T31 note); `decideContent` guards on
  `roundCardMode == .decide` so green mode automatically suppresses choices.
- **T32 (options on course):** merge authored options in
  `OnCourseModel.authoredDecideCandidates(remainingM:)` — they enter AHEAD of
  the engine candidates and inherit pricing/ranking/dedupe/cap for free.
  Option chips must format their triple through `ScoreRiskFormat.triple`
  (Screens/ScoreRiskFormat.swift) — it is THE shared formatter (R4/O4).
