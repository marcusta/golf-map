# T32 report — Options on course

## Files touched

- `ios/GolfMap/API/GamePlanModels.swift` — additive, tolerant `parentShotId`
  decoding with presence tracking so an omitted field is distinguishable from
  an explicit `null` root.
- `ios/GolfMap/Store/GamePlanRecords.swift` — persisted `parentShotId` on
  `PlanShotRecord`.
- `ios/GolfMap/Store/AppDatabase.swift` — v9 `planShot.parentShotId` migration,
  including deterministic conversion of the existing flat rows into a single
  parent-linked chain, plus deterministic tree reads.
- `ios/GolfMap/App/GamePlanSync.swift` — maps explicit server trees and upgrades
  legacy responses (all `parentShotId` fields absent) to a root plus rank-zero
  child chain; the existing pending-edit reconciliation guard remains in
  front of every server plan replacement.
- `ios/GolfMap/App/PlanSync.swift` — orders pending local shot creates parent
  before child now that `sortOrder` is sibling rank rather than global depth.
- `ios/GolfMap/Screens/CoursePlan.swift` — retains every tree node, resolves
  ordered children, projects the primary line, and resolves the complete line
  containing a selected option with malformed/cyclic-tree protection.
- `ios/GolfMap/Screens/OnCourseModel.swift` — round-scoped per-hole option
  selection, tee/leg option-chip view models, active-line PlayingState
  resolution, and divergence against the selected line. The selection clears
  when the active round clears and never calls the plan writer.
- `ios/GolfMap/Screens/CourseScreen.swift` — label + club option chips on the
  tee-preview and plan-leg cards, plus the downloaded-course `-planOptions`
  fixture/hook.
- `ios/GolfMap/App/GolfMapApp.swift` — data-independent DEBUG
  `-verifyPlanOptions 1` hook, used when a clean simulator install has no
  downloaded course bundle.
- `ios/GolfMap/Screens/PlanEditStore.swift` — preserves a locally appended
  primary-line shot's parent in GRDB.
- `ios/GolfMapTests/App/GamePlanSyncTests.swift` — proves a refresh carrying an
  option tree cannot replace a dirty local plan edit.
- `ios/GolfMapTests/Screens/GamePlanMappingTests.swift` — legacy absent-field
  conversion plus explicit-tree decode/primary-line parity.
- `ios/GolfMapTests/Screens/PlayingStateTests.swift` — chip content and
  selection, no plan write, active-line divergence, child choice, and
  round-reset coverage.
- `ios/GolfMapTests/Store/GamePlanEditStoreTests.swift` and
  `ios/GolfMapTests/Store/GamePlanStoreTests.swift` — migration and
  `parentShotId` persistence coverage.
- `ios/GolfMapTests/Screens/GamePlanModelTests.swift`,
  `ios/GolfMapTests/Screens/EllipseSelectionAndLabelsTests.swift`, and
  `ios/GolfMapTests/Screens/PlanEditModelTests.swift` — existing linear-plan
  fixtures and writer signatures updated for the additive parent field.
- `docs/reports/T32-report.md` — this report.

No `project.yml` source changed. `xcodegen generate` was run; the generated
`GolfMap.xcodeproj` remains gitignored.

## Test and build results

This task has no Bun-owned source or Bun test target, so there is no applicable
`bun test` summary line or TypeScript typecheck result.

Required simulator build:

```text
** BUILD SUCCEEDED **
```

Final full iOS suite (`xcodebuild -project GolfMap.xcodeproj -scheme GolfMap
-destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`):

```text
Executed 1052 tests, with 2 tests skipped and 0 failures (0 unexpected) in 15.580 (15.954) seconds
** TEST SUCCEEDED **
```

The two skips are pre-existing unrelated tests.

## Headless simulator verification

A clean simulator install was launched with `-verifyPlanOptions 1`. The DEBUG
hook uses the real `CoursePlan.make` and `OnCourseModel` consumption path and
wrote this result to `optionsDebug.lastResult`:

```text
chips=Attack|Driver;Safe line|5 iron selected=true line=safe>safe-next selectedMode=plan(leg:2) primaryMode=decide roundReset=true
```

This proves both chips carry label + club, the tap selects the complete safe
branch, the safe landing remains on-plan only against that branch, the same
landing diverges against the primary line, and ending the round clears the
choice. Verification used the launch-argument result rather than MapLibre
pixels, per the simulator black-frame constraint.

## Deviations / interpretations

1. **No decision deviation.** The implementation follows O4, R2, and R8. It
   does not add a Swift `scoreOptionChain` mirror.
2. **EV remains absent from the chips.** Neither the synced plan model nor the
   local cache carries a precomputed option-chain EV. Computing it on-device
   would violate O4, so the UI intentionally shows label + club only. This is
   the requested EV gap.
3. **Absent and explicit-null parents are different.** An entirely omitted
   `parentShotId` shape is treated as the legacy globally ordered linear plan;
   an explicit `null` is an authored root. A private decode-presence bit keeps
   that distinction without changing the public optional field.
4. **Compatibility projection.** `HolePlan.allShots` owns the tree while the
   existing `HolePlan.shots` property remains the primary-line projection, so
   pre-T32 plan consumers do not accidentally render every branch as a linear
   route.
5. **Active choice is transient round state.** It is kept in memory, keyed by
   hole number, and reset when `setActiveRound(strokes: nil)` ends/clears the
   round. Selection does not mutate GRDB, call `PlanEditWriter`, or trigger
   plan sync.
6. **Missing presentation data degrades locally.** A missing label renders as
   `Option N`; a missing/unresolved club renders as `Club open`. The brief
   requires both fields to be visible and did not prescribe fallback copy.
7. **Clean-install verification needed a fixture independent of course data.**
   Reinstalling the built app replaced the simulator container and removed the
   downloaded bundle needed by the screen-level `-planOptions` hook. The
   additional `-verifyPlanOptions` hook drives the same production model with
   an in-memory course fixture and produces a deterministic persisted result.

## Open concerns for the reviewer

- Option-chain EV cannot appear until the server/cache exposes a precomputed
  value that iOS can consume without duplicating `scoreOptionChain`.
- T33's existing `authoredDecideCandidates` seam remains unchanged. The T32
  brief and its locked references scope authored-option chips to tee/plan-leg
  modes; merging authored branches into the R4 decide ranking is separate
  integration work.
- The existing on-device plan editor still authors only a linear primary-line
  append. T32 preserves and consumes server-authored branches; it does not add
  mobile option authoring or primary switching.
- Removing a server-authored node through the older mobile editor may leave
  its children temporarily orphaned in the local in-memory/cache projection
  until the server's remove-and-splice result is refreshed. Option authoring
  and structural editing were outside this consumption brief.
