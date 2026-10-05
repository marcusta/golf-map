# server — AGENTS

Bun + Hono + Kysely + SQLite on `@basics/core`. Source of truth: course data, game plans, rounds, tile/asset serving. Run scripts with **cwd = `server/`**; commands are `package.json` scripts.

## Pointers

- Feature notes (edit history, sites, reference photos, generated-features endpoint and import script, `attributes`, GSPro export server side, regenerate trees, tile manifest, db scripts): [docs/server-features.md](../docs/server-features.md).
- Vegetation zones (attributes, zone types, variants, validation, generator import): [docs/feature-vegetation-zones.md](../docs/feature-vegetation-zones.md) section 12.
- Centerline geometry (roads, paths, kerb fillets): [docs/feature-roads-centerline.md](../docs/feature-roads-centerline.md).
- GSPro export reference: [docs/gspro/export.md](../docs/gspro/export.md). Reference photos design: [docs/feature-reference-photos.md](../docs/feature-reference-photos.md).
- Tests: `services/*.service.test.ts` against a real migrated DB (`createTestDb`, `testing/`), no mocks; see root [TESTING.md](../TESTING.md). Typecheck: `bun run check:server`.

## Rules

- A feature is an api descriptor (`api/*.api.ts`, `create<Feature>Api(svc)`) + service (`services/*.service.ts`) + service test, mounted under `/api`; then `bun run generate` (regenerates `shared/api/*.gen.ts`) after ANY descriptor change.
- Schema changes go through a new numbered migration in `db/migrations/`; an applied migration stays as it is.
- Optimistic locking via `version` columns; `VersionConflictError` maps to 409.
- Tile/asset paths: `assets.service.ts` `resolveTilePath` gives `data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>`; tile routes are unauthenticated.
- DBs (WAL) live in `../data/`: `app.sqlite`, `sessions.sqlite`, `obs.sqlite` (observability bulkhead).

## Gotchas

Full text of the feature-specific ones: [docs/server-features.md](../docs/server-features.md).

- **Migrations folder**: keep test files out of `db/migrations/`. `FileMigrationProvider` `require()`s every `.ts` there during `createTestDb()`, so a `*.test.ts` runs its top-level `describe()`/`test()` on every DB bootstrap and fails unrelated tests with "Cannot call describe()/test() inside a test". Put migration tests one level up in `db/` (e.g. `migration-008-feature-sort-order.test.ts`) and import the migration's exported helpers.
- **Dev server migrations**: `bun --watch` runs a new migration file on `data/app.sqlite` at once. Draft and test it on a copy, wrap it in a transaction.
- **Migration 025 triggers** write `course_feature_history` / `terrain_edit_history` on every write path (editor, reorders, generator bulk replaces, scripts); `FeatureHistoryService` serves `scripts/gspro-bisect.ts`, and the app reads none of it.
- **Feature numbers** (`course_features.feature_no`, migration 026) come from the `courses.next_feature_no` counter via triggers and name the GSPro mesh that Unity keys edits to: each number belongs to its feature for good. Generated rows get none.
- **`generated = 1`** rows are read-only in the editor: the next pipeline run replaces the set wholesale. The replace deletes on `source` AND `generated = 1`, so hand-drawn (`source = NULL`) and imported features survive.
- **`dataDir` is absolute** (made so in `createServices`): pipeline processes run with cwd `pipeline/`, where a relative `./data/...` names nothing.
- **Gspro exports pass `--square-3006`** (the map's inner square, outer = 5 km centred on it) so files overlay exactly.
- **Centerline features**: `create`/`update` REPLACE `rings` with the corridor derived from `geometry.centerline`; the ring consumers need no change.
