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

## Generated features (pipeline bulk replace)

Generators (today: the lidar canopy detector, source `lidar-canopy`) replace all of their features for a course in one call. Hand-drawn features have `source = NULL` and are never touched: an empty or blank source is rejected before anything is read.

### Endpoint

`PUT /api/courses/:courseId/features/generated?source=<source>` — cookie-session auth (same as feature create), mounted in both modes (`api/generated-features.routes.ts`, hand-mounted Hono route). One transaction: delete every feature of the course whose `source` equals the query source, insert the body's polygons as course-level features (`hole_id NULL`) at the D26 z-order position for their type, in input order. Response `{ deleted, inserted }`. Errors: 400 (bad body, source mismatch, missing source), 401, 404 (unknown course). Nothing is written on an error.

Body: a GeoJSON FeatureCollection in EPSG:3006.

- `crs` (optional): `{ "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::3006" } }` (or name `EPSG:3006`, or `{ "type": "EPSG", "properties": { "code": 3006 } }`). Anything else, including CRS84/EPSG:4326, is a 400. Absent means EPSG:3006.
- `features[].geometry`: `Polygon` only. Ring 0 is the exterior, later rings are holes. Positions are `[x, y]` in EPSG:3006 metres; the GeoJSON closing point is optional and dropped. Stored as `{"crs":"EPSG:3006","rings":[{"points":[{"x","y"},...]}]}` with straight edges (no `hIn`/`hOut`).
- `features[].properties`:
  - `type` — a `FEATURE_TYPES` value (`trees` for canopy).
  - `source` — must equal the query `source`.
  - `source_ref`, `license` — optional strings (stored on the row; `ODbL` triggers the course attribution).
  - every other key with a string/number/boolean value becomes an `attributes` entry (nulls are dropped; nested values are a 400; at most 32 keys). Canopy trees carry `heightMaxM`, `heightP90M`, `heightMeanM`, `areaM2`.

Body size is the app-wide `BODY_LIMIT` (framework default 1 MB). `dev:server` sets 64 MB and `start:vps` 256 MB; a full canopy export is around 20 MB.

### `attributes` on features

Migration 015 adds nullable `course_features.attributes_json`. The service and API expose it as `attributes: Record<string, number | string | boolean> | null` on read (list, byId, `.geojson` properties), create and update (`null` clears; omitted leaves it untouched). Flat object, at most 32 keys. Clients that never send it keep working and read `null`.

### Script (no HTTP, no auth)

```sh
bun scripts/import-generated-features.ts <courseId> <geojson-path> [--source lidar-canopy] [--db ../data/app.sqlite]
# or: bun run import-generated-features -- <courseId> <geojson-path>
```

Runs migrations, then `CourseFeaturesService.replaceGenerated` against the given sqlite file, printing `deleted`/`inserted`. Same validation and same transaction as the endpoint. Exit 1 with the reason on invalid input.

## Regenerate trees for a site

`MapBuildService.reTrees` (`POST /api/mapbuild/re-trees`, the "Regenerate trees"
item in the Create-mode actions menu) runs `canopy` (with `--trees-out
data/sources/<siteId>/trees.geojson`) and `trees-stems` against the persisted
lidar and DEM, then re-registers the tile manifest. Job kind `trees`, steps
`canopy`, `trees-stems`, `register`. The same steps run from the shell with
`bun run trees:regen -- <courseId|siteId>` (`scripts/regen-trees.sh`). Neither imports
the polygons; use `import-generated-features` for that.

## Register an installed tile manifest

After `trees-stems` updates `data/tiles/<siteId>/manifest.json`, refresh the API's
`course_assets.meta_json`. Apps read this database metadata when discovering assets.

```sh
# cwd = server/; accepts a course id or its shared site id
bun scripts/register-tile-manifest.ts <course-or-site-id> --db ../data/app.sqlite --data-dir ../data
```

The command reads only the fixed installed manifest and its declared stems asset.
It validates stem schema and count, updates existing tile-manifest rows and increments
their versions, or registers a row if absent. Other assets and all tile files remain
unchanged. The pipeline's `generatedAt` remains the cache version used by apps.
