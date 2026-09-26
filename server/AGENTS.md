# server — AGENTS

Bun + Hono + Kysely + SQLite on `@basics/core`. Source of truth: course data, game plans, rounds, tile/asset serving. Run scripts with **cwd = `server/`**.

## Layout

- `api/*.api.ts` — feature API descriptors: each exports `create<Feature>Api(svc)` → `{ method, path, schema, middleware, fn }`. `mount()` (from `@basics/core`) handles validation, coercion, error mapping.
- `services/*.service.ts` (+ `.service.test.ts`) — Kysely-backed logic, one per feature. `geo.ts` = geodesy helpers.
- `db/` — `schema.ts` (16-table Kysely schema), `migrations/NNN_*.ts` (numbered), `seeds/`, `import.ts`, `create-user.ts`, `import-terrain-edits.ts` (generated edits — `golfpipe building-pads` — into a site's `terrain_edits` under one `origin`, replacing that origin's previous generation only).
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

## Sites

A site owns the map; courses link to it through `courses.site_id` and several courses can share one site. `GET /api/sites/overview` returns every site with its courses and the bbox and time of its last succeeded `build` job (`SitesService.overview`, used by the web `/sites` page and the new-course wizard). `SitesService.remove` throws `ConflictError` (409) while any course is attached: detach or move the courses first. The build API is still addressed by course. `MapBuildService.resolveSiteId` creates a site named after the course only when the course has none, so the wizard creates the site first and passes `siteId` to `courses.create`.

## Reference photos

On-course photos with pose metadata ([docs/feature-reference-photos.md](../docs/feature-reference-photos.md) §5). Table `site_photos` (migration 016), `PhotosService`, descriptor API `photos.api.ts`, raw routes `photos.routes.ts`.

- `POST /api/photos/create` is idempotent by `id` and returns the stored row on a repeat. `list`, `get`, `update` (tags, note, hole; version-locked) and `remove` (row plus both files) complete the descriptor API. Both modes, session auth.
- `PUT /api/photos/file/:id?kind=original|preview` takes a raw body and `X-Content-SHA256`. It streams to `data/photos/.incoming/`, then renames to `data/photos/<siteId>/<id>.heic|.jpg`. Responses: 200 `{status: 'stored'|'unchanged', photo}`, 400 hash mismatch or missing header, 404 unknown id, 409 different hash already stored, 413 over 20 MB. File arrivals do not bump `version`.
- Builder pull, serve mode only, `PUBLISH_TOKEN` bearer: `GET /api/ingest/photos?since&limit`, `GET /api/ingest/photos/file/:id?kind`, `POST /api/ingest/photos/ack {ids}`. The cursor is `upload_seq` as a decimal string ("0" = start). `upload_seq` is set to `MAX+1` when the original arrives, when a later preview arrives, and on a metadata edit, so a photo re-lists after each change.
- `bun run photos-pull [--reset]` (`services/photos-pull.ts`) needs `PUBLISH_URL` and `PUBLISH_TOKEN`. The cursor lives in `data/photos/pull-state.json`. The pull never overwrites the local `refined*` fields. A photo whose site is missing locally is reported and not acked; create the site, then rerun with `--reset`. The builder server runs the same pull every `PHOTOS_PULL_INTERVAL_MIN` minutes when that and `PUBLISH_URL` are set.
- Serve mode runs retention at boot and daily: originals are deleted 14 days after the first ack (`pulledAt`), `originalDeletedAt` is set, the row and preview stay.
- No FK to `sites`. `CONTENT_BLOCKER_REFERENCES` in `services/bundle.ts` blocks an ingest that would delete a site with photos. `SitesService.remove` does not check photos yet.

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

### `attributes` on features

Migration 015 adds nullable `course_features.attributes_json`. The service and API expose it as `attributes: Record<string, number | string | boolean> | null` on read (list, byId, `.geojson` properties), create and update (`null` clears; omitted leaves it untouched). Flat object, at most 32 keys. Clients that never send it keep working and read `null`.

## Vegetation zones (docs/feature-vegetation-zones.md, wave 1)

`vegetation_zone` is an ordinary area feature type (appended to `FEATURE_TYPES`
so the web's digit shortcuts keep their bindings; `TYPE_Z_ORDER` puts it above
`green` and below `trees`) with no gameplay meaning — `shared/strategy/lie.ts`
maps it to `rough` explicitly and `shared/render/resolved-surface-stack.ts`
passes it through unclipped, since it is an overlay, not a surface. Its four
per-feature fields live in `attributes_json`: `zoneType` (required, the key
into the course's zone-type table), `weight` (0..1, default 1), `feather` (m,
default 2) and `noise` (m, default 0). The numeric keys may be absent and then
mean their defaults; a zone with no `zoneType` is rejected on create, on an
attributes update and in the generated-features import (the lidar `lidar-lowveg`
proposals, D-VZ7, arrive through that route with the same property names).
Overlap between zone types is resolved by document order (`stackKey`) — there
is no priority field.

