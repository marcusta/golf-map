# Server features (implementation notes)

Moved from server/AGENTS.md. Feature sections: db scripts, edit history, feature numbers, sites, reference photos, generated features, attributes, GSPro export (+ the status board), regenerate trees, tile manifest.

## db scripts

- `db/` — `schema.ts` (Kysely schema), `migrations/NNN_*.ts` (numbered), `seeds/`, `import.ts`, `create-user.ts`, `import-terrain-edits.ts` (generated edits — `golfpipe building-pads` — into a site's `terrain_edits` under one `origin`, replacing that origin's previous generation only; the `water-digs` / `bunker-digs` / `creek-digs` generators write `dig` edits straight from the course's features, `terrain-generators.service.ts`). On a site shared by several courses a generator run replaces only its own course's edits: `replaceByOrigin(…, { courseId })` keeps rows whose `originRef` is `feature:<id>` of another course on the site (digs, road grades of a course's own paths); building pads and grades of fetched centerlines are site-wide and replaced whole.

## Edit history

Migration 025 keeps the state BEFORE every change of a course feature (`course_feature_history`: `update` and `delete` hold the old row without `geojson`, `restack` only `sort_order`/`version`/`updated_at`) and of a terrain edit (`terrain_edit_history`), by SQLite triggers, so every write path is covered (editor, reorders, generator bulk replaces, scripts). Nothing reads it in the app; `FeatureHistoryService` (`stateAt`, `changes`, `mix`, `writeVariantDb`, export `snapshot`s) serves `scripts/gspro-bisect.ts`. A full GSPro SVG export also keeps `<export dir>/export-history/<local time>/` (the SVG + `features.json`). Timestamps are UTC. A new feature shifts every one above it: that is a `restack` row per feature, and `changes` reports only features whose order among their group really moved.

## Drawing groups

Migration 032 adds `holes.drawing_group_name`: NULL is a playable hole, a name
is a drawing scope. Reusing `course_features.hole_id` keeps ordering, moving,
undo and mesh naming on the existing path. New groups get stable internal
numbers from 100 to 1022 (never OPCD's special Hole99); playable hole creation
accepts 1–98. Deleting a playable hole never renumbers groups. Group deletion
requires an empty scope so features and their mesh names cannot disappear.

`HolesService.listByCourse` and `/api/holes` omit groups unless
`includeDrawingGroups=true`; the desktop course-detail store requests them
and exposes separate playable `holes`, `drawingGroups` and all `drawScopes`.
Create/update use optional `drawingGroupName` (trimmed, 1–80 characters).
Course summaries, routing, par totals and GreenKeeper's course-file hole
change count exclude groups. `gspro.py` also excludes their hazard/OOB
features from GKD and skips the groups in Unity's playable-hole navigator.

Migration 033 adds `drawing_group_after`: NULL = above all playable holes,
0 = below all holes, N = above playable hole N. Migration 034 adds
`drawing_group_order` for peers in the same gap (NULL falls back to their
stable internal number). Update's `drawingGroupBeforeId` moves a group
before a peer in bottom-to-top order, or to that gap's top with NULL; it
checks the version and rewrites peer orders atomically. The client reloads
all scopes after a peer move because their versions can also change.
Removing a playable hole compacts explicit group positions with its numbers.
`drawScopeRanks` in `shared/render/stack-key.ts` assigns distinct integer
ranks with all 4096 feature slots per scope intact; the server GeoJSON and
web use it, and `gspro.py` mirrors it in `_group_rank_sql`. SVG layers retain
OPCD's descending rank convention, now including groups at their chosen rank.

Migration 035 replaces the gap-based UI with `drawing_stack_order` for both
playable-hole and drawing-group layers. NULL retains legacy placement until
the first list move. Update's `layerBeforeId` inserts that layer before a
same-course layer in bottom-to-top order (NULL = top), atomically assigns
distinct orders and bumps affected versions. The web reloads all scopes.
Course level and Roughs are fixed scopes, not reorderable hole rows. Creating
a layer after reordering appends it at the top of the movable layers.
`drawScopeRanks` and `_group_rank_sql` prefer explicit stack order; hole
numbers keep their identity for routing, GreenKeeper and SVG/mesh names.
The Shapes status row counts changed layers as well as changed features.

## Feature numbers

Migration 026 gives every hand-drawn or imported course feature a per-course number, `course_features.feature_no` (`no` on the API), from the counter `courses.next_feature_no`. Shown in hex it is the feature's GSPro SVG shape name and so its mesh name (`hole_18_1c` → `Spline_hole_18_1c_Bunker_-_Mesh`; docs/gspro/export.md), which Unity keys saved edits to, so a number is never reused. Triggers hand them out, like the history, so every write path is covered: a row inserted without one gets the next number; a row written with one (history restore, publish ingest) keeps it and moves the counter past it. Generated rows (`generated = 1`, the pipeline's bulk replaces) get none, since each run re-inserts thousands. The history triggers keep `feature_no` in the old row. No unique index: an ingest upserts row by row and a served copy can hold a number mid-ingest; the counter keeps them unique.

## Sites

A site owns the map; courses link to it through `courses.site_id` and several courses can share one site. `GET /api/sites/overview` returns every site with its courses and the bbox and time of its last succeeded `build` job (`SitesService.overview`, used by the web `/sites` page and the new-course wizard). `SitesService.remove` throws `ConflictError` (409) while any course is attached: detach or move the courses first. The build API is still addressed by course. `MapBuildService.resolveSiteId` creates a site named after the course only when the course has none, so the wizard creates the site first and passes `siteId` to `courses.create`.

## Reference photos

On-course photos with pose metadata ([docs/feature-reference-photos.md](../docs/feature-reference-photos.md) §5). Table `site_photos` (migration 016), `PhotosService`, descriptor API `photos.api.ts`, raw routes `photos.routes.ts`.

- `POST /api/photos/create` is idempotent by `id` and returns the stored row on a repeat. `list`, `get`, `update` (tags, note, hole; version-locked) and `remove` (row plus both files) complete the descriptor API. Both modes, session auth.
- `PUT /api/photos/file/:id?kind=original|preview` takes a raw body and `X-Content-SHA256`. It streams to `data/photos/.incoming/`, then renames to `data/photos/<siteId>/<id>.heic|.jpg`. Responses: 200 `{status: 'stored'|'unchanged', photo}`, 400 hash mismatch or missing header, 404 unknown id, 409 different hash already stored, 413 over 20 MB. File arrivals do not bump `version`.
- Builder pull, serve mode only, `PUBLISH_TOKEN` bearer: `GET /api/ingest/photos?since&limit`, `GET /api/ingest/photos/file/:id?kind`, `POST /api/ingest/photos/ack {ids}`. The cursor is `upload_seq` as a decimal string ("0" = start). `upload_seq` is set to `MAX+1` when the original arrives, when a later preview arrives, and on a metadata edit, so a photo re-lists after each change.
- `bun run photos-pull [--reset]` (`services/photos-pull.ts`) needs `PUBLISH_URL` and `PUBLISH_TOKEN`, read from the env, then `server/.env`, then the root `.env` (`services/dotenv.ts`; Bun only auto-loads the cwd's `.env`). The cursor lives in `data/photos/pull-state.json`. The pull never overwrites the local `refined*` fields. A photo whose site is missing locally is reported and not acked; create the site, then rerun with `--reset`. The builder server runs the same pull every `PHOTOS_PULL_INTERVAL_MIN` minutes when that and `PUBLISH_URL` are set.
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

### Import script (no HTTP, no auth)

```sh
bun scripts/import-generated-features.ts <courseId> <geojson-path> [--source lidar-canopy] [--db ../data/app.sqlite]
# or: bun run import-generated-features -- <courseId> <geojson-path>
```

Runs migrations, then `CourseFeaturesService.replaceGenerated` against the given sqlite file, printing `deleted`/`inserted`. Same validation and same transaction as the endpoint. Exit 1 with the reason on invalid input.

## attributes on features

Migration 015 adds nullable `course_features.attributes_json`. The service and API expose it as `attributes: Record<string, number | string | boolean> | null` on read (list, byId, `.geojson` properties), create and update (`null` clears; omitted leaves it untouched). Flat object, at most 32 keys. Clients that never send it keep working and read `null`.

## GSPro export (builder only)

`GsproExportService` → `pipeline/gspro.py`. Full reference: [docs/gspro/export.md](../docs/gspro/export.md).

- Folder: `courses.gspro_export_dir` (migration 016); NULL = Downloads (`GSPRO_EXPORT_DIR` overrides). Vreta: `D:\gspro_courses\vreta-opcd`.
- Two squares (`terrain-square.ts`): **inner** = map area, whole-metre edges, side a multiple of 10 m, fixed at map-build time (`manifest.terrain.inner.square3006`); **outer** = 5 km centred on it. Every export passes `--square-3006`, never `--bbox`, so files overlay exactly.
- Jobs: `start`/`job`/`current`, one running per course (409 otherwise); outer fetches run for minutes.
- GKD hazard lines (`gkdLines`, `GET /api/courses/:courseId/gspro/gkd-lines`): `gspro.py gkd-lines` writes `<export dir>/<slug>-inner-gkd-lines.json` — one entry per hazard the .GKD gets (`kind` water/penalty/inner_oob, `waterIds` or `featureId` + `type`, `noAsItLies`, `points` as a closed EPSG:3006 ring), re-run only when the inner sidecar/heightmap, the .GKD (`--gkd`, its boundary for a course with no drawn `oob`), the features or the pipeline changed; calls per course run one after another. Needs the map and an exported inner heightmap (409 until then: opening Furniture never starts that export), not the GSPro course folder; passes the server's own `DB_PATH` as `--db` (as `exportGkd` and the SVG do), so a preview/e2e server reads its own copy. The request lifts Bun's 10 s idle timeout (`noIdleTimeout`): a cold run takes 8-17 s on Vreta. `noAsItLies: true` in a penalty or water feature's attributes sets that line's noAIL (`shared/features/no-as-it-lies.ts`); everything else is played as it lies. Furniture's Rules lines and `bun run gkd:lines` read it.
- Creek depth (`creekDepth`, `GET /api/courses/:courseId/gspro/creek-depth?only=<ids or starts, comma-separated>`): `gspro.py creek-depth` (~5 s) measures every `water_creek` across on the DEM its digs are in and on a model of the meshes OPCD conforms onto terrain.obj, and returns its golfmap-creek-depth-v1 report (per creek `status` ok/shallow/not-dug/stale/off/on-lake, the DEM and mesh depths, `shallow` stretches and `mouths` with x,y in EPSG:3006; `summary` is a plain record because the API generator cannot write hyphenated keys) plus `demSource` and `lines` (what it printed). The DEM is `sources/<site>/dem-edited.tif` when no enabled edit changed after it (`applied`) — the same check as the heightmap's "changed after the last Apply to terrain" warning (`innerDemEdits`) — else the raw `dem.tif` with `--edits <temp D-TE5 GeoJSON>` of every enabled edit (`replayed`). Reads the inner sidecar for the terrain's square and zero, exporting the inner heightmap first when there is none (`ensureDemSidecar`, as the creeks export); passes the server's `DB_PATH` as `--db`; writes only temp files. The request lifts Bun's idle timeout. Terrain edit's **Depth** and `bun run water:depth` read it.
- `vegetation` (the command bar's Update vegetation, `plantVegetation`): runs the vegetation generator strategies in `vegetation-generators.ts` (`VEGETATION_GENERATORS`, in zone-stack order: tall rough, woodland floor, creek banks; each is a pipeline script + the generated `source` it replaces + the zone types it adds + the inputs it needs), exports the terrain's zones, then `golfmap.zones.import` + `golfmap.grass.apply` in the Unity editor whose active course exports to the folder (not open = reported, not an error), then the Arborist file (below). `scripts/grass-zones.ts` is the same handler without the Unity step and the trees.
- Arborist file (`ArboristService`, `arborist.service.ts`; [docs/gspro/arborist.md](../docs/gspro/arborist.md) "Who writes the file"): for a course with `docs/gspro/<slug>/arborist-species.json`, `plantVegetation` (inner) ends with `arborist.py lower` (zones export + palette, no Unity) and, with the editor open, `golfmap.trees.dump` + `arborist.py trees`; `updateZones` with `lower` when the inner masks changed; kind `arborist` runs the two alone. Inputs are found from the course (`gspro_course_dir`, the export folder's zones, surface map and heightmap sidecars via `terrainsSquare`, `data/arborist/`, `data/arborist-wrapper.key`): no new settings. `plantVegetation`'s `arborist: 'lower' | false` leaves the trees or the whole half (the shaping run's replant uses `'lower'`). A half that fails fails the job after the other has run, with both outcomes in the message. The runner's third argument `{ timeoutMs }` kills a hung run (lower 5 min, trees 15 min). `arboristOutDir` (deps; `gspro:export --arborist-out`) writes somewhere else than the course folder.
- Kinds and files (`<course>-…`): `svg`; inner ortho `-<collection>-8192.jpg` + `-terrain.jpg` (linear-light darkened twin) + `-meshes.jpg` (tinted, softened), and `-clean-8192.jpg` variants when the request removes buildings / paints forest floor (the panel's separate cleaned export); outer ortho; DEM `-<inner|outer>-dem-<side>m.tif/.raw/.tif.json` (export inner first: outer sidecar needs it); hillshade; trees `-trees.json` (unity-trees-v1); zones `-zones.json` + `-zones-<n>.png`; buildings. Trees/zones/buildings/creeks/GKD read that terrain's DEM sidecar and **export the heightmap first when the folder has none** (`ensureDemSidecar`); an outer DEM export likewise exports the inner first, for the outer terrain's Unity position.
- **GSPro status board** (`GsproSyncService`, `api/gspro-sync.api.ts`; [docs/gspro/export.md](../docs/gspro/export.md) "The GSPro status board"): one row per *target* (`shared/gspro-targets.ts`: terrain, photo, shapes, meshes, vegetation, trees, buildings, creeks, course-file) with last run, what changed since, stale/blocked and the manual step; one verb `update(courseId, target|'stale')` runs that target's whole chain (both terrains, the files, the Unity push — no matching editor is a skipped phase, not a failure) as a phased job that QUEUES per course behind other sync, export and shaping jobs. `GET /api/gspro-sync/status|job`, `POST /api/gspro-sync/update`, `GET /api/unity/editors`. "Last run" is `<export dir>/gspro-sync.json` (`golfmap-gspro-sync-v1`) with file mtimes as the fallback; "changed since" is `FeatureHistoryService.countChangesSince` + `TerrainEditsService.countChangesSince` (both skip `generated = 1` features — the pipeline replaces them wholesale) plus the cleaned photo's mtime and the course's own tables. Every Unity push a chain makes runs with `save: true` (the report then names the scene it saved), and every file is rendered only when its inputs changed — a hash of the source files, the run's arguments and the database stamps in `<output>.inputs.json` next to it (`export-fingerprint.ts`; the report says `unchanged: <file>`), which `force` on the request bypasses. CLI: `bun run gspro:status -- <course>` / `bun run gspro:update -- <course> <target|stale> [--force]`.
- **Blender shaping** (`ShapingService`, `api/shaping.api.ts`; [docs/gspro/export.md](../docs/gspro/export.md) "Shaping from the Terrain editor", blender/SHAPING-PLAN.md): `GET /api/shaping/recipes?surface=` (blender/recipes/library.json, `[]` without it); `POST /api/courses/:courseId/shaping/apply` → job: `gspro.py shaping-global` (00-global + 10-features layers) → shaping worker (`GOLFMAP_SHAPING_URL`, started on demand, `/load` + `/sync`) → Unity `golfmap.course.refresh only=<changed objects>`; `GET /api/courses/:courseId/shaping/status`. The job reports `phases` (`layers` → `worker` (cold start: the worker's own `phase` and the seconds so far) → `blender` → `unity` → `vegetation`; each `pending|running|done|skipped|failed` with `detail` and `seconds`, live seconds computed per read), `phase` (the running/failed one), a one-line `step`, total `seconds`, and `result.unitySteps` (the refresh report's step timings). The `vegetation` phase runs only when a changed object is a rock slab (`*_Rock_-_Mesh`, the Blender op `golfmap.cut_out`) and Unity was refreshed (skipped, with the reason, otherwise and on a dry run): `golfmap.surfaces.export {terrain: "inner"}` unless the refresh's `surfaces.export` step is `done`, then `GsproExportService.plantVegetation` (its report lines are `result.vegetation`); a failure there fails the job. Without the panel: `bun run shaping -- <course> [--dry-run]` (`scripts/shaping-apply.ts`, the same `apply`, polled to the end, exit 1 when the job failed). The panel polls `GET /api/shaping/job`; a 404 there (server restarted: jobs are in memory) ends the panel's job as failed, and the Terrain editor re-follows a running job on open (`ShapingService.resume`). A feature's recipe is a terrain edit `op: recipe` (`params {recipe, overrides?}`, origin `feature`, originRef `feature:<id>`, no rings, one per feature: 409), validated in `TerrainEditsService` against the library and the feature's surface (bunker/lake/creek/path); `overrides` keys are the entry's declared `params` ids (the recipes endpoint serves them, `[]` when none; `shaping-recipes.ts` drops malformed ones and the engine's `maps`), values within min..max, plus `seed` (int); DEM replays use `listDemEdits`, which leaves recipe edits out. No migration: `op`/`params_json` are free text. The worker's `/load` and `/sync` are JOBS (`202 {job, kind, state}`, polled on `/status`'s `job` or `GET /job/<id>`; `?wait=1` keeps the old blocking answer), it takes `--host`/`--token` (`GOLFMAP_SHAPING_TOKEN`, sent as `X-Golfmap-Token`) so it can run on another machine over UNC paths, another course's busy worker on the port is waited for instead of taken over, and each spawn gets its own log in `<data>/shaping-worker/` (`latest.json` names it, 14 days kept). Tests drive a stand-in worker on its HTTP contract (`testing/fake-shaping-worker.ts`, in process and spawned).
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
`bun run trees:regen -- <courseId>` (`scripts/regen-trees-job.ts`, this same job, stands included) or
`bash scripts/regen-trees.sh <courseId|siteId>` (needs sqlite3 on PATH), which writes
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
