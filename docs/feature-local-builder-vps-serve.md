# Plan: Local Builder / Lean VPS Split ("publish")

**Status:** proposal
**Date:** 2026-07-19
**Scope:** `server/` (mode gating, publish/ingest), `server/scripts`, small `web/` + `ios/` config changes. No pipeline rewrite, no desktop shell.

---

## 1. Purpose

Move to a two-tier deployment:

- **Builder (local Mac)** — the full current stack: bun server, web builder UI, Python
  `golfpipe`, `tools/sam-server`, LaMa inpainting, all raw data (`sources/` laz + ortho
  GeoTIFFs, `dem/`, `models/`). Everything expensive — downloads, DEM gridding, tiling,
  baking, re-terrain — happens here. Raw laz/ortho stay local permanently (future GSPro
  export feeds off them).
- **Serve (VPS)** — bun + SQLite only, storage-limited. Holds the minimum needed for the
  web *planning* experience and the iOS app: content rows + one optimized tile set per
  site, **single selected ortho year**, plus a small analysis DEM.

The bridge is a **publish step**: package a site's built artifacts locally, upload,
atomically swap on the VPS. One codebase, two runtime modes — *not* two apps.

Explicitly rejected: Electrobun/Wails/Tauri shell. The heavy work is Python + ML
sidecars; a shell adds packaging pain and zero capability. The "local app" is the
existing stack; wrap it in a window later if ever desired.

## 2. Current state (measured 2026-07-19)

Per-site `data/` footprint:

| Dir | Size | Role | VPS? |
|---|---|---|---|
| `sources/<siteId>/` | 0.7–1.8 G | laz, pristine + `.patched` ortho GeoTIFFs, `dem.tif`, `dem-edited.tif`, patches log, hydro geojson | **No** (except derived analysis DEM, §6) |
| `dem/<siteId>.tif` | ~150 M | intermediate gridded DEM | No |
| `models/` | 209 M | LaMa weights etc. | No |
| `tiles/<siteId>/` | ortho 144–221 M, terrain 1.6–9.4 M, hillshade 5–14 M | built XYZ pyramids + `manifest.json` | **Yes, subset** |
| `tile-archives/` | 145 M | cached per-layer tars for iOS bundles | Regenerated on VPS (§7) |
| `app.sqlite` | 28 M | all 24 tables | Content rows only |

Key structural facts:

- The built tile tree is **already single-vintage**: vintage selection + patch baking
  happen at build time (`ortho-patches.service` replays bakes onto the built vintage).
  "Only a selected year on the VPS" therefore falls out of publishing the tree as-is;
  changing year = rebuild locally + republish.
- Ortho pyramid is z14–20; **z20 alone is ~¾ of the bytes**. Capping the published ortho
  at z19 cuts ~220 M → ~55 M per site.
- Tile dirs are keyed by `siteId` with `courseId` symlinks (e.g. `7CE5…` → `26D3…`);
  `assets.service.resolveTilePath` resolves course→site.
- The archive route (`services/tiles.ts:155`, `GET /tiles/:courseId/:layer/archive.tar`)
  already supports `?maxzoom=` and builds/caches tars on demand into `tile-archives/`.

## 3. Target topology

```
┌─ Mac (builder mode) ────────────────────┐      ┌─ VPS (serve mode) ──────────────────┐
│ bun server  — ALL APIs                  │      │ bun server — runtime APIs only      │
│ web UI      — builder + planner         │ ───▶ │ web UI (static build) — planner     │
│ golfpipe / sam-server / LaMa            │ pub- │ app.sqlite: content + user data     │
│ data/: sources, dem, models, full tiles │ lish │ data/tiles: z-capped, one vintage   │
│ app.sqlite: everything                  │      │ dem-analysis per site (§6)          │
└─────────────────────────────────────────┘      │ ◀── web planner + iOS clients       │
                                                 └─────────────────────────────────────┘
```

Data flows one way in v1: content **up** (publish). User data (rounds, plans, scans,
calibration) is created against the VPS and never overwritten by publish. Pull-down
sync of user data to the builder is a later, separate feature.

## 4. API triage — what mounts in `serve` mode

Add `SERVER_MODE=builder|serve` (env, default `builder`). `main.ts` mounts by mode.

