# server — AGENTS

Bun + Hono + Kysely + SQLite on `@basics/core`. Source of truth: course data, game plans, rounds, tile/asset serving. Run scripts with **cwd = `server/`**.

## Layout

- `api/*.api.ts` — feature API descriptors: each exports `create<Feature>Api(svc)` → `{ method, path, schema, middleware, fn }`. `mount()` (from `@basics/core`) handles validation, coercion, error mapping.
- `services/*.service.ts` (+ `.service.test.ts`) — Kysely-backed logic, one per feature. `geo.ts` = geodesy helpers.
- `db/` — `schema.ts` (16-table Kysely schema), `migrations/NNN_*.ts` (numbered), `seeds/`, `import.ts`, `create-user.ts`.
- `main.ts` — app entry (`createApp()` from `@basics/core`).

## Commands (cwd `server/`)

```sh
bun run dev:server      # watch mode; sets DB_PATH etc → ../data/
bun test                # tests
bun run check:server    # typecheck (tsconfig.server.json)
bun run generate        # regen shared/api/*.gen.ts from api/*.api.ts — run after ANY api descriptor change
bun run create-user     # provision a user (no signup endpoint)
bun run import          # import v1 export into app.sqlite
```

## Rules

- New feature = api descriptor + service + service test, mounted under `/api`. Then `bun run generate`.
- Service tests run against a real migrated DB (`createTestDb`), no mocks. See root [TESTING.md](../TESTING.md).
- Schema changes go through a new numbered migration in `db/migrations/`. Never edit an applied migration.
- **Never colocate test files in `db/migrations/`.** `FileMigrationProvider` (`@basics/core/server/migrate.ts`) `require()`s every `.ts` file there during `createTestDb()` setup, so a `*.test.ts` in that folder runs its top-level `describe()`/`test()` on every test's DB bootstrap — producing spurious "Cannot call describe()/test() inside a test" failures in unrelated tests. Put migration tests one level up in `db/` (e.g. `migration-008-feature-sort-order.test.ts`) and import the migration's exported helpers.
- Optimistic locking via `version` columns; `VersionConflictError` → 409.
- Tile/asset paths: `assets.service.ts` `resolveTilePath` → `data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>` (`ortho`→jpg, `terrain`→png). Tile routes unauthenticated.
- DBs (WAL): `app.sqlite`, `sessions.sqlite`, `obs.sqlite` (observability bulkhead) — all in `../data/`.
