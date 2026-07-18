# T53 — One-click OSM import in the web editor

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

**Binding decision (Marcus):** the GeoJSON import wizard's source picker
gains a third variant, "Fetch from OpenStreetMap", alongside the file input
and the Lantmäteriet button — same downstream bucket → preview → accept
flow. The full fetch-osm flow moves into the UI.

## What was built

### Server proxy endpoint

- `server/services/osm.service.ts` — `OsmService.fetchForCourse(courseId)`,
  a TypeScript port of `pipeline/golfpipe/osm.py` (T44), architecturally a
  mirror of `HydroService` (T50):
  - **Overpass query**: the same QL osm.py builds (`way`/`relation` for
    `golf`, `natural=water`, `natural=wood`, `landuse=forest`; `out geom;`
    inlines member coordinates), POSTed form-encoded with the descriptive
    User-Agent `golf-map-server/1.0 (fetch-osm)` per the Overpass usage
    policy. No credentials — Overpass is public but rate-limited: **429
    and 504 map to clear user-facing ConflictErrors** ("rate-limiting …
    wait a minute", "busy … try again"), network failures are wrapped with
    the same clarity. HTTP sits behind a `fetchImpl` seam so tests stay
    offline.
  - **Tag→type mapping** (`classifyOsmTags`): golf tags win
    (green/tee/fairway/bunker/rough, water_hazard + lateral_water_hazard →
    water), then natural=water → water, natural=wood / landuse=forest →
    trees; everything else skipped (unclassified silently, per osm.py).
    Comment in both files pins the two tables to each other.
  - **Ring assembly**: closed ways auto-close (≥ 3 distinct points);
    `type=multipolygon` relations stitch split member ways end-to-end in
    either direction (`stitchRings`, port of osm.py), inners become holes
    of the outer ring containing them (`assignHoles` — a hand-rolled
    even-odd point-in-ring test on the inner's vertex centroid with a
    first-vertex fallback replaces shapely's representative_point/covers).
    Open classified ways / hole-less relations land in `skipped` notes.
  - **Reprojection**: WGS84 → EPSG:3006 per vertex via
    `services/geo.ts wgs84ToSweref99tm` (the hand-rolled transform — no
    rasterio), output rounded to cm like osm.py's `ndigits=2`.
  - **Deviation from osm.py, deliberate**: output polygons are **clipped
    to the course's EPSG:3006 bbox** with hydro's `clipPolygonToBbox`.
    Overpass's bbox filter is INTERSECTS on full geometry — a
    `landuse=forest` way touching the course corner can be enormous.
    Provenance survives clipping (clip splits keep the same sourceRef).
  - **Provenance (T49)**: every feature carries `sourceRef`
    `way/<osm_id>` / `relation/<osm_id>`; the result carries
    `source: 'osm'`, `license: 'ODbL'`, the osm.py attribution string and
    a `fetched` date stamp.
- `server/services/course-bbox.ts` — **extracted** from HydroService: the
  bbox authority chain (course `georeference_json` `{bbox}` EPSG:3006 →
  WGS84, else the site's `tile_manifest` asset `bounds`, else 409 with a
  per-caller purpose string). `HydroService.courseBbox` now delegates to
  it; all 18 hydro tests unchanged and green.
- `server/api/osm.api.ts` — descriptor `fetchOsm`:
  `POST /course-features/fetch-osm` `{ courseId }` (POST: each call spends
  shared public Overpass quota), `requireAuth`. Wired in
  `services/index.ts` + `main.ts`. `bun run generate` →
  `shared/api/osm.gen.ts` (committed): `OsmApi`, `OsmFetchResult { bbox,
  source, license, attribution, fetched, features: OsmFeaturePolygon[],
  skipped }`.

### Web wizard — third source variant

- `web/src/import/geojson-import-panel.component.ts` — section 1's source
  picker now has three variants: file input, "Fetch from Lantmäteriet
  (water + creeks)", and **"Fetch from OpenStreetMap"**
  (`data-testid="geojson-fetch-osm-btn"`). One fetch at a time; the
  in-flight variant's button carries the "Fetching from …" label (new
  `fetchSource` signal) while both are disabled. Below the buttons, an
  inline ODbL note appears while the OSM fetch is the loaded source:
  *"OSM data is ODbL — imported features mark this course's map data ODbL
  until removed."* Everything downstream (bucket mapping, preview overlay,
  confirm) is untouched.