**Runtime (both modes):** `meta` (extended to report mode, §9), `sites`, `courses`,
`holes`, `tees`, `greens`, `pins`, `aim-points`, `course-features`, `clubs`,
`game-plans`, `rounds`, `assets`, `analysis`, `green-calibration`, `putt-estimate`,
tile routes (`createTileRoutes`).

**Builder only (absent on VPS):**

| API | Why local |
|---|---|
| `map-build` (`/mapbuild/*`) | spawns golfpipe, lidar download (Lantmäteriet creds), re-terrain and re-trees jobs |
| `ortho-patches` | LaMa weights (`models/big-lama.pt`), pristine sources, patch log |
| `hydro` (`/course-features/fetch-hydro`) | external fetch + creds from `.env` |
| `osm` (`/course-features/fetch-osm`) | external fetch |
| `terrain-edits` | edits are build inputs replayed onto the raw DEM; meaningless without sources |
| **new** `publish` (local CLI side) | §7 |

**Serve only:** `ingest` endpoint (§8).

`tools/sam-server` is called by the web builder directly and never touches the server —
already local-only by construction.

Implementation notes:

- Gate in `main.ts` via a mount list per mode; also skip builder-only service
  construction in serve mode (`mapBuildService.reconcileOrphans()` on boot,
  `orthoPatchesService` LaMa-weight checks) so a lean box never stats missing files.
- Serve mode should hard-fail requests to unmounted routes with 404 (they simply are not
  mounted — no stub handlers).
- One codebase, one Docker-less deploy: `bun main.ts` with different env on each box.

## 5. Data ownership — the 24 tables

Publish must never clobber user data. Classification of `server/db/schema.ts`:

**Content — site-scoped, replaced by publish:**
`sites`, `courses`, `holes`, `tees`, `greens`, `course_features`, `hazards`,
`course_assets` (rewritten during ingest, §8).

**User data — VPS is source of truth, publish never touches:**
`users`, `clubs`, `game_plans`, `game_plan_holes`, `plan_shots`, `plan_gates`,
`rounds`, `shots`, `green_scans`, `green_calibration`, `putt_estimate_samples`,
`aim_points`, `pins`.

**Local only — never published:** `map_build_jobs`, `terrain_edits`
(their *effect* is baked into published tiles + analysis DEM).

Notes:

- `pins` and `aim_points` are classified user-side because iOS laser-pin placement and
  planner aiming create them at runtime. If the builder seeds initial pins, the seed
  travels in the **first** publish of a site only (ingest inserts pins only when the
  site has none) — see decision D3.
- FK risk: content replace must not orphan user rows. Ingest replaces content rows
  **in place by id** (upsert + delete-missing) inside one transaction, so user rows
  referencing `holes`/`greens`/`courses` ids stay valid as long as ids are stable —
  which they are, since the builder DB is the origin of those ids. Deleting a hole
  locally that has VPS rounds referencing it should fail ingest loudly (transaction
  rollback + clear error listing blockers), not cascade.
- Keep one `app.sqlite` on the VPS (no split content/user DB): SQLite FKs don't span
  attached databases, and the versioned-row + transactional-ingest approach makes the
  single-file design safe. Simpler backup story too.

## 6. The analysis-DEM problem

`analysis.service` (`/analysis/sample-grid`, `/analysis/sample-elevations`) opens the
site's `dem_cog` asset — today `sources/<siteId>/dem.tif` or `dem-edited.tif` (0.5 m
float32, ~30 M/site) — via geotiff.js windowed reads. Consumers are **runtime**: web
putt-read + planner green analysis + elevation profiles
(`web/src/planner/putt-read.service.ts`, `planner-tool.service.ts`,
`analysis/analysis-tool.service.ts`) and iOS `AnalysisGrid.swift`. So the VPS needs DEM
sampling; terrain tiles (z16, ~2.4 m/px at lat 58) are too coarse for green reading.

Options:

- **(a) Ship the full edited 0.5 m DEM** (~30 M/site). Zero code change. Budget
  becomes ~110 M/site.
- **(b) Publish-time derived `dem-analysis.tif`**: 0.5 m crops around green polygons
  (+30 m buffer) mosaic'd with a 1 m downsample of the full course AOI, deflate COG.
  Est. 5–10 M/site. Small `openDem` change: none needed if it's registered as *the*
  `dem_cog` asset — sampling code already reads whatever the asset points at; green
  reads hit 0.5 m data, fairway profiles hit 1 m data, both within one raster is the
  only trick (write it as one mosaic at 0.5 m grid with 1 m-sourced values outside
  greens — file stays small because deflate eats the smooth 1 m areas).

