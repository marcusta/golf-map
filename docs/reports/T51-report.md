# T51 — Keep lidar .laz after builds; make deletion an explicit user action

**Model:** Opus · **Date:** 2026-07-18 · **Status:** done

**Binding decision (Marcus):** `.laz` lidar files are multi-use assets (detect-trees,
detect-water, future tooling), not build scratch. Map builds must stop auto-deleting them;
they are kept after the DEM build and deleted manually per course, when done, via a
"Delete lidar files" entry in the editor's ⋯ menu.

## Prior behavior

`MapBuildService.run()` fetched lidar into `work/lidar/` (a `mkdtemp` workdir under the OS
tmpdir), gridded the DEM, persisted only derived outputs (`dem.tif`, ortho GeoTIFFs) under
`data/sources/<siteId>/`, then `rm(work, { recursive: true })` in the `finally` deleted the
entire workdir — including every `.laz` — on both success and failure.

## What was built

### Server — persist the .laz (`server/services/map-build.service.ts`)

- The `.laz` is relocated out of the ephemeral workdir into a persistent
  `data/sources/<siteId>/lidar/` directory **immediately after `fetch-lidar` succeeds**,
  before any later step can fail. So the files survive later-step failures (grid-dem,
  ortho, tiling), not just successful builds. The `finally` workdir teardown is unchanged
  and no longer has any `.laz` to delete.
- `<siteId>` is the same map key the `dem.tif` destination uses (`sourcesDir(siteId)` =
  `data/sources/<siteId>`) — "site owns the map". A new private `lidarDir(siteId)` helper
  returns `sources/<siteId>/lidar`.
- Relocation is a **move, not a copy** (`relocateLidar` → `moveFile`): `rename` with a
  copy+unlink fallback on `EXDEV`, because the tmpdir workdir and the data dir are commonly
  on different filesystems. Same-named files are overwritten — Lantmäteriet tiles are
  immutable, so an identical name is identical data. `grid-dem` then reads its `--lidar`
  inputs from the persistent dir.
- New service methods:
  - `lidarInfo(courseId): Promise<{ files: string[]; totalBytes: number }>` — resolves
    course→site **without minting a site** (a read must have no side effects; returns empty
    for a never-built course), lists `.laz` names (sorted) and sums their `stat().size`.
  - `deleteLidar(courseId): Promise<{ freedBytes: number }>` — sizes then `rm -rf`s the
    lidar dir; a no-op (`0` bytes) when there's no site or no dir.

### Server — endpoints (`server/api/map-build.api.ts`)

Added to the existing map-build descriptor (the home of the build/tiles endpoints), same
`requireAuth()` middleware:

- `GET  /mapbuild/lidar`         → `svc.lidarInfo(courseId)`  → `{ files, totalBytes }`
- `POST /mapbuild/lidar/delete`  → `svc.deleteLidar(courseId)` → `{ freedBytes }`

`bun run generate` regenerated `shared/api/map-build.gen.ts` — a new `LidarInfo` interface
and `lidarInfo`/`deleteLidar` client methods.

### Web — ⋯ menu (`web/src/app/command-bar.component.ts`)

- A "Delete lidar files (X.X GB)" item in the same command-bar ⋯ actions menu that holds
  Import SVG / Import GeoJSON (Create mode only). The menu opens, appends the item hidden,
  fetches `lidarInfo` on open, and then either reveals the item with its size label or
  removes it — so it appears **only when the course has persisted `.laz` files** and never
  flashes a loading/empty row. `data-testid="course-delete-lidar-btn"`.
- Click → a danger `ConfirmService.confirm` naming the file count and reclaimable size
  ("… freeing 1.4 GB", detail notes the built map is unaffected). On confirm, calls
  `deleteLidar`; the result is reported as a notice via a second `ConfirmService` dialog
  ("Lidar files deleted — Freed 1.4 GB" / an error dialog on failure). `ConfirmService` is
  the app's only global modal surface (there is no toast infrastructure), so it is the
  house pattern for both the confirm and the notice.
- `MapBuildClientService` (`web/src/map-build/map-build.service.ts`) gains thin
  `lidarInfo`/`deleteLidar` wrappers and an exported `formatBytes` helper
  (B/KB/MB/GB/TB, one decimal). Added a Lucide `trash-2` icon to `web/src/ui/icons.ts`.

### Pipeline consumers (note — no changes this task)

`detect-trees` and `detect-water` can now be pointed at `data/sources/<mapKey>/lidar/`
instead of re-fetching from Lantmäteriet. No pipeline code was changed in T51.

## Verification

- **Server:** `cd server && bun test` — **402 pass, 0 fail** (baseline 399; T50's
  concurrent work plus my +3 map-build tests). `bun run check:server` (tsc) clean.
  (Note: `polygon-clipping`, a dep pulled in by a concurrent session's `hydro.service.ts`,
  was present in `package.json` but not linked in this environment — a `bun install`
  restored it; unrelated to T51.)
  New map-build tests, all offline via the fixture `PipelineRunner` (no Python):
  - happy path additionally asserts `sources/<site>/lidar/item_648_52.copc.laz` exists;
  - lidar persists even when a **later** step (`grid-dem`) fails — proves the move happens
    right after `fetch-lidar`;
  - `lidarInfo` lists the `.laz` + byte total; `deleteLidar` removes them and reports freed
    bytes; a second read is empty and a second delete is a 0-byte no-op;
  - `lidarInfo` on a never-built course returns empty and mints no site.
- **Web:** `cd web && bun test` — **756 pass, 0 fail**. `bun run check:client` (tsc) clean.
- **Live end-to-end not run:** exercising the real menu requires a course with downloaded
  `.laz`, which needs a live Lantmäteriet lidar fetch (real Python pipeline) — not possible
  offline. The full relocate → info → delete path is covered by the fixture-based service
  tests instead, and both typechecks are clean.

## Commit hygiene

Unrelated uncommitted changes were present (the round-stimp session across
`server/`/`ios/`/`shared/`/`web/tests/`, untracked `010_round_stimp.ts`; the concurrent T50
session on `course-features.api.ts`/`web/src/import/*`/`*.gen.ts`). Only T51 files were
staged with explicit `git add`. `bun run generate` also rewrote `shared/api/rounds.gen.ts`
with the round-stimp session's `stimpFt` field (already `M` before T51 and generator-current)
— that file was left unstaged; only `map-build.gen.ts` was staged from the generated output.

## Gaps / follow-ups

- No automatic residual cleanup or size cap — deletion is fully manual per Marcus's
  decision. A course can accumulate `.laz` across rebuilds; rebuilds overwrite same-named
  tiles but a shrunk/moved bbox could leave orphan tiles from a previous, larger fetch.
  Acceptable for now (manual delete reclaims everything); revisit if it becomes a problem.
- Pipeline `detect-trees`/`detect-water` still take an explicit `--lidar`/input dir; wiring
  them to default to `data/sources/<mapKey>/lidar/` is a separate task.
