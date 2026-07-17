# T28 report — plan-shot tree migration, service, and API

Implemented O1–O3 and O6 without revisiting the locked decisions. Plan shots
are now a parent-linked tree with sibling-local option ranks, while the API
continues to return a flat shot array carrying `parentShotId`.

## Files touched

- `server/db/migrations/009_plan_shot_options.ts` — adds nullable
  `parent_shot_id` with the self-FK cascade and backfills each old per-hole
  list into a rank-0 primary chain.
- `server/db/migration-009-plan-shot-options.test.ts` — deterministic O1
  round-trip property test across multiple hole/list sizes.
- `server/db/schema.ts` — adds `parent_shot_id` to the Kysely table type.
- `server/db/schema.test.ts` — exercises the additive column in the existing
  plan-shot schema fixture.
- `server/db/import.ts` — imports v1 flat plan locations as a rank-0 chain.
- `server/db/import.test.ts` — pins the imported parent links and sibling
  ranks.
- `server/services/game-plans.service.ts` — flat tree traversal,
  primary-tail append, sibling append/reorder, transactional splice/cascade,
  and `setPrimary`.
- `server/services/game-plans.service.test.ts` — service coverage for
  parent/tail behavior, splice vs cascade, primary promotion idempotence,
  sibling-set validation, flat reads, and option-shot version conflicts.
- `server/api/game-plans.api.ts` — descriptor inputs for `parentShotId`,
  delete mode, and the new `setPrimary` endpoint.
- `shared/api/game-plans.gen.ts` — regenerated typed client.
- `docs/reports/T28-report.md` — this report.

## Tests / verification

From `server/`:

```text
$ tsc -p tsconfig.server.json --noEmit
$ tsc -p tsconfig.test.json --noEmit
```

Both typechecks completed successfully with no diagnostics.

Final `bun test` summary:

```text
 392 pass
 0 fail
 1699 expect() calls
Ran 392 tests across 23 files. [7.38s]
```

API generation completed successfully with `bun run generate` from
`server/`; only `shared/api/game-plans.gen.ts` changed.

## Deviations from the brief / locked decisions

- None.

## Under-specified choices

- `parentShotId: null` explicitly means “append another root option”; an
  omitted value retains legacy behavior and appends below the primary-line
  tail. This distinction is required to author tee-shot alternatives.
- Both delete modes compact the surviving sibling group after removal. For
  cascade this is necessary so deleting rank 0 promotes the next sibling to
  rank 0 and preserves O1/O3 primary-line semantics.
- Duplicate legacy `sort_order` values were not specified. The migration
  uses shot id as a deterministic tie-breaker after old `sort_order`; normal
  legacy rows have unique per-hole orders.
- The v1 importer writes directly to `plan_shots`, bypassing `addShot`, so it
  was updated to create the same rank-0 chain as the migration rather than
  accidentally importing every location as a root option.

## Open concerns for the reviewer

- None. The self-FK cascade is exercised through the real migrated SQLite
  test database in the cascade service test; the backfill ordering itself is
  pinned by the migration helper round-trip property test.