**Recommendation: (b)**, built by a small golfpipe command (`golfpipe dem-analysis`),
run automatically by the publish CLI. Fall back to (a) for v1 if (b) drags — it's a
publish-side swap later, invisible to the server code either way.

## 7. Publish bundle + CLI (builder side)

New `server/scripts/publish.ts` (`bun run publish <siteId> [--ortho-maxzoom 19]`):

1. Preflight: site exists, tiles manifest present, no `map_build_jobs` running for the
   site, warn if `sources` ortho `.patched.tif` is newer than the built tile tree
   (unbaked edits).
2. Build `dem-analysis.tif` (§6) if stale (compare mtimes vs `dem-edited.tif`/`dem.tif`).
3. Assemble one streamed `tar.zst`:
   - `meta.json` — bundle format version, siteId, source content hash, tile layer
     zoom ranges, created-at.
   - `content/<table>.jsonl` — site-scoped rows for the §5 content tables, exported
     via Kysely (same serialization conventions as `db/import.ts`).
   - `tiles/<layer>/<z>/<x>/<y>.<ext>` — `ortho` filtered to z ≤ `--ortho-maxzoom`
     (default 19), `terrain` + `hillshade` full, plus `manifest.json` with the ortho
     `maxzoom` rewritten to the cap (clients must not request z20 from the VPS).
   - `dem/dem-analysis.tif`.
4. Upload: HTTPS `POST /api/ingest/site` to the VPS, streaming the tar, authenticated
   by `PUBLISH_TOKEN` bearer env (set on both boxes). ~60–80 M per publish; no resume
   needed at that size.
5. Print the VPS's ingest report (rows per table, tiles count, bytes, swap ok).

## 8. Ingest + atomic swap (VPS side)

New `server/services/ingest.service.ts` + `api/ingest.api.ts`, mounted **only** in
serve mode, bearer-token middleware (not cookie session).

1. Stream tar.zst to `data/incoming/<siteId>-<ts>/`, verify `meta.json` + content hash.
2. Tiles: extract to `data/tiles/.staging-<siteId>/`, then swap: `rename` old tree to
   `.trash`, staging into place, recreate `courseId` symlinks from the incoming
   `courses` rows, delete `.trash`. Readers mid-swap get at worst one 404'd tile —
   acceptable (matches the seamless-refresh behavior already built for bake).
3. Content rows: single transaction — upsert all incoming rows by id, delete rows for
   this site absent from the bundle, **abort** (rollback, 409 + blocker list) if a
   delete would violate an FK from user tables (§5).
4. `course_assets`: replace the site's rows to point at the published artifacts —
   `dem_cog` → `dem/<siteId>/dem-analysis.tif`, `tile_manifest` → published manifest.
   `ortho_cog`/`svg_source` registrations are builder-only and are not published.
5. Invalidate: clear `data/tile-archives/<courseId>/` for the site's courses (stale
   versions), bump whatever version key `cachingTileKeyLookup` uses so tile-URL
   caching rolls over.
6. Return the ingest report.

Archive caching in serve mode: after each publish the first iOS bundle download rebuilds
the tar (~store-mode, cheap). To avoid permanently doubling ortho storage, serve mode
keeps **at most the latest version key per layer** (delete others when writing a new
one). Steady state per site ≈ tree + one tar. If that still crowds the disk, switch the
archive route to streaming-without-cache in serve mode — measure first (D4).

## 9. Web + iOS impacts

**Web.** Same app, deployed as the Vite production build served statically (by the bun
server itself or Caddy). `/api/meta` gains `mode: 'builder' | 'serve'`; the UI hides
builder affordances (map build, draw/edit tools, ortho patches, terrain edits, SAM,
hydro/OSM fetch) in serve mode — routes/menus gated on the flag, planner + analytics
untouched. Builder UI continues to run against localhost.

**iOS.** Point the base URL at the VPS. Bundle downloads work unchanged through the
archive route. Two checks: (1) `SyncPlanner`/`BundleDownloader` must request
`maxzoom ≤` the published ortho cap — read it from the published `manifest.json`
rather than hardcoding 20; (2) `MapStyleBuilder.orthoTileURLTemplate` similarly caps
maxzoom from the manifest so MapLibre never requests z20 online. Round sync, green
scans, laser pin, calibration all already talk plain APIs — unaffected.

