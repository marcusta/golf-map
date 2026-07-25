# T35 report — Green handoff (round loop R6)

## Files touched

- `ios/GolfMap/Screens/OnCourseModel.swift` —
  - `roundCardMode`: inserted the `.green` derivation ABOVE the past-plan-count
    decide check — `if state.lie == .green { return .green }`. The lie is the
    same point-in-ring classification capture uses, so an approach that finds
    the green hands off to putting even once the stroke count has passed the
    plan (green precedence over divergence — the precedence T31 deferred here).
    `decideContent` still guards on `roundCardMode == .decide`, so green mode
    suppresses the decide choices automatically (T33 note).
  - NEW section *Green handoff (R6 — T35)*: `GreenCard` (distance to hole, the
    captured `ballPosition`, the resolved `holePosition`, and `holeName`) +
    memo-free `greenCard` computed property. Hole = `targets.activePin`, which
    already resolves **today's-pin override ?? furniture active pin** (§3.3),
    closing laser-doc open question 3 — the lasered pin becomes the read's hole.
- `ios/GolfMap/Store/RoundRecords.swift` — `RoundRecord` gains
  `stimpFt: Double?` (snapshotted at round start like wind). LOCAL-ONLY: the
  server rounds schema has no stimp column, so it never leaves the device.
- `ios/GolfMap/Store/AppDatabase.swift` — migration **v8**: `ALTER TABLE round
  ADD COLUMN stimpFt REAL` (nullable → pre-v8 rounds read as "no recorded
  stimp"). No other schema change; **no server migration** (see the server gap
  note below).
- `ios/GolfMap/Screens/RoundModel.swift` —
  - `startRound` gains `stimpFt: Double? = nil`; it resolves the round's green
    speed as **previous round at this course (newest with a recorded stimp) ??
    the caller's app-default seed**, and snapshots it onto the record.
  - NEW `setStimp(_:)`: updates the active round's stimp + persists to GRDB,
    **without flipping `syncState`** (stimp is device-local — a synced round
    stays synced, a stimp tweak never queues a spurious push). No-op when
    unchanged or no round is active.
