# server — AGENTS

Bun + Hono + Kysely + SQLite on `@basics/core`. Source of truth: course data, game plans, rounds, tile/asset serving. Run scripts with **cwd = `server/`**.

## Layout

- `api/*.api.ts` — feature API descriptors: each exports `create<Feature>Api(svc)` → `{ method, path, schema, middleware, fn }`. `mount()` (from `@basics/core`) handles validation, coercion, error mapping.
- `services/*.service.ts` (+ `.service.test.ts`) — Kysely-backed logic, one per feature. `geo.ts` = geodesy helpers.
- `db/` — `schema.ts` (16-table Kysely schema), `migrations/NNN_*.ts` (numbered), `seeds/`, `import.ts`, `create-user.ts`, `import-terrain-edits.ts` (generated edits — `golfpipe building-pads` — into a site's `terrain_edits` under one `origin`, replacing that origin's previous generation only; the `water-digs` / `bunker-digs` generators write `dig` edits straight from the course's features, `terrain-generators.service.ts`).
- `main.ts` — app entry (`createApp()` from `@basics/core`).

## Commands (cwd `server/`)

```sh
bun run dev:server      # watch mode; sets DB_PATH etc → ../data/
bun test                # tests
bun run check:server    # typecheck (tsconfig.server.json)
bun run generate        # regen shared/api/*.gen.ts from api/*.api.ts — run after ANY api descriptor change
bun run create-user     # provision a user (no signup endpoint)
bun run import-terrain-edits <site> <pads.geojson>   # generated terrain edits (building pads) into a site, origin-scoped replace
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

Generators (today: the lidar canopy detector, source `lidar-canopy`) replace all of their features for a course in one call. Rows written this way carry `generated = 1` and are the only read-only features in the editor — the next run replaces the set wholesale, so manual edits would not survive. Everything else is editable, including features the GeoJSON import wizard creates from pipeline output: `source`/`source_ref`/`license` (T49) are provenance, not ownership. The replace deletes on `source` AND `generated = 1`, so hand-drawn features (`source = NULL`) and imported ones that share a source id are never touched; an empty or blank source is rejected before anything is read.

### Endpoint

`PUT /api/courses/:courseId/features/generated?source=<source>` — cookie-session auth (same as feature create), mounted in both modes (`api/generated-features.routes.ts`, hand-mounted Hono route). One transaction: delete every generated feature of the course whose `source` equals the query source, insert the body's polygons (as `generated = 1`) as course-level features (`hole_id NULL`) at the D26 z-order position for their type, in input order. Response `{ deleted, inserted }`. Errors: 400 (bad body, source mismatch, missing source), 401, 404 (unknown course). Nothing is written on an error.

Body: a GeoJSON FeatureCollection in EPSG:3006.

- `crs` (optional): `{ "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::3006" } }` (or name `EPSG:3006`, or `{ "type": "EPSG", "properties": { "code": 3006 } }`). Anything else, including CRS84/EPSG:4326, is a 400. Absent means EPSG:3006.
- `features[].geometry`: `Polygon` only. Ring 0 is the exterior, later rings are holes. Positions are `[x, y]` in EPSG:3006 metres; the GeoJSON closing point is optional and dropped. Stored as `{"crs":"EPSG:3006","rings":[{"points":[{"x","y"},...]}]}` with straight edges (no `hIn`/`hOut`).
- `features[].properties`:
  - `type` — a `FEATURE_TYPES` value (`trees` for canopy).
  - `source` — must equal the query `source`.
  - `source_ref`, `license` — optional strings (stored on the row; `ODbL` triggers the course attribution).
  - every other key with a string/number/boolean value becomes an `attributes` entry (nulls are dropped; nested values are a 400; at most 32 keys). Canopy trees carry `heightMaxM`, `heightP90M`, `heightMeanM`, `areaM2`.

Body size is the app-wide `BODY_LIMIT` (framework default 1 MB). `dev:server` sets 64 MB and `start:vps` 256 MB; a full canopy export is around 20 MB.

### Import script (no HTTP, no auth)

```sh
bun scripts/import-generated-features.ts <courseId> <geojson-path> [--source lidar-canopy] [--db ../data/app.sqlite]
# or: bun run import-generated-features -- <courseId> <geojson-path>
```

Runs migrations, then `CourseFeaturesService.replaceGenerated` against the given sqlite file, printing `deleted`/`inserted`. Same validation and same transaction as the endpoint. Exit 1 with the reason on invalid input.

### Centerline geometry (roads, paths)

`geometry.centerline` (`{ points: [{ x, y, corner? }], widthM }`, optional)
makes a feature a centerline feature: `create`/`update` validate it and
REPLACE `rings` (and `curveType`) with the corridor derived by
`shared/features/centerline.ts`, whatever rings the caller sent. Everything
reading rings keeps working; `TerrainGeneratorsService` grades the course's
centerline `path` features as its road lines (and its paved `path` polygons
as planes).

Kerb fillets: every create/update/remove that touches a `path` (and
`removeImported`) re-derives the course's junction fillets
(`shared/features/road-junctions.ts`) into generated `path` features of source
`road-junctions` (`refreshRoadJunctions`, queued per course). A course whose
roads predate this gets them on its next road edit or import. A path's
`kerbFillets` attribute (boolean, validated; `false` = off, absent = on) opts
it out: no corner beside it is rounded; an attributes update re-derives too.
The same features carry the width tapers where a road ends in a narrower one
(made whatever `kerbFillets` says).

### `attributes` on features

Migration 015 adds nullable `course_features.attributes_json`. The service and API expose it as `attributes: Record<string, number | string | boolean> | null` on read (list, byId, `.geojson` properties), create and update (`null` clears; omitted leaves it untouched). Flat object, at most 32 keys. Clients that never send it keep working and read `null`.

## Vegetation zones (docs/feature-vegetation-zones.md, wave 1)

`vegetation_zone` is an ordinary area feature type (appended to `FEATURE_TYPES`
so the web's digit shortcuts keep their bindings; `TYPE_Z_ORDER` puts it above
`green` and below `trees`) with no gameplay meaning — `shared/strategy/lie.ts`
maps it to `rough` explicitly and `shared/render/resolved-surface-stack.ts`
passes it through unclipped, since it is an overlay, not a surface. Its
per-feature fields live in `attributes_json`: `zoneType` (required, the key
into the course's zone-type table), `zoneVariant` (optional string, a variant
key of that type; absent or `''` = the type's Default mix; like `zoneType` not
checked against the table), `weight` (0..1, default 1), `feather` (m,
default 2) and `noise` (m, default 0). The numeric keys may be absent and then
mean their defaults; a zone with no `zoneType` (or a non-string `zoneVariant`)
is rejected on create, on an attributes update and in the generated-features
import (the lidar `lidar-lowveg` proposals, D-VZ7, arrive through that route
with the same property names).
Overlap between zone types is resolved by document order (`stackKey`) — there
is no priority field.

Migration 019 adds `course_zone_types` (the course's legend: `key` unique per
course, `name`, `color`, `texture_index` + `channel` unique per course — four
channels per mask texture — `sort_order` and `items_json`, the VSPro item
bindings `[{ item, minDensity, maxDensity }]` from D-VZ9). `ZoneTypesService`
**seeds the defaults** (`rough_tall`, `shrub`, `fern`, `meadow` on texture
0, channels 0..3, and `woodland_floor` on texture 1 channel 0, D-VZ10) on a
course's first `listByCourse`, so nothing has to run a bootstrap step;
`addDefaults` is the same insert for the panel's button and fills in only the
keys a course is missing (a preset whose slot is taken goes to the first free one). `create` without an explicit slot
takes the lowest free (texture, channel). Migration 022 adds `variants_json`
(`variants: [{ key, name, items }]` on create/update/read): named alternative
item mixes a zone picks with `zoneVariant`; the type's own `items` are the
Default mix. Variant keys match `^[a-z0-9_]+$` and are unique within the type
(a repeat is a `ConflictError`, 409), names are non-empty, items are validated
like `items`; malformed JSON in the column reads as `[]`. Since the zones
export gives every bound item its own mask channel (unity-zones-v2), a type's
`texture_index`/`channel` are legacy: still stored, unique and returned, but
ignored by the pipeline and not shown in the web panel. `bun run zones --`
(`scripts/vegetation-zones.ts`) lists/sets zone variants (`--variant`) and
binds a variant's items (`bind --variant <key>`, creating it if missing).
No `version` column and no optimistic
locking — a short course-level legend, unlike the feature stack. The API
(`/api/zone-types*`) mounts in **both** modes, like the features it belongs to.

## GSPro export (builder only)

`GsproExportService` → `pipeline/gspro.py`. Full reference: [docs/gspro/export.md](../docs/gspro/export.md).

- Folder: `courses.gspro_export_dir` (migration 016); NULL = Downloads (`GSPRO_EXPORT_DIR` overrides). Vreta: `D:\gspro_courses\vreta-opcd`.
- Two squares (`terrain-square.ts`): **inner** = map area, whole-metre edges, side a multiple of 10 m, fixed at map-build time (`manifest.terrain.inner.square3006`); **outer** = 5 km centred on it. Every export passes `--square-3006`, never `--bbox`, so files overlay exactly.
- Jobs: `start`/`job`/`current`, one running per course (409 otherwise); outer fetches run for minutes.
- Kinds and files (`<course>-…`): `svg`; inner ortho `-<collection>-8192.jpg` + `-terrain.jpg` (linear-light darkened twin) + `-meshes.jpg` (tinted, softened), and `-clean-8192.jpg` variants when the request removes buildings / paints forest floor (the panel's separate cleaned export); outer ortho; DEM `-<inner|outer>-dem-<side>m.tif/.raw/.tif.json` (export inner first: outer sidecar needs it); hillshade; trees `-trees.json` (unity-trees-v1); zones `-zones.json` + `-zones-<n>.png`; buildings. Trees/zones/buildings need that terrain's DEM sidecar in the folder (409).
- `dataDir` is made absolute in `createServices`: pipeline processes run with cwd `pipeline/`, so a relative `./data/...` path (`bun run dev` from the root) named nothing there.
- Inner DEM = `dem-edited.tif` else `dem.tif`; outer DEM/lidar/trees are fetched once into `data/sources/<siteId>/outer-*` from Laserdata Skog lidar (`--skip-forbidden`; some tiles 403).


## Regenerate trees for a site

`MapBuildService.reTrees` (`POST /api/mapbuild/re-trees`, the "Regenerate trees"
item in the Create-mode actions menu) runs `canopy` (with `--trees-out
data/sources/<siteId>/trees.geojson` and `--woodland-out` into the job's work dir,
`--woodland-ortho` the active vintage's persisted source when it is on disk, and
`--roofs-out data/sources/<siteId>/roofs.tif`, `ROOFS_SOURCE`, for the orthophoto
export's building removal) and
`trees-stems` against the persisted lidar and DEM, then the `woodland` step (TS, the
server owns the DB) bulk-replaces the course's `lidar-woodland` generated features
with those stands (`WOODLAND_SOURCE`, `CourseFeaturesService.replaceGenerated`:
`vegetation_zone` of zone type `woodland_floor`, D-VZ10; a stand someone deleted
comes back), then re-registers the tile manifest. Job kind `trees`, steps `canopy`,
`trees-stems`, `woodland`, `register`. The same pipeline steps run from the shell with
`bun run trees:regen -- <courseId|siteId>` (`scripts/regen-trees.sh`), which writes
`woodland.geojson` next to `trees.geojson`. Neither imports the tree polygons, and the
script does not import the stands either; use `import-generated-features` for that.

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
