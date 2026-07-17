# T34 report — Capture drivetrain (round loop R5)

## Files touched

- `ios/GolfMap/Screens/OnCourseModel.swift` — NEW section *Tee geofence (round
  loop R5 — prompt-only hole advance)*: `teeGeofenceRadiusM` constant (one
  place, sibling of `Divergence`), observable `teeGeofencePrompt: Int?` +
  `@ObservationIgnored geofenceHandledHole` nag guard, `refreshTeeGeofence()`
  (detection: round active + a next hole + fix within the ring, gated on
  `effectiveUserLocation` so browse mode never fires; leaving the ring re-arms
  the guard), `confirmTeeGeofenceAdvance()` / `dismissTeeGeofencePrompt()`.
  `updateUserLocation` now calls `refreshTeeGeofence()` BEFORE the
  elevation-sampler early-return (so it fires with no terrain sampler);
  `holeDidChange` clears the prompt + guard.
- `ios/GolfMap/Screens/CourseScreen.swift` —
  - `roundLoopStrokes(of:)` now passes `penaltyStrokes` through onto the
    `RoundStroke` snapshot (was dropped — the R4 probable-score baseline + the
    playing state need it; the T33 report noted this as "already wired" but it
    was not).
  - `confirmStroke(holeOut:)` split: the write + auto-advance core moved to
    `recordStrokeAndAdvance(holeOut:) async -> ShotRecord?` — on hole-out it
    calls `model.nextHole()` (auto hole advance, R5); shared by the taps and
    the headless hook.
  - Geofence `.alert` on the content view: "Start hole N?" / "Hole N−1 has no
    hole-out." → Start / Not yet, wired to the model's confirm/dismiss.
  - NEW `-roundLoop 1` headless-verify hook (extends the `roundDebug.lastResult`
    pattern): drives a 3-hole round entirely through the Confirm/Hole-out core
    + the geofence model methods, then dumps scorecard totals + an advance
    trace (and a CAPTURE-DEBUG summary).
- `ios/GolfMapTests/Screens/RoundLoopTests.swift` — NEW, 11 tests (geofence
  detection, browse-mode/last-hole guards, confirm advances + clears, decline
  no-re-nag, leave/re-enter re-prompts, hole-change clears, radius constant).
- `GolfMap.xcodeproj` regenerated via `xcodegen generate` (new test file;
  project is gitignored).

## Test results

Full iOS suite (`xcodebuild … -scheme GolfMap -destination 'platform=iOS
Simulator,name=iPhone 17 Pro' test`):

```
Executed 1036 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.516 (14.759) seconds
** TEST SUCCEEDED **
```

(1025 after T33 → +11 RoundLoopTests. The 2 skips are the same pre-existing
unrelated suites.)

## Headless verify (live, Landeryd Masters, `-openCourse … -planDemo 1 -roundLoop 1`)

`roundDebug.lastResult`:

```
final=h4 shots=7 total=8 vsPar=-3 penalties=1 holesPlayed=3 syncPending=7
trace=h1holeOut->h2>h2geofence=3>h2accept->h3>h3holeOut->h4
```

CAPTURE-DEBUG scorecard (real Masters pars h1=4, h2=4, h3=3):

- H1: full, full(+1 pen), putt → score 4, putts 1, pen 1 (penalty rides on
  stroke 2 — no own row, §2) → **auto-advanced to H2 on hole-out**.
- H2: full, full — **no hole-out**; walked onto H3's tee → geofence prompt
  fired (=3), accepted → advanced to H3. Score 2.
- H3: full, putt → score 2 → **auto-advanced to H4 on hole-out**.
- Total 8 = 7 shots + 1 penalty; vsPar −3; all 7 rows `pending` (offline
  queue — the existing RoundSync flush pushes them when a server is reachable,
  same path `-captureDemo` round-trips).

So the loop drives itself by taps only. No new entries in
`~/Library/Logs/DiagnosticReports/GolfMap*` from the run.

## Deviations / interpretations

1. **Penalty quick-action + one-tap hole-out already existed** in `CapturePanel`
   (penalty stepper in the confirmed state; Hole-out button in aiming). T34's
   delta on them is that hole-out now **auto-advances** the hole. I did not add
   duplicate controls to `DistanceCardView` — the capture panel is the round
   card while capturing (the drivetrain), and duplicating would be gold-plating.
2. **Auto-advance lives in the view** (`recordStrokeAndAdvance` in
   `CourseScreen`), because hole navigation + the capture tool are the view's;
   the model exposes no new "advance" surface. It is covered by the `-roundLoop`
   headless hook (the "3-hole round drives itself" deliverable), matching how
   T31/T33 verified capture-path behaviour. `model.nextHole()` fires
   `holeDidChange` (toolMode → .none) and the `.onChange` on the hole number
   ends the capture panel, so the card returns to the new hole's tee preview.
3. **Last hole doesn't auto-advance** (`if holeOut, model.canGoNext`): on the
   18th hole the confirmed panel stays up and the round is finished from the
   scorecard (unchanged path).
4. **Geofence gates on `effectiveUserLocation`**, so browse mode (GPS off) never
   fires — the geofence models a *physical* walk-on. Radius = 30 m in one place
   (`teeGeofenceRadiusM`).
5. **"N−1 has no hole-out" is structural, not a stored flag.** Hole-out already
   auto-advanced the card, so if we're still on hole N−1 when the fix reaches
   hole N's tee, N−1 genuinely has no hole-out — the prompt condition needs no
   extra bookkeeping. The message reads `model.currentHoleNumber` for "N−1".
6. **Nag guard**: a declined/answered prompt won't re-fire while the fix stays
   inside the ring; leaving and re-entering re-arms it (a genuine re-approach).
7. **`updateUserLocation` ordering**: `refreshTeeGeofence()` had to move ABOVE
   the `guard … elevationSampler` early-return, or it never ran when no terrain
   sampler is installed (every unit test, and any fixless path). Caught by the
   RoundLoopTests going red first.

## Open concerns for the reviewer

- The `-roundLoop` hook self-syncs the playing state
  (`model.setActiveRound(roundLoopStrokes(…))` after each write) because a
  headless `Task` gets no SwiftUI update cycle to fire the `.onChange(shots)`
  that does this in the app. The production taps rely on that `.onChange` (also
  still present) — the explicit call is hook-only.
- The geofence peeks hole N+1's tee by `goToHole(N+1)` then `goToHole(N)` inside
  the hook only (there is no public per-number tee accessor); the real app never
  needs the peek — it just feeds live fixes.

## What T35 / T32 need to know

- **T35 (green handoff):** `recordStrokeAndAdvance` records the hole-out as a
  `.putt` row and advances; green mode (point-in-ring) will co-exist — the
  `.green` derivation still goes ABOVE the past-plan-count decide check (T31/T33
  note stands). `RoundStroke.penaltyStrokes` now actually flows from
  `roundLoopStrokes` (fixed here) — the playing state you build on carries it.
- **T32 (options on course):** no change to the option/decide seams; the
  penalty-through fix means the probable-score baseline is correct once options
  feed `authoredDecideCandidates`.
- The tee-geofence surface (`teeGeofencePrompt`, `confirm/dismiss`) is
  self-contained and prompt-only per R5 — nothing else advances the card off a
  fix.