Migration 019 adds `course_zone_types` (the course's legend: `key` unique per
course, `name`, `color`, `texture_index` + `channel` unique per course — four
channels per mask texture — `sort_order` and `items_json`, the VSPro item
bindings `[{ item, minDensity, maxDensity }]` from D-VZ9). `ZoneTypesService`
**seeds the four defaults** (`rough_tall`, `shrub`, `fern`, `meadow` on texture
0, channels 0..3) on a course's first `listByCourse`, so nothing has to run a
bootstrap step; `addDefaults` is the same insert for the panel's button and
fills in only the keys a course is missing. `create` without an explicit slot
takes the lowest free (texture, channel). No `version` column and no optimistic
locking — a short course-level legend, unlike the feature stack. The API
(`/api/zone-types*`) mounts in **both** modes, like the features it belongs to.

## GSPro export (builder only)

Migration 016 adds nullable `courses.gspro_export_dir` — the folder `GsproExportService` writes the course's OPCD SVG, orthophoto JPEGs and DEM GeoTIFFs into. NULL means the OS Downloads folder (`GSPRO_EXPORT_DIR` overrides the server-wide default), so an untouched course needs no row and the default can move without a data migration. Mounted only in `builder` mode: it writes to an operator-chosen path and needs the pipeline, neither of which exists on the VPS.

**Terrain squares** (`terrain-square.ts`). A GSPro course is two squares in EPSG:3006 metres: the **inner terrain** — the map area, its side always a whole multiple of `TERRAIN_SIDE_STEP_M` (10 m: 2010 m, never 2009.37 m) on whole-metre edges — and the **outer terrain**, `OUTER_TERRAIN_SIDE_M` (5 km) centred on the inner (or inner + 1 km margin all round when the inner is too big for 5 km). The inner square is derived ONCE, at map-build time, from the drawn WGS84 area (`innerSquareFromWgs84`: corner-reprojected envelope, longer side snapped to the nearest 10 m, centred) and is what `grid-dem --bbox-3006` cuts the DEM to — so the tile manifest's `bounds` are that square's WGS84 envelope and the build writes it verbatim as `manifest.terrain.inner.square3006` (+ `sideM`; `refreshManifestAsset` carries it through re-terrain/trees). `resolveCourseMapBbox` returns it as `terrainSquare`; the exports render over it and derive the outer with `courseTerrainFor`. A site built before that field existed (or a georeference-bbox course) gets its bounds squared and snapped the same way on the fly. The web picker snaps to the same 10 m step in its own approximate metres, but the server's square is the authority.