**Auth.** Provision VPS users with `bun run create-user` on the box. Tile routes stay
unauthenticated (as today). Ingest uses the bearer token only.

## 10. VPS deployment + ops

- Process: `SERVER_MODE=serve bun main.ts` under systemd; Caddy in front for TLS +
  static web build (or serve static from bun — either is fine, Caddy recommended for
  cert automation).
- Backup: the **only** unrecoverable data is user rows in `app.sqlite` (+`sessions`).
  Litestream to object storage, or nightly `sqlite3 .backup` + offsite copy. Tiles,
  content rows, and the analysis DEM are all regenerable from the builder.
- `obs.sqlite`: add retention/rotation in serve mode (33 M and growing locally today).
- Disk budget per site (ortho capped z19): tiles ~70 M + one cached tar ~55 M +
  dem-analysis ~8 M + content rows ~few M ≈ **~135 M worst case, ~80 M with streaming
  archives** (D4). Ten sites ≈ 1 G either way — fits the VPS.

## 11. Workstreams

Ordered; each lands independently behind the mode flag, integration-first tests per
[TESTING.md](../TESTING.md) (real migrated DBs, no mocks).

- **W1 — Mode gating.** `SERVER_MODE` env + mount split in `main.ts`; skip builder-only
  service bootstrap in serve mode; `meta` reports mode. Test: boot in serve mode with a
  `data/` containing only tiles + DB → all runtime APIs answer, builder routes 404,
  no missing-file errors on boot.
- **W2 — Publish CLI.** `scripts/publish.ts`: preflight, content export (jsonl), tile
  filtering with maxzoom cap + manifest rewrite, tar.zst streaming, upload. Test:
  golden bundle from a seeded test DB + synthetic tile tree; verify z20 excluded and
  manifest capped.
- **W3 — Ingest.** Service + API: staged extract, atomic tile swap + symlinks,
  transactional content upsert/delete with FK-blocker report, `course_assets` rewrite,
  archive-cache invalidation. Test: publish twice (idempotent), publish with a deleted
  hole that has user rounds → 409 with blockers, mid-ingest reader sees old-or-new
  never mixed content rows.
- **W4 — Analysis DEM.** `golfpipe dem-analysis` (greens 0.5 m + course 1 m mosaic,
  deflate COG) + publish integration; verify `sample-grid` output over a published
  site matches builder output on greens to tolerance. (Fallback: ship full DEM, defer.)
- **W5 — Client caps.** Web mode-gated UI; iOS + MapStyleBuilder read ortho maxzoom
  from manifest; `SyncPlanner` archive requests respect it.
- **W6 — Ops.** systemd unit, Caddy config, `PUBLISH_TOKEN` provisioning, Litestream,
  obs rotation, serve-mode archive retention (latest-version-only). Runbook in
  `docs/reference/`.

## 12. Decisions needed

- **D1 — ortho publish cap.** Default z19 (recommended: ~55 M/site, planner-sufficient;
  on-course iOS zoom relies on device-downloaded bundles which can still cap at 19 —
  verify visual acceptability on a phone before locking).
- **D2 — analysis DEM strategy.** (b) mosaic recommended; (a) full DEM acceptable
  fallback (+~25 M/site). §6.
- **D3 — pin seeding.** First-publish-only seed vs never publishing pins. Recommended:
  seed only when the site has zero pins on the VPS.
- **D4 — archive caching in serve mode.** Latest-version-only cache (recommended,
  simple) vs streaming-without-cache (saves ~55 M/site, slightly more CPU per download).
  Decide after measuring real VPS disk pressure.
- **D5 — transport.** HTTPS POST ingest (recommended, single auth story) vs
  scp + local ingest CLI. POST keeps the VPS free of ssh-triggered scripts.

## 13. Non-goals (v1)

- No desktop shell (Electrobun/Wails/Tauri) — revisit only if the builder is ever
  distributed to someone who doesn't run `bun run dev`.
- No multi-year/vintage storage on the VPS — one built vintage per site, ever;
  year switch = republish.
- No pull-down sync of VPS user data to the builder (future feature; needed before
  builder-side round analytics against local tools).
- No multi-tenant publish auth, no partial (per-hole) publish, no publish resume.
- No change to the pipeline's Python-ness. It stays a local venv.
