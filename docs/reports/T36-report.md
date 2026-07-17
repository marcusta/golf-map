# T36 report — One laser entry + opportunistic residual refresh

## Files touched

- `ios/GolfMap/Calibration/LaserInput.swift` — new pure contextual routing
  table (`pinDepth` / `calibrationShot` / `residualCheck` / unavailable) and
  the plain mapped-target `LaserCarryCheck` value.
- `ios/GolfMap/Screens/LaserEntrySheet.swift` — new voice/typed single-number
  UI. It uses the existing Browse target picker, hands bare pin distances into
  `PinEntrySheet`, accumulates uncalibrated mapped shots in the existing
  `CalibrationSession`, and sends live-calibration mapped shots through the
  residual gate. Confirmed residuals close silently; rejected residuals leave
  the stale badge active and show the re-shoot/anchor prompt.
- `ios/GolfMap/Screens/CalibrationSheet.swift` — retired the fulfilled §6.4
  TODO and documents that ambient residual checks now belong to the card's
  one-laser entry; the explicit calibration sheet remains a fresh-solve tool.
- `ios/GolfMap/Screens/OnCourseModel.swift` — contextual laser routing from
  current picked-target/calibration state; corrected-live-fix carry checks;
  opportunistic residual registration; last carry check retained on the card
  for the current hole and cleared on hole change.
- `ios/GolfMap/Screens/CourseScreen.swift` — one Laser affordance on the
  on-course card, carry-check readout, laser-sheet presentation, and a
  `CalibrationSession` retained between fixed-feature shots (reset per hole).
- `ios/GolfMap/Screens/PinEntrySheet.swift` — optional one-time initial phrase
  handoff that runs through its existing parser, solve, draggable confirm and
  commit flow.
- `ios/GolfMap/Voice/PinPhraseParser.swift` — `laserDistance` extraction that
  deliberately reuses the existing parser/tokenizer number path for digits,
  English number words, Swedish compounds and decimal commas.
- `ios/GolfMap/App/GolfMapApp.swift` — DEBUG `-verifyLaserRound 1` hook: 18
  confirming fixed-feature shots at four-minute intervals over a 72-minute
  round, persisted to `laserDebug.lastResult`.
- `ios/GolfMapTests/Calibration/LaserInputTests.swift` — new routing table,
  residual refresh/reject/confidence-floor, periodic-round freshness and
  OnCourseModel carry/residual tests.
- `ios/GolfMapTests/Voice/PinPhraseParserTests.swift` — shared numeric-path
  reuse coverage for typed digits and English/Swedish voice numbers.
- `docs/reports/T36-report.md` — this report.

`ios/project.yml` did not change. `xcodegen generate` was run so the generated,
gitignored Xcode project includes the new production and test files.

## Test and build results

This task has no Bun-owned source or TypeScript typecheck target, so no `bun
test` summary line or typecheck result applies.

Required simulator build (`xcodebuild -project ios/GolfMap.xcodeproj -scheme
GolfMap -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`):

```text
** BUILD SUCCEEDED **
```

Focused T36/parser run:

```text
Executed 13 tests, with 0 failures (0 unexpected) in 0.019 (0.039) seconds
** TEST EXECUTE SUCCEEDED **
```

Final full iOS suite:

```text
Executed 1060 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.541 (14.811) seconds
** TEST SUCCEEDED **
```

The two skips are pre-existing unrelated tests.

## Headless simulator verification

The built app was launched on an iPhone 17 Pro simulator with
`-verifyLaserRound 1`. The hook starts with a trilateration calibration, then
feeds one in-gate fixed-feature residual every four minutes for all 18 holes.
That covers 72 minutes — far beyond the unrefreshed 15-minute zero-trust age —
and exercises `OriginCalibration.registeringResidual` for every shot.

`laserDebug.lastResult`:

```text
holes=18 confirmed=18 fresh=true method=residualRefresh confidence=0.85
```

The normal `simctl spawn ... defaults read` view could not see the app domain
on this clean simulator, so the result was read directly from the app
container's preferences plist (the same persistence the hook writes).

## Deviations / interpretations

1. **No locked-decision deviation.** One card button routes exactly by R7
   context. The T35 green card remains untouched because it already resolves
   its hole through `targets.activePin`; a laser-placed pin therefore continues
   to flow into the green card and putt handoff automatically.
2. **A bare pin number is plausible from 40 through 1200 metres.** The lower
   bound is PinPhraseParser's existing “large bare laser” rule; 1200 m is the
   existing CalibrationSheet rangefinder safety cap. A picked mapped target
   takes precedence, so short fixed-feature observations remain valid.
3. **Carry check = laser / mapped / delta.** It measures the picked target from
   the corrected live fix when calibration clears the confidence floor, and
   from raw live GPS otherwise. It never uses the Browse tee/origin because the
   physical rangefinder shot was taken from the player's current position.
4. **The existing two-threshold residual machine remains authoritative.** At
   or below 2 m refreshes; at or above 4 m rejects/stales; the inherited 2–4 m
   band remains inconclusive and asks for a re-shoot without falsely marking
   stale. T36 wires this state machine rather than replacing its locked tuning.
5. **Trilateration state survives closing the laser sheet.** The
   `CalibrationSession` is card-owned so a player may pick the next mapped
   feature between observations. It resets after applying a solve or changing
   holes.
6. **The initial targeted test launch stalled in Xcode's simulator worker
   materialization before any test executed.** A separate iPhone 17 Pro
   simulator was booted (leaving the already-running device untouched), after
   which both focused and full suites completed normally. This was simulator
   infrastructure, not a code/test failure.

## Open concerns for the reviewer

- “Mapped feature” uses the exact existing calibration fallback picker:
  `browseTarget` from a Browse-mode map tap. It does not snap to or retain a
  semantic feature id; picking accuracy remains the player's responsibility,
  as it was in `CalibrationSheet` before T36.
- The card keeps only the latest carry check for the current hole. There is no
  persistence or shot history by design; origin calibration itself is also
  intentionally in-memory.
- The older full `CalibrationSheet` still exposes its anchor/trilateration
  methods from the control rail. The card has one and only one Laser
  affordance; the dedicated calibration tool remains available for explicit
  setup/recovery.
