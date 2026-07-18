# T55a — `terrain_edits` table + service + API (+ codegen)

**Model:** Opus · **Date:** 2026-07-18 · **Status:** done

Server half of T55 (the "Server" paragraph). Persists site-scoped DEM smooth/flatten edits
as vector features (straight-segment rings in the DEM CRS, replayed onto the raw DEM at build
time — never baked into `sources/dem.tif`). Web editor UI is T55b; build integration is T56.
No web/ code touched.

## Files touched

- `server/db/migrations/012_terrain_edits.ts` (new) — creates the `terrain_edits` table + `site_id` index.
- `server/db/schema.ts` — `TerrainEditsTable` interface + registration in `Database`.
- `server/services/terrain-edits.service.ts` (new) — `TerrainEditsService` + types/validation.
- `server/services/terrain-edits.service.test.ts` (new) — CRUD + version-conflict + validation + cascade tests.
- `server/api/terrain-edits.api.ts` (new) — API descriptor (list/create/update/remove).
- `server/services/index.ts` — construct + export `terrainEditsService`.
- `server/main.ts` — mount `createTerrainEditsApi`.
- `shared/api/terrain-edits.gen.ts` (new, generated) — client via `bun run generate`.

## Table `terrain_edits`

| column | type | notes |
|--------|------|-------|
| `id` | text pk | |
| `site_id` | text NOT NULL | FK → `sites.id` `ON DELETE CASCADE` (D-TE1, site owns the map) |
| `op` | text NOT NULL | `'plane' \| 'smooth'` (D-TE3) |
| `params_json` | text NOT NULL | `{ featherM, radiusM?, flat? }` |
| `rings_json` | text NOT NULL | straight-segment rings in EPSG:3006 (DEM CRS) |
| `enabled` | integer NOT NULL default 1 | bool 0/1 |
| `version` | integer NOT NULL default 1 | optimistic locking |
| `created_at` / `updated_at` | text NOT NULL default `datetime('now')` | |

Plus index `terrain_edits_site_id_index`.

## API routes (all `requireAuth`, mounted under `/api`)

- `GET  /terrain-edits` `{ siteId }` → `TerrainEdit[]` (oldest-first — the D-TE4 apply order)
- `POST /terrain-edits/create` `{ siteId, op, params, rings, enabled? }` → `TerrainEdit`
- `POST /terrain-edits/update` `{ id, version, op?, params?, rings?, enabled? }` → `TerrainEdit`
- `POST /terrain-edits/remove` `{ id, version }` → `{ ok }`

Version-conflict semantics mirror the sites API: missing row → `NotFoundError` (404), stale
`version` → `VersionConflictError` (409). Bad op / negative `featherM` / non-positive
`radiusM` / <3-point rings → `InvalidTerrainEditError`.

## Tests / checks

- `bun test` (server): **446 pass, 0 fail, 1998 expect() calls** across 26 files.
- Terrain-edits file alone: 8 pass, 0 fail.
- `bun run check:server` (tsc): clean, no errors.

## Decisions where the brief under-specified

- **`rings_json` shape.** Brief says "straight-segment rings — mirror `course_features`
  geometry storage." `course_features` stores a bezier/anchor geometry object; terrain edits
  are explicitly straight-segment, so I stored the simpler `{ x, y }[][]` (array of rings)
  rather than the anchor-point geometry — enough for the pipeline handoff (D-TE5 reprojects
  plain rings) and for T55b's polygon draft. Kept it as a JSON string column, mirroring the
  `_json` storage convention.
- **FK / cascade.** Used a real `references('sites.id').onDelete('cascade')` (as
  `map_build_jobs` does for a freshly `createTable`d table; FKs are `PRAGMA foreign_keys = ON`
  in both app and test DB) rather than the app-level detach `SitesService.remove` uses for
  the columns 007 *altered* onto existing tables. Deleting a site therefore drops its edits;
  `SitesService.remove` was left untouched. Covered by a cascade test.
- **`listBySite` ordering.** Ordered by `created_at`, tie-broken by `id`, so the list matches
  the deterministic D-TE4 replay order the pipeline consumes.

## Notes for the reviewer / T55b

- `bun run generate` rewrote every `*.gen.ts` idempotently; only `terrain-edits.gen.ts` is a
  new/changed artifact from this task. `shared/api/rounds.gen.ts` was already modified by
  another in-flight session before this task began and is **not** part of this commit.
- Client factory is `createTerrainEditsClient` in `shared/api/terrain-edits.gen.ts` — T55b
  wires it into `web/src/api.ts` (deliberately not touched here).
