# T50 — One-click water import in the web editor

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

**Binding decision (Marcus):** the GeoJSON import wizard keeps its file-pick
variant AND gains a "Fetch from Lantmäteriet (water + creeks)" variant that
downloads, formats, and feeds the same mapping/preview/accept flow — no
manual file step.

## What was built

### Server proxy endpoint

- `server/services/hydro.service.ts` — `HydroService.fetchForCourse(courseId)`,
  a TypeScript port of the fetch semantics of `pipeline/golfpipe/hydro.py`
  (T48): collections StandingWater + WatercoursePolygon (water surfaces) and
  WatercourseLine (creek centerlines); `?crs=<EPSG:3006 URI>` output with the
  official (northing, easting) axis order swapped to (x, y); `rel: next`
  paging with query params on page 1 only and a MAX_PAGES loop guard;
  EPSG:3006 bbox clip (the API's bbox filter is INTERSECTS) — polygon-clipping
  intersection for surfaces (holes and clip-splits handled), Liang–Barsky
  per-segment clipping for centerlines (a line exiting/re-entering splits
  into runs). Upstream 401/403 maps to the same Geotorget entitlement
  message hydro.py uses.
- **Unlike the pipeline command, no union**: geometries return PER SOURCE
  FEATURE so each carries its own provenance — `sourceRef` =
  `<Collection>/<OGC feature id>` (null when the API omits ids). Creek
  centerlines return RAW with `suggestedCreekWidthM: 2` (matches
  `water.py DEFAULT_CREEK_WIDTH_M`) — the line→ribbon buffering is
  client-side per the brief.
- **Bbox authority chain** (site owns the map): course `georeference_json`
  `{ bbox: [minX, minY, maxX, maxY] }` (EPSG:3006, converted to WGS84 via
  `services/geo.ts` corner transforms) when present; else the course's
  site's `tile_manifest` asset `metaJson.bounds` (already WGS84, read via
  `AssetsService.listBySite` — the DB row, not the tile file, so it works
  wherever the asset registry does); else a clear `ConflictError` (409:
  "Course has no map area to fetch water for…"). Chosen over
  map-build's `siteBbox()` file read because the asset row is the
  registered source of truth the web/tileset path already resolves.
- **Credentials**: `LANTMATERIET_USER`/`PASS` from the server process env,
  falling back to the nearest `.env` walking up from cwd (the repo root's
  `.env` — the same file golfpipe's `_load_dotenv` finds; the dev server's
  cwd is `server/`, and Bun does not auto-load the parent .env). Missing
  creds → ConflictError before any request. `parseDotenv` mirrors the
  python parser (quotes stripped, comments skipped).
- `server/api/hydro.api.ts` — descriptor `fetchHydro`:
  `POST /course-features/fetch-hydro` `{ courseId }` (POST: each call spends
  external quota), `requireAuth`. Wired in `services/index.ts` + `main.ts`.
  `bun run generate` → `shared/api/hydro.gen.ts` (committed): `HydroApi`,
  `HydroFetchResult { bbox, source, attribution, suggestedCreekWidthM,
  water: HydroWaterPolygon[], creeks: HydroCreekLine[] }`.
- `polygon-clipping` added to `server/package.json` (already a shared/web
  dep at the same range; bun.lock delta is one line).

### Web wizard — source picker

- `web/src/import/geojson-import-panel.component.ts` — section 1 is now
  "Source (EPSG:3006)": the existing file input PLUS a
  "Fetch from Lantmäteriet (water + creeks)" button
  (`data-testid="geojson-fetch-hydro-btn"`, disabled + "Fetching…" while in
  flight, error line under it). Everything downstream (bucket mapping,
  preview overlay, confirm) is untouched — the fetch path lands in the same
  flow.
- `web/src/import/geojson-import.service.ts` —
  `fetchFromLantmateriet()`: calls `api.hydro.fetchHydro`, formats the
  response via new pure `hydroToFeatureCollection()` (water polygons pass
  through; creek centerlines buffered by the server-suggested width;
  EPSG:3006 `crs` member + attribution), and feeds `loadGeojsonText()` as
  `lantmateriet-hydrografi.geojson` — reuse, not a fork. An empty result
  sets a human `fetchError` instead of a parse error. New signals
  `fetching`/`fetchError`; `openFor`/`loadGeojsonText` reset them.
