# T56 — Build integration + fast re-terrain

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

Terrain edits now reach the tiles. Full builds replay the site's enabled `terrain_edits`
between grid-dem and the tiling steps (`apply-dem-edits`, T54) and thread the edited DEM into
tile-terrain, tile-hillshade AND the manifest; a copy persists as `sources/dem-edited.tif`
(D-TE2 — `sources/dem.tif` stays raw forever). A new fast **re-terrain** job
(`kind: 're-terrain'` on `map_build_jobs`, `POST /mapbuild/re-terrain`) re-tiles terrain +
hillshade from the persisted DEM with no lidar/ortho refetch, partial-installs just those two
layers, regenerates the manifest, and refreshes the `tile_manifest` asset. The T55b
"Apply to terrain" seam is wired: the panel button starts the job, shows per-step progress
while polling, and reloads the tileset on success (new `?v=` — the tile cache-staleness check
below).

## Files touched

- `server/services/map-build.service.ts` — `BuildStep` + `BUILD_STEPS` gain `apply-dem-edits`
  (after `grid-dem`); new `RE_TERRAIN_STEPS`; `MapBuildJob.kind` (`'build' | 're-terrain'`);
  `applyTerrainEdits()` (shared by both job kinds: exports the D-TE5 GeoJSON to the workdir,
  runs T54, persists `sources/dem-edited.tif`; zero enabled edits → skip + stale-cache
  removal); `reTerrain()`/`runReTerrain()` (requires persisted `sources/dem.tif`, actionable
  error otherwise; same concurrency guard/job-row/polling contract as `start`);
  `readInstalledManifest()`/`refreshManifestAsset()` (vintage fields carried over, only the
  `tile_manifest` registration replaced); exported `terrainEditsGeojson()` (WGS84, closed
  linear rings, `op/featherM/radiusM?/flat?/createdAt` properties); `gp()` hoisted to module
  scope; deps gain optional `terrainEdits` (defaults to a db-backed `TerrainEditsService`, so
  the composition root needed no change).
- `server/db/migrations/013_map_build_job_kind.ts` (new) + `server/db/schema.ts` —
  `map_build_jobs.kind` text NOT NULL default `'build'`.
- `server/api/map-build.api.ts` — `reTerrain` action (`POST /mapbuild/re-terrain`).
- `shared/api/map-build.gen.ts` — regenerated (`kind`, the new step in the union, `reTerrain`).
- `server/services/map-build.service.test.ts` — fake runner extended (apply-dem-edits with
  edits-file capture, partial-install semantics, fresh-manifest write); 6 new tests (see below).
- `web/src/map-build/map-build.service.ts` — `BUILD_STEPS`/`STEP_LABELS` mirror the server
  (`apply-dem-edits` → "Apply terrain edits"); the build-progress component renders from this
  list, so the full-build progress UI shows the new step with no component change (verified:
  `stepState` is index-based and tolerates skipped steps — they read as done once passed).
- `web/src/terrain-edit/terrain-edit-tool.service.ts` — T56 seam replaced: `applying`/
  `applyStep` signals, `canApply` is now a `Computed` (gates re-entry), `applyToTerrain()`
  starts + polls the job (injectable `MapBuildApi` + poll interval for tests) and on success
  reloads the tileset with camera restore (clean-tool `reloadTiles` pattern).
- `web/src/terrain-edit/terrain-edit-panel.component.ts` — button enabled ("Applying…" while
  running), new per-step progress line, tooltip updated.
- `web/tests/terrain-edit-tool.service.test.ts` — stub test replaced with 5 `applyToTerrain`
  tests (success + reload, failed job, rejected start, in-flight re-entry gate, step label).
- `pipeline/golfpipe/install.py` — docstring only: partial-install semantics documented (see
  deviations). `pipeline/tests/test_install.py` (new) — 3 tests pinning partial installs.

## Tests / checks

- Server (`cd server && bun test`): **460 pass, 0 fail, 2116 expect() calls** (27 files);
  `bun run check:server` clean. New coverage: full build with edits pins the D-TE5 export
  (WGS84 lon/lat, closed ring, enabled-only, createdAt) and the edited-DEM path threaded into
  tile-terrain/tile-hillshade/manifest; zero-enabled-edits skip (identical call chain to
  today) + stale `dem-edited.tif` removal; re-terrain runs exactly
  `apply-dem-edits → tile-terrain → tile-hillshade → install(partial) → manifest` with
  vintages preserved and a new `generatedAt`; zero-edit re-terrain reverts to the raw DEM;
  actionable failure without a persisted DEM; concurrency rejection.
