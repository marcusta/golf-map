# T37 report — Close the option-tree loop (cross-task review follow-up)

## Files touched

- `ios/GolfMap/Screens/OnCourseModel.swift` — findings 1 + 4:
  - `DecideChoice.Kind` gains `.option` (authored plan option).
  - `DecideCandidate` gains `target: LatLon?` (the authored option's OWN
    landing — the working target on tap), `authoredShotId` (stable choice id
    `option-<shotId>`) and `authoredLabel` (headline).
  - `authoredDecideCandidates(ball:remainingM:green:)` implemented (was the
    empty T32/T33 seam): enumerates members of >1-sibling groups (real
    decision points, options doc O1) whose landing still advances the ball
    toward the hole, keeps the authored club when its carry fits the ball →
    landing distance (±`LAYUP_TARGET_TOLERANCE_M`), re-clubs via
    `closestClub` otherwise, drops the option when no club fits. Candidates
    enter AHEAD of the engine trio and inherit the existing
    pricing/ranking/vetoes/dedupe/cap pipeline unchanged.
  - Pricing: an authored candidate's `optimizeAim` sweep aims at its own
    landing bearing (still the single-shot Aim.swift path per candidate — no
    chain scorer on device, O4). Headline vocabulary:
    `"<label> <club> → <N> m in"` with the option's own remaining-in figure.
  - `DecideKey` now fingerprints the whole option tree (`allPlanShots`) and
    the current hole's Adjust-mode green-centre override (finding 4).
  - New `capturePlanLandings`: active line first, primary-line projection as
    fallback (finding 2's model seam, unit-testable).
- `ios/GolfMap/Screens/CourseScreen.swift` — finding 2 + hooks:
  - `armCapture`/`rearmCapture` build `planLandings` from
    `model.capturePlanLandings` (selected branch first) instead of the
    primary-line projection.
  - `-decidePick option` picks the first authored option choice (existing
    `-decidePick 1` behaviour unchanged); `-planOptions 2` installs the T32
    option-tree fixture WITHOUT the T32 driver so `-roundState` decide
    scenarios can run against authored options; the `-planOptions 1` driver
    outcome gains a `prefill=branch|primary|other` token proving the prefill
    follows the selected branch.
- `ios/GolfMap/Screens/LaserEntrySheet.swift` — finding 5: the
  `.residualCheck` route now guards on a live GPS fix BEFORE calling
  `registerLaserShot` and shows the `.needsFix` message (same guard shape as
  the `.calibrationShot` path) instead of the misleading near-gate
  "re-shoot" text; the `.needsFix` copy generalised from "calibration shot"
  to "laser shot" since both paths now use it.
- `ios/GolfMapTests/Screens/DecideMomentTests.swift` — option-tree plan
  fixture (surviving "Safe line" sibling + behind-the-ball "Attack" root +
  single-child continuation) and 4 new tests: authored branch appears priced
  and ranked (and ONLY the surviving sibling — not the behind root, not the
  continuation); re-club fallback when the authored carry no longer fits;
  tapped option's own landing becomes the working target and wins capture
  prefill; a moved green-centre override invalidates the decide memo exactly
  once and go re-targets it (finding 4).
- `ios/GolfMapTests/Screens/PlayingStateTests.swift` — 2 new tests:
  `capturePlanLandings` follows the selected option line (and the prefill
  lands on the selected branch, not the primary landing); no-round fallback
  is the primary projection.
- `docs/reports/T37-report.md` — this report.

No `project.yml` change (no new files), so no `xcodegen` needed; built and
tested against the existing generated project.

## Findings — fixed / deferred

1. **Authored options merge into decide (R4)** — FIXED, as above.
2. **Capture prefill honours the active line** — FIXED, as above.
3. **`parentShotId` in the iOS add-shot push** — DEFERRED, per the explicit
   condition in the kickoff instructions: `ios/GolfMap/API/GolfAPIClient.swift`
   is dirty in `git status` (another active session is threading the stimp
   round sync through it), so this item was skipped untouched. The gap
   remains: `AddPlanShotRequest` cannot carry `parentShotId`, so
   offline-added shots append to the server primary tail and can land on the
   wrong branch under a concurrent web `setPrimary`.
4. **`DecideKey` misses adjust-mode overrides** — FIXED (green-centre
   override folded into the key; front/back have no adjust override — the
   green-centre handle moves the CENTER only, so the centre override is the
   only override input the derivation reads).
5. **LaserEntrySheet wrong message without a GPS fix** — FIXED, as above.

## Test results

Full iOS suite (`xcodebuild -project GolfMap.xcodeproj -scheme GolfMap
-destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`):

```text
Executed 1075 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.801 (15.076) seconds
** TEST SUCCEEDED **
```

The 2 skips are the same pre-existing suites. Accounting vs the 1060
baseline: +6 from this task (4 DecideMomentTests + 2 PlayingStateTests), +9
from OTHER active sessions' uncommitted test additions present in this
working tree (4 far-from-course-gate tests in `OnCourseModelTests` and 5 in
the Geo NaN-fix suites) — those ran green here but are not part of this
commit. No Bun-owned source changed, so there is no applicable `bun test`
line.

## Headless simulator verification

Device: iPhone 17 Pro (iOS 26.5), Landeryd Masters
(`26D37361-D79C-41AA-AA49-92F2C2277222`), fresh install of the T37 build.

**Authored option in decide, picked** (`-openCourse … -planOptions 2
-roundState "58.36192,15.70992;58.362506,15.711698" -decidePick option`,
outcome from `roundDebug.lastResult`):

```text
steps=teePreview>teePreview>decide hole=1 strokeIndex=2 lie=recovery currentLeg=nil mode=decide choices=[punch-out:LW@48|prob. 6.5 · 0% pen;layup-full:3h@200|prob. 5.9 · 0% pen;option:4i@185|prob. 5.9 · 0% pen] working=4i@58.36293218555739,15.708637773774731 line=2pts prefillHitsWorking=true
```

The authored option appears in the ranked list (`option:4i@185`), priced
through the same triple as the engine candidates; `-decidePick option` picks
it; the working target is the option's OWN landing
(58.362932, 15.708638 = the fixture's "Attack" root, exactly the authored
point rather than a green-line projection); the distance line collapses to
origin → target and capture prefill reads it first. The divergence position
classified as a recovery lie on the real surface stack, so take-your-medicine
correctly pinned the punch-out first and the option ranked below — ranking
pipeline inherited, not bypassed. A screenshot confirms the decide card
renders the option row highlighted with its banner (map chrome only —
MapLibre composites black in simctl captures, per the standing note).

**Prefill follows the chosen line** (`-openCourse … -planOptions 1`, outcome
from `optionsDebug.lastResult`; the T32 driver extended with the prefill
token):

```text
chips=Attack|Driver;Safe line|5i selected=true line=demo-plan-hole-1-safe>demo-plan-hole-1-safe-next prefill=branch selectedMode=plan(leg:2) primaryMode=decide roundReset=true
```

`prefill=branch`: with the safe option selected and no pin/working target in
play, capture's target prefill is the SELECTED branch's landing. All T32
tokens unchanged.

No new entries in `~/Library/Logs/DiagnosticReports/GolfMap*` across the
runs (20 before, 20 after).

## Deviations / interpretations

1. **"Sibling options at the current decision point" = members of
   >1-sibling groups, survival-filtered geometrically.** With a diverged
   ball there is no matched leg to anchor a single group, so "current" is
   read as "surviving from here" (R4's own parenthetical): an option
   enters when its landing still advances the ball toward the hole.
   Single-child continuations are plan-leg content, not decision
   alternatives, and never enter (fixture-tested). A consequence worth
   knowing: once an option's own landing is behind the ball, its branch no
   longer surfaces in decide even if its continuation is ahead — surfacing
   continuations would need a "which branch am I on" heuristic the specs
   don't define.
2. **Re-club when the authored carry no longer fits.** The plan's club was
   chosen from the option's parent landing, not from a diverged ball;
   pricing a 230 m club at a 106 m landing through `optimizeAim` would be
   dishonest. The authored club is kept when within
   `LAYUP_TARGET_TOLERANCE_M` of the ball → landing distance, else the
   closest fitting club is substituted (same degradation family as the leg
   card's suggested club), else the option is dropped as not executable.
3. **Authored options obey the R4 cap and EV ranking, not a pinned slot.**
   "Enter AHEAD" is implemented as list order (dedupe preference +
   deterministic tie-break), exactly what T33's report specified for the
   seam. Live verify showed a medicine veto out-ranking an authored option —
   intended: wrong ranking is worse than no ranking.
4. **Finding 4 scope**: only the green-centre override is folded into
   `DecideKey` — the brief says "green-centre/front/back through adjust-mode
   overrides", but front/back markers have no adjust override by design
   (the handle moves the CENTER only; front/back keep stored positions), so
   the centre override is the only actual override input. The whole option
   tree (`allPlanShots`) also joined the key since the authored enumeration
   now reads beyond the active line.
5. **Finding 5 fixed at the sheet, not the model.**
   `OriginCalibration.ResidualOutcome` keeps its three cases; the sheet
   guards on `model.userLocation` before routing, mirroring the
   `.calibrationShot` path. No unit test — the sheet is SwiftUI view code
   with no existing test harness (same as the rest of the file); verified by
   build + the identical pre-existing guard pattern.
6. **Live-verify environment quirk (not a deviation):** on device, club sync
   replaced the `-planOptions` demo bag with the real synced bag, so the
   demo plan's authored club ids no longer resolved and the option choice
   exercised the re-club fallback live (authored "Attack" root re-clubbed to
   4i) — a good accident: both the authored-club and re-club paths are
   covered across unit + live verification.

## Working-tree caveat (for the reviewer)

Other active sessions had uncommitted changes in this tree, including in
`OnCourseModel.swift`, `CourseScreen.swift` and `OnCourseModelTests.swift`
(a far-from-course GPS gate) — beyond the files the kickoff instructions
listed. T37's edits live in disjoint regions; the foreign hunks were
snapshotted before work, preserved byte-for-byte, and EXCLUDED from this
commit via index-only reverse-apply, so they remain uncommitted working-tree
changes for their owning session. `git diff` after this commit shows exactly
the foreign hunks and nothing else of T37's.

## Open concerns for the reviewer

- Authored options are priced from the current ball each time — correct per
  O4 (single-shot Aim path) — but the decide list can now show an authored
  label ("Safe line") with a DIFFERENT club than authored (re-club rule).
  The label + club chip renders exactly what would be executed; if that
  reads as confusing on course, a "re-clubbed" hint is a one-line UI tweak.
- The survival filter is purely geometric (advances toward the hole). On a
  sharp dogleg an authored landing can be marginally "backwards" relative to
  the green yet still strategically live; no such hole exists in the current
  course set, so no heuristic was invented (D-register: no new math).
- Finding 3 (deferred) remains a real wrong-branch risk for offline-added
  shots under concurrent web `setPrimary`; it needs a small change in
  `GolfAPIClient.swift`/`PlanSync.swift` once the stimp session lands.