- `web/src/geo/polyline-buffer.ts` — new pure `bufferPolyline(points,
  widthM)`: open-polyline ribbon (widthM/2 per side, miter-clamped averaged
  normals like draw-state's offset op, butt caps, explicit GeoJSON closure);
  null for degenerate input. Kept out of draw-state — `offsetRingPoints`
  there is for CLOSED rings.
- **Provenance (T49)**: features carry `source: 'lantmateriet-hydrografi'`
  and `source_ref` properties; `provenanceFromProperties` extended so an
  explicit `source_ref` wins over the OSM composite. NO license property —
  consistent with `hydro.py`, which emits attribution
  ("© Lantmäteriet, Hydrografi Direkt") and source only (not ODbL).
- `web/src/api.ts` — `hydro: createHydroClient('/api')`.

### Bug fix folded in (confirmed live by Marcus on Vreta)

Post-import refresh used `FeaturesService.reload()`, which **no-ops when the
store never loaded** (`loadedCourseId === null`) — open a course, go straight
to ⋯ → Import GeoJSON without ever activating the draw tool, import: rows
land in the DB (21 on Vreta) but nothing renders and the stack panel says
"No features" until a full page reload. Fix: new
`FeaturesService.reloadOrLoad(courseId)` (re-fetch when loaded, initial-load
otherwise — never a silent no-op) + both import services expose
`targetCourseId`; **both** panels (geojson AND svg — same latent bug) now
call it. Regression tests: unloaded-store import → store loaded; loaded
store → cache bypassed.

## Verification

- **Server:** `cd server && bun test` — **420 pass, 0 fail** (session
  baseline 399 + 18 hydro tests; the other +3 appeared from the parallel
  lidar session's test file mid-task — zero failures throughout).
  `check:server` + `check:test` clean. Hydro tests are fully offline:
  fixture pages behind the fetchImpl seam incl. a **multi-page** next-link
  case, (n, e) axis-order fixtures, clip cases (straddling/outside/split
  runs), bbox chain (georeference wins > manifest fallback > 409), 401 →
  Geotorget message, creds failure before any request.
- **Web:** `cd web && bun test` — **769 pass, 0 fail** (baseline 756; +5
  polyline-buffer, +6 wizard fetch incl. provenance and error paths, +2
  reloadOrLoad regressions). `check:client` + `check:test` clean — note
  `check:test` was ALREADY red at HEAD (3 pre-existing T49-fallout fixture
  errors: `hit-lie-stack`, `planner-tool.service`, `round-sg`, plus
  `analysis-tool.service` revealed behind them — `CourseFeature` fixtures
  missing `source`/`sourceRef`/`license`); fixed all four by adding the null
  fields.
- **Live smoke** (read-only script over the dev DB + real API, creds via
  root `.env`): Landeryd Masters (georeference path) → bbox
  (15.702, 58.347, 15.742, 58.368), **25 water + 9 creeks** — exactly T48's
  live counts (22 + 3 surfaces, 9 lines); Vreta (georeference path) →
  12 water + 15 creeks. Real OGC ids as sourceRefs
  (`StandingWater/2276906`, `WatercourseLine/8456021`, …).

## Staging discipline (parallel-session worktree)

Unrelated uncommitted changes were present throughout (round-stimp session:
server/ios/shared/web-tests; a lidar-delete session actively editing
map-build files and the briefs doc mid-task). Only T50 files were staged,
each by explicit path. Two entanglements:

- `web/tests/round-sg.test.ts` carries the round-stimp session's `stimpFt`
  hunks — my `squareFeature` provenance-fields hunk was staged alone via
  `git apply --cached` (T49's schema.ts approach); the stimp hunks remain
  unstaged.
- `shared/api/map-build.gen.ts` + `rounds.gen.ts` changed under
  `bun run generate` because the OTHER sessions' descriptor edits are
  uncommitted — left unstaged (only `hydro.gen.ts` is T50's).
- `docs/delegation-briefs-create-draw.md` was untracked at task start, but
  the parallel lidar session committed it (with its T51 section) mid-task —
  so this commit's doc diff is purely the T50 row (Σ 96 → 104) + section.

## Gaps / follow-ups

- The fetch button is enabled even for a course whose bbox chain will 409 —
  the server's message is shown verbatim in the panel, which is acceptable
  UX for now; pre-flighting would need a bbox probe endpoint.
- Creek ribbons are butt-capped; round caps (matching shapely's default
  buffer in the pipeline) were deliberately skipped — at 2 m width the
  visual difference is sub-pixel at editing zoom, and caps land inside
  water polygons at confluences anyway.
- `defaultHydroCredentials`'s .env walk is exercised indirectly (live smoke)
  — unit tests cover `parseDotenv` and the injected-credentials paths only.