- `ios/GolfMap/Screens/CourseScreen.swift` —
  - `OnCourseContentView` gains `@Environment(AppEnvironment.self) env` (the
    round-start stimp seed reads `settings.defaultStimpFt`).
  - `enterCapture` passes `stimpFt: env.settings.defaultStimpFt` to
    `startRound` and calls `applyRoundStimp()`.
  - NEW `applyRoundStimp()`: feeds the active round's stimp into
    `PuttReadModel.setStimp` (self-guarded no-op → no loop with the write-back).
    Called from `load()` (initial resume) and the `.onChange(round?.id)` sync.
  - NEW `.onChange(puttRead.stimpFt)`: writes the green view's stimp control
    through to the round record (the one per-round stimp field; persists and
    becomes the next round's default).
  - Green card UI: the `.green` case now renders `roundGreenCard` (distance to
    hole leads, "Read putt" affordance, green tint) instead of the T31
    `EmptyView()` placeholder; a new `onReadPutt` callback on `DistanceCardView`.
  - `enterGreenView(preplaceBall:)` + `readPuttFromGreenCard()`: the green card
    hands off `playingState.ballPosition` as the pre-placed read ball (hole
    stays the resolved active pin — Tier-1 scanned surface / calibration seams
    untouched).
  - `-roundState` hook extended: a `green` token resolves to the hole's real
    green centre (deterministic live green-mode run, no hardcoded coord); in
    green mode the outcome dumps `green=[dist,hole,ball]`, and with
    `-greenPutt 1` it drives the read handoff and reports `readHoleMatchesPin`
    + `aimAt8`/`aimAt12` (a stimp change moving the read's break figure).
- `ios/GolfMapTests/Screens/GreenHandoffTests.swift` — NEW, 11 tests
  (`GreenHandoffTests` ×7 + `RoundStimpTests` ×4).
- `GolfMap.xcodeproj` regenerated via `xcodegen generate` (new test file;
  project is gitignored).

## Test results

Full iOS suite (`xcodebuild … -scheme GolfMap -destination 'platform=iOS
Simulator,name=iPhone 17 Pro' test`):

```
Executed 1047 tests, with 2 tests skipped and 0 failures (0 unexpected) in 14.378 (14.619) seconds
** TEST SUCCEEDED **
```

(1036 after T34 → +11: 7 `GreenHandoffTests` + 4 `RoundStimpTests`. The 2 skips
are the same pre-existing unrelated suites.)

New tests:
- **Green mode derivation** — ball on green → `.green`; green precedence over a
  4-stroke past-plan decide; ball short of the green never enters green mode.
- **Green card content** — hole = furniture active pin by default; a placed
  today's-pin override (`.laser`) wins and IS the read's hole (laser-doc Q3),
  with the source tag + correct distance; hole nil (distance nil) with no pin,
  ball still handed off; nil-round → no card.
- **Per-round stimp** — seed stamped with no prior round; the previous round's
  stimp wins over the seed; `setStimp` persists without flipping `syncState`;
  no-op on unchanged value / no round.

## Headless verify (live)

Environment note up front: the map renders fine on the available simulator
(not black here), and async debug-hook Tasks run (verified: `-spotLevel 1`
opened its sheet). Two limitations blocked the usual `roundDebug.lastResult`
capture, **both pre-existing and unrelated to T35**:

1. Two of three downloaded courses (Landeryd Masters/Classic) now crash on open
   in `OnCourseModel.refreshLadderElevations → TerrainElevationService.elevation
   → WebMercatorTiles.tilePixel` with a NaN→Int trap — a terrain-sampling path
   T35 does not touch. Linkan (browse mode) opens cleanly.
2. On Linkan the T31 **round-context strip does not render with `-planDemo`
   for any mode** (teePreview included — pure T31 scaffolding), and the async
   `UserDefaults` debug hooks (`-roundState`, and the pre-existing
   `-greenView`/`-puttBall`) do not surface their writes to `defaults read` /
   the plist under simctl SIGKILL. So the per-step card-mode dump could not be
   read back this session.

What WAS verified live on device:
- **v8 migration applied** — the real device DB reports migrations `v1…v8` and
  a `stimpFt DOUBLE` column on `round` (`PRAGMA table_info(round)`).
- **RoundRecord + stimp resume, no crash** — inserting a real active round
  carrying `stimpFt = 11.0` (plus a stroke) and opening the course resumes it
  cleanly (`RoundRecord` decodes the new column; the round shows as active),
  exercising the migrated schema end-to-end.

The green-mode logic itself (derivation, card content, pin-override-as-hole,
stimp default/persist/feed) is proven by the 11 new unit tests, which drive the
exact `setPlan` + `setSurfaces` + `setActiveRound` path the app uses.

## Deviations / interpretations

1. **Green mode is a lens over the plan, like every other card mode.**
   `roundCardMode` guards on `!activeLine.isEmpty`, so green mode (like
   tee-preview / plan / decide) only leads the card when the hole has a planned
   line — per the brief ("insert ABOVE the past-plan-count decide check in
   roundCardMode"). With no plan the card is exactly today's, strokes still
   count. The green *view* / putt read remain reachable independently as today.
2. **Hole = `targets.activePin`.** That accessor already implements
   "today's-pin override ?? furniture active pin" (§3.3), so the green card and
   the pre-existing `enterGreenView` share one resolution — a placed pin flows
   into both identically. No new override plumbing.
3. **Stimp write-back does not dirty the round (server-side gap).** The server
   `rounds` schema has no stimp column and `rounds/start` takes no stimp param,
   so per the brief I did NOT add a server migration. `setStimp` persists
   locally and deliberately leaves `syncState` untouched — otherwise a synced
   active round would re-enter the sync queue with nothing the server can store
   (and `RoundSync` only pushes a dirty round's *end*, so it would churn
   forever). **Follow-up for the server side:** if plan-vs-actual/SG ever wants
   green speed, add a `stimp_ft` column to `rounds` + the `rounds/start` body,
   then thread it through `GolfAPIClient.startRound` and `RoundSync`.
   *(Done 2026-07-17: server migration `010_round_stimp` adds `rounds.stimp_ft`;
   `rounds/start` AND `rounds/end` accept `stimpFt`, and `RoundSync` sends it on
   both pushes — the end push carries the final value, so `setStimp` still never
   dirties the round.)*
4. **Green card is not memoised.** Unlike `playingState`/`decideContent` it is a
   thin `Distance.planarMeters` over already-derived values (ball + activePin),
   cheap enough to compute per render — no key/cache needed.
5. **`applyRoundStimp` ↔ `.onChange(puttRead.stimpFt)` don't loop** because both
   `PuttReadModel.setStimp` and `RoundModel.setStimp` self-guard an unchanged
   value.
6. **Tier-1 scanned surface + calibration seams untouched** — the handoff only
   pre-places the ball; `installScannedSurface`/`applyCalibration` still win in
   `enterGreenView` exactly as before.

## Open concerns for the reviewer

- The live terrain-sampling crash on the Landeryd courses
  (`WebMercatorTiles.tilePixel` NaN) is pre-existing and worth a separate look —
  it blocks any live on-course verification on those two bundles.
- The T31 round-context strip not rendering with `-planDemo` on Linkan (and the
  async `UserDefaults` debug hooks not surfacing writes under simctl) is a
  verification-harness gap, not a product regression from T35 (my changes are
  additive to `roundCardMode`/the card and cannot make an existing mode nil).
- `enterGreenView` gained a `preplaceBall:` parameter (defaulted nil) — the
  green-view button path is unchanged; only the green card passes a ball.

## What T32 / T36 need to know

- **T32 (options on course):** the `.green` derivation now sits ABOVE the
  past-plan-count decide check in `roundCardMode` — authored options entering
  `authoredDecideCandidates` still only surface in `.decide`, and a ball on the
  green suppresses the decide card entirely (green wins). `activeLine` is still
  the single stored chain until you swap in the chosen option branch (R8).
- **T36 (one laser entry + residual refresh):** the green card's hole is
  `targets.activePin` (override-first). When a laser places/refreshes a pin
  override mid-round, the green card + the putt-read handoff pick it up on the
  next `targets` read with no extra wiring — the R6/R7 overlap is already live.
  `RoundRecord.stimpFt` + `RoundModel.setStimp` are additive; the laser flow
  doesn't touch them.
- **Server gap (both):** ~~per-round stimp is LOCAL-only (no `rounds` stimp
  column). If a later task wants it server-side, see deviation 3 for the
  thread.~~ Closed 2026-07-17 — stimp now syncs (see deviation 3's addendum).