**Jobs.** Every export runs through `start(courseId, request)` → `GsproExportJob` (`running`/`succeeded`/`failed`, in memory, one running per course — a second `start` is a 409 naming the running one; `job(id)`, `current(courseId)` = running else latest finished; `whenIdle` for tests), because the fetch-first exports (outer ortho: nine 700 MB tiles; outer DEM; outer trees) run for minutes and a request that timed out in the browser left the operator guessing. The API exposes only `start`/`job`/`current`; the per-kind methods below are what a job performs. The service resolves the squares through the same `resolveCourseMapBbox` chain the hydro/OSM fetches use, then shells out via an injectable runner (same seam as `MapBuildService`) to `pipeline/gspro.py svg` / `ortho` / `dem` with `--square-3006 x0,y0,x1,y1` — never `--bbox` — so every file lands on the exact same square and overlays in GSPro; the palette and curve math stay pinned by the pipeline's own tests. `terrain(courseId)` describes both squares for the panel (409 with no map area). The inner orthophoto comes from the site's persisted `sources/<siteId>/ortho-*.tif` (`orthoSources` lists them, newest first, `.patched.tif` flagged; `exportOrtho` only accepts one of those names, so no request can reach outside the folder) as `<course>-<collection>[-patched]-8192.jpg`, 8192 px square at JPEG quality 92 (`ORTHO_EXPORT_SIZE` / `ORTHO_EXPORT_QUALITY`; OPCD uses 95, Unity recompresses anyway) **plus a `-terrain.jpg` twin** (`terrainTextureFileName`) dimmed in LINEAR light by `TERRAIN_TEXTURE_DARKEN` (0.4 — a sun-lit photo down to about grass albedo; ×0.25 on the sRGB bytes was ×0.05 in linear light and rendered muddy) or the request's own `darken` (0.05–1, `TERRAIN_TEXTURE_DARKEN_RANGE`, the panel's "Terrain texture brightness" field) in the same render (`--terrain-out`/`--darken`/`--darken-space linear`); the twin is JPEG q97 4:4:4 (`TERRAIN_JPEG_QUALITY`) since its reduced tonal range makes q92 blocking visible — Unity's terrain shader lights the photo a second time, so the plain one washes out on the terrain; the Unity importer picks the twin by default. With the request's `tint` (the panel's "Tint the grass surfaces", on by default) the same render also writes a **`-meshes.jpg`** (`meshTextureFileName`), the texture for the course meshes: the darkened twin with the course's grass surfaces tinted by its own drawn features — the Photoshop overlay step OPCD builders do from the SVG — via `--tint-out`/`--tint-course <courseId>`/`--tint-opacity` (`TERRAIN_TINT_OPACITY` 0.3 or the request's `tintOpacity`, 0–1, `TERRAIN_TINT_OPACITY_RANGE`); the colours, the water layer (brown, feathered shoreline) and which types are tinted or cut out are the pipeline's defaults; the Unity importer lists it for the terrain overlay only after the `-terrain` twins, since it is meant for the meshes. The **outer orthophoto** (`exportOuterOrtho(courseId, collection)`) is fetched with golfpipe `fetch-ortho` over the outer square's WGS84 envelope the first time and kept as `sources/<siteId>/outer-ortho-<collection>.tif` (not listed by `orthoSources`), then rendered as `<course>-outer-<collection>-8192.jpg`. **DEMs / heightmaps** (`exportDem(courseId, 'inner'|'outer')`) go out as square float32 EPSG:3006 GeoTIFFs **plus the Unity `.raw` heightmap** (OPCD's TIF→RAW step, done by `gspro.py dem`: 4097² uint16) and a `.json` sidecar (height range + Unity terrain/import settings), named `<course>-<inner|outer>-dem-<side>m.tif` / `.raw` / `.tif.json`; the pipeline gets `--terrain <kind>`, and an outer export passes `--inner-sidecar` when the inner's sidecar is already in the export folder (`demSidecarName`) so the outer sidecar carries the outer terrain's Unity position — else the report says to export the inner first. **Hillshades** (`exportHillshade(courseId, kind)`, `<course>-<kind>-hillshade-8192.jpg`) render the same DEM (`demSource`, same inner/outer rules) through `gspro.py hillshade` for checking overlays against the relief. **Trees** (`exportTrees(courseId, kind)`, `<course>-<kind>-trees.json`, unity-trees-v1 via `gspro.py trees`): the inner from the trees job's installed `tree-stems.json` (409 until it has run), the outer detected once with golfpipe `trees-stems --no-kind --resolution 2` (`OUTER_TREES_RESOLUTION_M`: background trees, four times fewer cells) over the outer lidar + DEM into `sources/<siteId>/outer-trees/` (`OUTER_TREES_DIR`) and written with `--exclude-square <inner>`; both need that terrain's heightmap sidecar in the export folder (409 otherwise) for the plot's height range. The DEM rules: the inner from `sources/<siteId>/dem-edited.tif` when present else `dem.tif` (D-TE2 — the export shows what the map shows) at `DEM_EXPORT_RESOLUTION_M.inner` (0.5 m); the outer gridded once from **Laserdata Skog lidar** — the same `fetch-lidar` → `grid-dem` route the build takes for the inner, never the licensed DTM product (`fetch-dem` 403s on these credentials) — into `sources/<siteId>/outer-dem.tif` (`OUTER_DEM_SOURCE`) at 1 m. The outer square's `.laz` tiles are kept in `sources/<siteId>/outer-lidar/` (`OUTER_LIDAR_DIR`), separate from the build's `lidar/` so the trees job's input does not grow; the inner tiles are hard-linked in first so `fetch-lidar`'s size-match skip spares re-downloading them. The fetch runs with `--skip-forbidden`: Lantmäteriet withholds some tiles (HTTP 403 though STAC lists them — Vreta's 5 km square hits `649_53`) and for scenery a flat, mean-filled patch beats no outer DEM; the pipeline's `warning:` line is passed through in the report. A fetch that fails leaves no half file (the ortho workdir is a temp dir and `--out` is only written on success).

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