- Pipeline (`cd pipeline && .venv/bin/python -m pytest -q`): **186 passed** (offline).
- Web (`cd web && bun test`): **837 pass, 0 fail, 7562 expect() calls** (62 files);
  `bun run check:client` clean.

## The manifest decision (brief asked to verify before deciding)

`cmd_manifest` derives from the DEM: WGS84 **bounds** (unchanged — edits don't move the
extent) and the **elevation min/max** (`manifest.py:_dem_bounds_and_elevation`), plus
`generatedAt`. Two reasons re-terrain MUST regenerate it:

1. **Cache staleness** — `/tiles` responses carry `Cache-Control: public, max-age=31536000,
   immutable` (`server/services/tiles.ts:25`); the web busts via `?v=` derived from the
   manifest's `generatedAt` (`tileset.service.ts:deriveTileVersion`). Without a new manifest
   the browser would keep serving the pre-edit terrain/hillshade tiles forever.
2. **Elevation range is height-derived** — a flatten/smooth can change min/max (spike removal
   lowers max), and clients read it from the manifest.

Mechanics: the re-terrain job partial-installs terrain+hillshade first, then runs `manifest`
against the INSTALLED tile root (all three layer dirs present → full `layers` block; the
per-vintage ortho subdirs are ignored by `_zoom_levels`'s numeric-only scan) with the edited
DEM, then the server re-patches `orthoVintages`/`activeOrtho` (read before the overwrite) and
replaces only the `tile_manifest` asset registration. iOS needs nothing (bundle re-download
menu, per the brief).

## Deviations / brief drift found

- **`install` needed no pipeline change.** The brief says "extend it so ortho/manifest are
  optional" — `install_course_tiles` and the CLI already treat every layer + manifest as
  optional and only `rmtree`+rewrite the dirs actually passed. I pinned that contract with
  `pipeline/tests/test_install.py` (including "per-vintage ortho subdirs untouched") and
  documented it in the docstring instead of changing code.
- **Step order in re-terrain is `install` → `manifest`** (brief sketches "…tile-hillshade →
  install of just those two layers"): the manifest is generated by scanning the installed
  tile root, so it must run after install. The web full-build step list is unaffected.
- **Line refs drifted as warned**: e.g. `MapBuildService.run` is at :259→(now ~:280s),
  `BUILD_STEPS` :24, `tile-terrain` invocation :323, `map_build_jobs` schema.ts:327,
  `cmd_manifest` commands.py:935 (not :711). All verified against current code before use.

## Under-specified points and choices

- **`kind` column over a step-subset flag** — a job's kind is what the UI needs to interpret
  progress, and it reads better in the DB than a serialized step list. `ensureOrthoTiled`
  jobs keep the default `'build'` (unchanged behavior).
- **Zero-enabled-edits re-terrain is allowed and re-tiles from the raw DEM** — that's the
  revert path (disable/delete all edits → Apply restores unedited terrain). Pinned by a test.
- **Stale `sources/dem-edited.tif` is deleted when a build/re-terrain runs with zero enabled
  edits** — the cache must never lie to the future Unity `.raw` exporter (the brief's main
  use case).
- **WGS84 export server-side** via the existing `sweref99tmToWgs84` helper (D-TE5 says WGS84;
  brief allowed either side); rings are closed on export because GeoJSON linear rings require
  it (the tool stores open rings).
- **Full-build manifest also uses the edited DEM** (`--dem` arg) so the published elevation
  range matches what the terrain tiles show.

## Open concerns for the reviewer

- **`dem_cog` still points at the RAW `sources/dem.tif`**, so analysis elevation/green
  sampling reads unedited heights while the map shows edited terrain. Deliberate (the brief
  doesn't touch `dem_cog`, and D-TE2 keeps raw as the source of truth) but a visible
  inconsistency once someone flattens a green surround — candidate for a follow-up decision.
- **A full-build `?v=` subtlety pre-exists**: re-terrain (and any rebuild) changes
  `generatedAt`, which busts ortho tile URLs too — a one-time refetch of unchanged ortho
  tiles. Same behavior as a full rebuild today; not worth a per-layer version yet.
- **Deactivating the terrain tool mid-apply** lets the job finish server-side but skips the
  post-success tileset reload (no ctx) — the map shows old tiles until the next
  reload/navigation. Rare; the panel keeps the user in-tool while "Applying…" is shown.
- **Concurrent-session edits**: `pipeline/golfpipe/{__main__,commands}.py`, `web/src/api.ts`,
  `server/main.ts`, `server/services/index.ts` etc. were touched by other in-flight sessions;
  this commit deliberately avoids those files (e.g. `terrainEdits` dep defaults in-service so
  `services/index.ts` needed no edit) and stages only its own files.
