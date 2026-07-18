# T57 report — analysis sampling reads the edited DEM (`dem_cog` follows terrain edits)

**Task:** resolve the T56 open concern (docs/reports/T56-report.md, "Open concerns"):
the `dem_cog` asset used by server-side analysis sampling (green sample grids,
point elevations) still pointed at the RAW `sources/dem.tif`, so analysis heights
disagreed with the visible terrain wherever edit polygons overlap greens/surrounds.
Fix per **D-TE2**: raw stays pristine, every consumer sees replayed edits — so
`dem_cog` now points at `sources/dem-edited.tif` whenever terrain edits were
applied, falling back to the raw DEM otherwise.

## Files touched

- `server/services/map-build.service.ts`
  - `registerAssets` takes a `demEdited` flag; `dem_cog` registration extracted to
    `registerDemAsset(siteId, courseId, demEdited)`, which points the asset at
    `sources/<siteId>/dem-edited.tif` when edits were applied this run, else
    `sources/<siteId>/dem.tif`. It is a no-op when the registration already points
    at the right file (re-applies don't churn the asset row).
  - Full build (`run`) passes `demEdited !== null` through to `registerAssets`.
  - Fast re-terrain (`runReTerrain`) calls `registerDemAsset` in its `register`
    step — a re-terrain can flip the pointer in BOTH directions (apply → edited,
    revert-with-zero-enabled-edits → raw). `refreshManifestAsset`'s doc comment
    updated (it previously claimed dem_cog is never touched by re-terrain).
- `server/services/analysis.service.ts`
  - `openDem` cache is now keyed by **file identity** (`path|mtimeMs|size`), not
    path alone: a re-apply rewrites `sources/dem-edited.tif` in place, and the old
    per-path cache would have kept serving the pre-rewrite GeoTIFF handle. Stale
    keys for the same path are pruned on re-open, so the map never grows past one
    live entry per DEM file. (This staleness was latent for `dem.tif` across full
    rebuilds too.)
  - Header comments document that `dem_cog` follows the edited DEM.
- `server/services/map-build.service.test.ts` — updated pins:
  - full build with enabled edits registers `dem_cog` → `dem-edited.tif`;
  - re-terrain test now expects `dem_cog` re-pointed at the edited DEM (it
    previously pinned `after.dem_cog.id === before.dem_cog.id`, i.e. the old
    wrong behavior);
  - revert-path test additionally pins `dem_cog` → edited after apply and back to
    `dem.tif` after the zero-enabled-edits re-terrain.
- `server/services/analysis.service.test.ts`
  - fixture writer refactored (`writeDemTiff(absPath, pixels)`) so real GeoTIFFs
    can be written at arbitrary paths;
  - **new integration test** ("T57: analysis sampling sees edited heights after a
    re-terrain, and raw heights again on revert"): persists a real raw-DEM
    GeoTIFF, runs `MapBuildService.reTerrain` with a fake pipeline runner whose
    `apply-dem-edits` writes a real offset GeoTIFF, and asserts via
    `AnalysisService.sampleElevations` that (1) analysis reads edited heights
    after apply, (2) a second re-terrain with a different outcome is picked up
    despite the in-place rewrite of `dem-edited.tif` (pins the file-identity
    cache keying), and (3) disabling all edits + re-applying falls back to raw
    heights with `dem_cog` → `dem.tif`.

## Test results

Full server suite from `server/`:

```
 463 pass
 0 fail
 2139 expect() calls
Ran 463 tests across 27 files. [9.35s]
```

Typecheck: `bun run check:server` and `bun run check:test` both clean.

## Deviations / choices where the brief was silent

- **Registration-side fix, not consumer-side probing.** The alternative (analysis
  probes for `dem-edited.tif` next to the registered raw path) would fix
  already-built sites without a re-apply, but splits the source of truth: the
  asset row is the pointer every consumer resolves, and build/re-terrain — the
  only writers of the edited DEM — are the right owners of where it points.
  Consequence: a site that applied edits BEFORE this commit keeps sampling raw
  heights until its next re-terrain or full build (one click of "Apply to
  terrain" heals it). Judged acceptable — the terrain-edit feature shipped
  yesterday (2026-07-18).
- **Cache invalidation by `mtimeMs|size`** rather than an explicit invalidation
  hook from MapBuildService into AnalysisService: no service dependency exists
  in either direction today, and stat-based identity also covers rewrites that
  don't go through the build service (manual file replacement, restores).
- **No-op guard in `registerDemAsset`** keeps repeated re-applies from
  deleting/re-inserting the asset row each run (id churn for API consumers).

## Numbering

Per the terrain-edit brief's numbering note the next free number is **T57**;
checked both brief docs (`delegation-briefs-terrain-edit.md`,
`delegation-briefs-create-draw.md`) and `docs/reports/` — nothing else claims it.

## Open concerns for the reviewer

- **Pre-existing sites with applied edits** sample raw heights until the next
  re-terrain/full build (see above). No data is wrong at rest — only the pointer
  is stale — and there is no automatic migration; if that matters operationally,
  a one-off script could re-point `dem_cog` for sites where
  `sources/<siteId>/dem-edited.tif` exists.
- **`mtimeMs` granularity**: on filesystems with whole-second mtimes, two
  rewrites of `dem-edited.tif` within the same second with identical file size
  could reuse a stale handle. APFS/ext4 have ns resolution and a re-terrain run
  takes far longer than 1 s end-to-end, so this is theoretical.
- **The e2e seed** (`server/db/seed-e2e.ts`) still registers `dem_cog` → its
  synthetic raw DEM; correct as-is since e2e seeds no terrain edits.
- **Concurrent-session hygiene**: the tree carries unrelated uncommitted work
  (rounds/iOS/gspro files). This commit stages only the four service/test files
  above plus this report.
