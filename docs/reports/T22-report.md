# T22 report — course_features sort_order (D23–D26)

## Files touched

New:
- `server/db/migrations/008_feature_sort_order.ts` — migration: adds `sort_order`, backfills per D25.
- `server/db/migration-008-feature-sort-order.test.ts` — unit tests for the migration's pure helpers (deliberately NOT colocated in `db/migrations/` — see Deviations).
- `server/scripts/t22-lie-comparison.one-shot.ts` — throwaway comparison script (old smallest-area vs new D25 stack order), read-only against `data/app.sqlite`.

Modified:
- `server/db/schema.ts` — `CourseFeaturesTable.sort_order: number`.
- `server/db/seeds/course.ts` — seed's raw `course_features` insert now sets `sort_order`.
- `server/services/course-features.service.ts` — `sortOrder` on `CourseFeature`/GeoJSON properties; `byCourse`/`byHole` order by `sort_order`; new `byGroup()`; `create()` computes D26 insertion position in a transaction (shifts the group's higher rows +1); `geojsonByCourse()` joins `holes` and emits `sortOrder`/`stackKey` per D24; new `reorder(courseId, holeId, orderedIds)`.
- `server/api/course-features.api.ts` — `POST /course-features/reorder` route wired to `svc.reorder`.
- `server/services/course-features.service.test.ts` — D26 insertion-order tests, `reorder` tests (happy path + scope-mismatch error), `geojsonByCourse` stackKey test; two pre-existing raw legacy-row inserts updated with `sort_order` to satisfy the now-required column.
- `shared/api/course-features.gen.ts` — regenerated (`bun run generate`): `sortOrder`/`stackKey` types, `reorder` client method.

## Verification

`tsc -p tsconfig.server.json --noEmit` — clean, no errors.

`bun test .` (from `server/`), final line:

```
348 pass
0 fail
1487 expect() calls
Ran 348 tests across 21 files. [6.02s]
```

## Comparison script output

`bun scripts/t22-lie-comparison.one-shot.ts` run against `data/app.sqlite` (read-only, no writes):

```
db: /Users/marcust/dev/github/golf-map/data/app.sqlite
total course_features: 700
groups with >=2 features: 4
sample query points (centroid-of-feature, >=2 containing features): 310
OLD (smallest-area) vs NEW (D25 stack order) agree: 310/310
mismatches: none
```

Method: for each (course_id, hole_id) group with ≥2 features, sample the polygon centroid of each feature (real flattened bezier/b-spline geometry, `FLATTEN_TOLERANCE_M = 0.25`, same as `analysis.service.ts`). Among features whose flattened outer ring contains that point, OLD picks the smallest real (flattened) area; NEW picks the highest D25 backfill `sort_order` (computed via the migration's own `computeBackfillSortOrders`, driven by raw-control-point area per D25 — no flattening). Full agreement on all 310 sample points across the 4 overlapping groups in this dataset. This matches the analytical expectation: scanning a group in ascending-area order and stopping at the first ring that contains the point is the same operation as picking the smallest-area feature among those containing the point — the two rules only diverge on area ties (broken identically, by `TYPE_Z_ORDER` then `created_at`) or geometries whose containment sets aren't nested consistently with area order. Neither case appears in this dataset (see Open concerns).

## Deviations from brief/decision register

1. **Migration test file NOT colocated in `db/migrations/`, against house convention.** `@basics/core/server/migrate.ts`'s `FileMigrationProvider` (from `kysely`) `readdir`s the migrations folder and `require()`s every `.ts` file in it (excluding `.d.ts`) as a migration candidate, filtering by an `up` export only *after* import. Since `createTestDb()` runs this on every test's setup, a colocated `008_feature_sort_order.test.ts` gets its top-level `describe()`/`test()` calls executed as a side effect of *every other test's* `createTestDb()` call — racing bun's test-runner tracking and throwing "Cannot call describe()/test() inside a test" attributed to whatever test happened to be mid-flight. Confirmed by bisection (removing the file fixes the suite; a trivial single-test file at that path reproduces it; moving the same content out of `db/migrations/` fixes it). Fix: test file lives at `server/db/migration-008-feature-sort-order.test.ts` instead, importing the migration's exported pure functions (`controlPointArea`, `computeBackfillSortOrders`) from `./migrations/008_feature_sort_order`. This is a pre-existing landmine for any future migration wanting a colocated test — worth a project-level note outside this task's scope.

2. **`reorder()` combines two precedents rather than following one exactly.** The brief pointed at `tees.service.ts:164` for the reorder pattern, but that method is a simple transaction loop with no scope validation. Since the brief separately requires validating the incoming id set matches scope exactly, I combined `game-plans.service.ts:501 reorderShots`'s `Set`-based exact-match validation (throwing before any writes) with `tees.service.ts`'s simple per-index update loop. Mismatch throws `ConflictError` (from `@basics/core/server/auth`), consistent with the existing scope-validation convention.

## Under-specified items / choices made

- Comparison script's sample points are feature centroids (one per feature per group), not an exhaustive grid — a pragmatic choice for a one-shot script; it evaluates every group in the current dataset with ≥2 overlapping features but isn't exhaustive coverage of every point in every polygon.
- `reorder`'s error message includes course/hole scope for debuggability; brief didn't specify message content.

## Open concerns for reviewer

- The comparison script found 4 groups with ≥2 features in `data/app.sqlite`, all in full old/new agreement. That's a small, currently well-nested sample — it doesn't exercise the case where OLD and NEW are mathematically capable of diverging (features overlapping without strict containment, where the smallest-area-among-containing-features rule and the global per-group area rank can disagree). Worth re-running this script (or writing a synthetic non-nested fixture) before leaning on "old and new always agree" as an assumption elsewhere.
- `create()`'s D26 insertion shifts every row at or above the insertion position by +1 inside one transaction; this is O(group size) writes per create. Fine at current data volumes (largest observed group in `data/app.sqlite` is small); flag if group sizes are expected to grow much larger.
