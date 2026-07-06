# T12 report — shot-capture migration + rounds API extension

## Files touched

- `server/db/migrations/004_shot_capture_columns.ts` (new migration)
- `server/db/schema.ts` — `RoundsTable` (+`game_plan_id`, `+wind_speed_mps`, `+wind_direction_deg`),
  `ShotsTable` (+`shot_type`, `+target_lat`, `+target_lon`, `+penalty_strokes`)
- `server/services/rounds.service.ts` — `Round`/`Shot` output types, `toRound`/`toShot` mappers,
  `insertRound`/`insertShot` value shapes, `start`/`end` accept an `opts` object
  (`gamePlanId`/`windSpeedMps`/`windDirectionDeg`), `addShot`/`updateShot` accept
  `shotType`/`targetLat`/`targetLon`/`penaltyStrokes`
- `server/api/rounds.api.ts` — `StartRoundInput`/`EndRoundInput`/`AddShotInput`/`UpdateShotInput`
  schemas extended; `fn` wiring passes the new fields through
- `server/services/rounds.service.test.ts` — 7 new tests (defaults, round-trip write/read,
  start/end wind + game_plan_id)
- `shared/api/rounds.gen.ts` — regenerated via `bun run generate` (only this file changed under
  `shared/api/`)

## Migration

`004_shot_capture_columns.ts` — purely additive `alterTable`/`addColumn` calls, matching the
`003_plan_gates_and_hole_wind.ts` style (no `up`/`down` split is used anywhere in this repo's
migrations, so none added here either). Existing rows stay valid:
`shots.shot_type` defaults `'full'` at the DB level, `shots.penalty_strokes` defaults `0`; all
other new columns are nullable.

## Design notes / deviations

- Followed the codebase convention that `Generated<T>` in `schema.ts` is reserved for
  DB-computed timestamps (`created_at`/`updated_at`), not for app-supplied-defaulted columns
  (`version`, `sort_order` are plain `number`). So `shot_type`/`penalty_strokes` are typed as
  plain `string`/`number` in `ShotsTable`, matching that precedent — the service layer supplies
  the default explicitly on insert (`shot_type: input.shotType ?? 'full'`,
  `penalty_strokes: input.penaltyStrokes ?? 0`), same pattern as `version`.
- The brief said "round start/end (or an update) accept `game_plan_id` + the wind snapshot" —
  no dedicated update endpoint exists for rounds today (only `start`, `end`, `remove`), so I
  extended **both** `start` (initial value, e.g. wind read at the first tee) and `end` (settable
  after the fact, e.g. plan linked or wind corrected post-round) via an optional `opts` object on
  each. Both are backward compatible (existing 3-arg `start` calls and existing `end` calls with
  no 5th arg still work unchanged).
- `game_plan_id` has no FK constraint, per the doc's plan-vs-actual framing being a loose link
  (plans and rounds are independent tables; a plan may later be deleted while historical rounds
  remain valid). This mirrors the doc's silence on cascade semantics — flagging as an open
  concern below, not a decision-register item.

## Verification

### Server tests (`cd server && bun test .`)
```
bun test v1.3.11 (af24e281)

 285 pass
 0 fail
 1289 expect() calls
Ran 285 tests across 16 files. [5.24s]
```
All green, including the 7 new T12 tests and all pre-existing rounds/shots tests.

### Web test typecheck (`bunx tsc --noEmit -p web/tsconfig.test.json`)
Only the pre-existing `bun:test`/`Bun` ambient-type errors appear (one `Cannot find module
'bun:test'` per test file + a few `Cannot find name 'Bun'` in `clubs.service.test.ts`,
`features.service.test.ts`, `furniture.service.test.ts`, `plan.service.test.ts`) — these hit
every test file regardless of this change and were present before T12. Filtering those out:
```
$ bunx tsc --noEmit -p web/tsconfig.test.json 2>&1 | grep -v "bun:test\|Cannot find name 'Bun'"
Resolving dependencies
Resolved, downloaded and extracted [2]
Saved lockfile
```
Zero other errors.

**No web fakes needed stubbing.** Searched the web tree for `RoundsApi` usages and any `.rounds.`
API call sites — there are none. The only files referencing `addShot`/`updateShot` in `web/src`
(`planner-tool.service.ts`, `plan.service.ts`, `planner-panel.component.ts`) call the **game-plans**
API's `addShot`/`updateShot` (on `plan_shots`, a different table/service entirely), not the
rounds API. No test fake in the web suite implements `RoundsApi`, so nothing broke and nothing
needed a stub.

### Web app typecheck (`bunx tsc --noEmit -p web/tsconfig.json`)
```
Resolving dependencies
Resolved, downloaded and extracted [2]
Saved lockfile
```
Zero errors.

## Open concerns for reviewer

1. `rounds.game_plan_id` has no FK/referential integrity — acceptable per the doc's loose
   plan-vs-actual link, but flagging in case the reviewer wants an index on it once T16
   (plan-vs-actual view) lands and starts querying by it.
2. `web/src/planner/plan-overlay.ts` and `web/src/planner/planner-tool.service.ts` show as
   modified in `git status` but were **not touched by this task** — they carry pre-existing
   uncommitted changes from earlier work (T6/T7 per delegation-briefs.md sequencing). Confirmed
   via `git diff --stat` that my changes did not add to those files; noting here so the parent
   doesn't attribute those diffs to T12.
3. No dedicated "update round" endpoint exists; `game_plan_id`/wind can currently only be set at
   `start` or via `end`. If a caller wants to link a plan or correct wind mid-round without also
   ending it, that's a future gap — out of scope per the brief's exact field list, not something
   I invented a new endpoint for.