- `web/src/import/geojson-import.service.ts` — `fetchFromOsm()`: calls
  `api.osm.fetchOsm`, formats via new pure `osmToFeatureCollection()`
  (EPSG:3006 `crs` member + attribution; per-feature
  `type`/`source`/`source_ref`/`license`/`fetched` properties), and feeds
  `loadGeojsonText()` as `openstreetmap.geojson` — the SAME path the file
  and Lantmäteriet variants use, so **post-T52 every imported ring lands
  as a fitted b-spline**. Empty result → human `fetchError`. The
  T50 fetch and the new one share extracted `runFetch()` single-flight
  plumbing.
- **Property-name consistency (verified against T49/T50)**: the server
  returns the composite `sourceRef` (`way/123`) that
  `provenanceFromProperties` would itself compose from a fetch-osm FILE's
  `osm_type`+`osm_id`; the web emits it as `source_ref`, which wins by
  design (T50), plus explicit `license: 'ODbL'` (matches the osm-source
  default). Either import route lands identical provenance on
  `course_features`, and the T49 course-level ODbL pill/attribution fires.
- `web/src/api.ts` — `osm: createOsmClient('/api')`.

## Verification

- **Server:** `cd server && bun test` — **438 pass, 0 fail** (baseline
  420 + 18 OSM tests). `check:server` + `check:test` clean. OSM tests are
  fully offline: fixture Overpass JSON behind the fetchImpl seam incl. the
  **multipolygon-with-holes** case (island survives as a hole through
  stitch → reproject → clip), split-way stitching in mixed directions,
  straddling-polygon clip with provenance, bbox chain (georeference wins >
  manifest fallback > 409 before any request), 429/504/network error
  mapping, UA + POST body mechanics.
- **Web:** `cd web && bun test` — **781 pass, 0 fail** (post-T52 baseline
  776; +5: osmToFeatureCollection formatting, full fetch→bucket→confirm
  flow with ODbL provenance on every create, rate-limit error surfacing,
  empty-result message, fetchSource labeling). `check:client` +
  `check:test` clean.
- **Live smoke** (script over the dev DB + real Overpass): Landeryd
  Masters (georeference path) → bbox (15.702, 58.347, 15.742, 58.368),
  **147 features in 3.1 s: 60 trees, 30 water, 25 bunker, 17 green,
  14 fairway, 1 rough**, 0 skipped; 2 multipolygon relations kept their
  holes (`trees relation/371004`, `trees relation/9799612`); real
  sourceRefs (`way/47050748`, …). First two attempts hit a live **504**
  and returned the intended "Overpass … busy" message — the rate-limit UX
  is verified against the real API, not just fixtures. The long-running
  dev server picked the endpoint up via `bun --watch` (probe: 401 auth,
  not 404).
- Panel wiring was NOT driven in a live browser this session (the dev
  app sits behind login; entering credentials isn't something an agent
  session does) — it mirrors the T50 button/label/error pattern verbatim
  and is covered by the service-level tests.

## Staging discipline (parallel-session worktree)

Unrelated uncommitted changes were present throughout (round-stimp
session: server/ios/shared/web-tests + untracked migration 010). Only T53
files were staged, each by explicit path. `bun run generate` also
regenerated `shared/api/rounds.gen.ts` because that session's
`rounds.api.ts` edits are uncommitted — left unstaged (only `osm.gen.ts`
is T53's). `web/tests/round-sg.test.ts` carries only their hunks — not
touched. T52 landed mid-task (commit a1f68822); web work started after
it, so no import-file collisions.

## Gaps / follow-ups

- The tag→type tables in osm.py and osm.service.ts are pinned by comments
  but not by a shared fixture — a cross-language parity test would need a
  shared JSON table (not worth it for 10 entries yet).
- No automatic retry/backoff on Overpass 429/504 — the error message asks
  the user to retry; the T50 pre-flight-bbox gap applies here identically.
- The ODbL note shows while the OSM source is loaded in the wizard; after
  import the course-level T49 pill takes over. If the user swaps to a
  file mid-flow the note disappears though fetched buckets are gone
  anyway (load replaces state).
- `assignHoles` tests centroid-then-first-vertex containment — degenerate
  OSM inners whose centroid AND first vertex sit outside every outer are
  dropped silently, same as osm.py's containment loop.
