# T31 report — PlayingState + card context machine (round loop R1–R3)

## Files touched

- `ios/GolfMap/Screens/OnCourseModel.swift` — new sections *Playing state (on-course round
  loop — R1–R3)* and *Round card modes (R2)*: `RoundStroke` snapshot + `setActiveRound(strokes:)`
  install seam, `Divergence` constants (one place), memoised `playingState` (PlayingKey +
  `playingStateBuildCount`, same self-invalidating fingerprint pattern as `LadderKey`/`HazardKey`),
  `matchedLeg` (R3 nearest-landing-within-radius), `RoundCardMode` + `roundCardMode`,
  `TeePreviewStrip`/`teePreviewStrip`, `RoundLegCard`/`roundLegCard(legIndex:)`,
  `teeHazardThatMatters`, `gateWidthM(near:gates:)`.
- `ios/GolfMap/Screens/CourseScreen.swift` — round-state seed in `load()` +
  `roundLoopStrokes(of:)`; push-based sync in `OnCourseContentView`
  (`.onChange(of: roundModel.round?.id)` / `.onChange(of: roundModel.shots)` →
  `setActiveRound`); `DistanceCardView` round context strip (tee preview / plan leg /
  decide placeholder) leading the card, everything below unchanged; DEBUG `-roundState`
  headless hook + `roundModeDescription`.
- `ios/GolfMapTests/Screens/PlayingStateTests.swift` — NEW, 17 tests (R1 derivation,
  capture-driven advancement, GPS independence, R3 matching/divergence/dispersion scaling/floor,
  past-plan-count, tee grace, lie classification, hole navigation, memoisation, card content).
- `ios/GolfMapTests/Screens/OnCourseModelTests.swift` — 2 nil-round regression tests
  (`testNoActiveRoundExposesNoRoundLoopSurface`,
  `testActiveRoundWithoutPlanKeepsTodaysCardOutputsByteForByte`).
- `GolfMap.xcodeproj` regenerated via `xcodegen generate` (new test file; project is gitignored).

## Test results

Full suite, `xcodebuild … -scheme GolfMap -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`:

```
Executed 1009 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.328 (14.621) seconds
** TEST SUCCEEDED **
```

(2 skips are pre-existing, unrelated suites. Before T31 the suite was 990+; T31 adds 19.)

## Headless verify (live, Landeryd Masters hole 1, `-planDemo 1`)

New hook: `-roundState "lat,lon;lat,lon;…"` installs a synthetic active round on the current
hole stroke by stroke (no GRDB writes), recording the card mode after each step; outcome under
`roundDebug.lastResult` (pinDebug pattern). Observed:

- no strokes → `steps=teePreview … strokeIndex=0 lie=tee mode=teePreview`
- tee capture + capture near the planned landing →
  `steps=teePreview>teePreview>plan(leg:2) … strokeIndex=2 lie=rough currentLeg=0 mode=plan(leg:2)`
- tee capture + capture ~165 m off the landing →
  `steps=teePreview>teePreview>decide … currentLeg=nil mode=decide`
- 4 strokes (past the 2-stroke planned count) →
  `steps=teePreview>teePreview>plan(leg:2)>decide>decide … strokeIndex=4 lie=green mode=decide`

Screenshots confirm all three strips render over the map with the existing banner/pin/strip
(the trust anchor) unchanged below; a launch WITHOUT a round shows today's card exactly.

## Deviations / interpretations (brief under-specified)

1. **Tee-capture grace.** R3 read literally would flip to *decide* right after the tee-shot
   capture (`ballPosition` = the tee, which is > radius from every landing — yet the ball is
   exactly where the plan starts). Within `Divergence.minRadiusM` of the plan tee the mode stays
   `.teePreview` (whose strip *is* leg 1). Constants stay in the one `Divergence` place.
2. **"Passed the planned shot count"** = `strokeIndex > activeLine.count + 1` (one stroke per
   landing + the approach into the green).
3. **Green lie still yields decide when past the plan** (see the 4-stroke run above). R6/green
   precedence is T35's; the `.green` enum case + card slot exist, derivation deliberately doesn't.
4. **No plan content on the hole → `roundCardMode` nil** (card exactly as today). `playingState`
   itself still derives — T34 (capture drivetrain) and T35 (green handoff) need the spine without
   a plan. The mode machine is a lens over the plan per R2's content list.
5. **`activeLine` = the hole plan's single stored chain** until T32 lands the option branch (R8
   noted in the doc comment).
6. **Leg card distances measure from `origin`** (live GPS / browse), not `ballPosition`, so the
   figure counts down as you walk; `ballPosition` drives only matching/mode (R1's capture-driven
   rule — GPS never moves the *state*, proven by `testGPSNeverMovesThePlayingState`).
7. **"The one hazard that matters"** (tee strip) = the farthest carry with a front before the
   planned landing + `hazardExtraAheadM`, not the nearest ring (the nearest was literally a
   bunker at the player's feet, carry 6 m, in the live run).
8. **Gate "at that leg"** = the plan gate nearest the leg's landing (gates are authored per leg;
   there is no stored association).
9. **Wiring is push-based** (`onChange` → `setActiveRound`), mirroring `setPlan`/`setClubs`;
   `RoundModel` itself is untouched.

## Open concerns for the reviewer

- `.plan(legIndex:)` is 1-based over legs (matched landing i → leg i+2, the leg *after* it per
  R1). T33's working target should reuse `RoundLegCard.landing`.
- T35 must insert the `.green` derivation ABOVE the past-plan-count decide check in
  `roundCardMode` (lie is already on `PlayingState`).
- The synthetic `-roundState` hook bypasses `RoundModel` by design (deterministic, no DB
  pollution); `-captureDemo` still covers the real GRDB write path end to end.
- Pre-existing, untouched: `DistanceCardView` carries orphaned members from the card redesign
  (`frontCenterBack`, `clubAdviceRow`, `bottomRow`, `extrasRow`, …) that no body references; and
  the selected-target banner's big number renders as "3…" at some widths in the sim (present
  with no round active — not introduced here).
