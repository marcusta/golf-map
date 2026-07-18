# T49 — Durable feature provenance + course-level ODbL posture

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

Resolves the wave-level open decision flagged by T44 (delegation-briefs-create-draw.md).
**Binding decision (Marcus):** OSM-derived features ARE allowed in published courses. A
course containing any ODbL feature becomes ODbL for its map data, surfaced course-by-course
with attribution — publishing is never blocked.

## What was built

### Schema + migration

- `server/db/migrations/011_feature_provenance.ts` — adds nullable `source`,
  `source_ref`, `license` TEXT columns to `course_features`. (Numbered 011, not 010:
  an uncommitted `010_round_stimp.ts` from a parallel session already occupies 010.)
  No backfill — hand-drawn features legitimately carry null provenance. Up-tested the
  house way: every service test boots a fully-migrated DB via `createTestDb`, and the
  new provenance tests read pre-migration seed rows back as nulls. No exported helpers,
  so no standalone migration test file (matches 001–007; only backfill migrations
  008/009 have those).
- `server/db/schema.ts` — `CourseFeaturesTable` gains the three columns.

### Server (`course-features.service.ts` + descriptor)

- `CourseFeature` rows expose `source` / `sourceRef` / `license` (null = hand-drawn);
  `create()` accepts them optionally; the API descriptor (`course-features.api.ts`)
  forwards them (`CreateFeatureInput`: optional `source`/`sourceRef`/`license`).
- `geojsonByCourse` carries all three in every feature's `properties`, and when any
  feature has `license === 'ODbL'` the FeatureCollection gains a top-level
  `attribution: "© OpenStreetMap contributors, ODbL"` member (exported constants
  `ODBL_LICENSE` / `ODBL_ATTRIBUTION`) — present on both raw and `resolved` output, so
  every course bundle carries it. Posture is computed over the *unclipped* feature set
  (a fully-occluded ODbL feature still makes the course ODbL).
- `bun run generate` — regenerated `shared/api/course-features.gen.ts` (committed).

### Course posture (web, derived — not stored)

Home chosen: a **features-derived selector**, `FeaturesService.hasOdblFeatures`
(`web/src/draw/features.service.ts`), not a `courses/get` server flag. Rationale: every
consumer (command-bar pill, publish confirm, editor attribution) lives on pages where
the feature store is already loaded, and a live Computed stays correct *during* editing
(import/delete flips it immediately) where a server flag fetched at course-load would go
stale. Zero server round-trips; one array scan per store change.

Surfaces:

- **Command-bar pill** (`web/src/app/command-bar.component.ts`): an "ODbL map data"
  pill next to the draft/published status pill (`data-testid="course-odbl-pill"`,
  `statusTag(color-status-info)`, tooltip naming the OSM credit). Hidden via `:empty`
  when the course has no ODbL features.
- **Publish confirm** (same file): the ConfirmService dialog's detail gains
  "…map data is published under the ODbL license with '© OpenStreetMap contributors'
  attribution." when the flag is set. Confirm-only — never a blocker.
- **Editor attribution** (`web/src/map/editor-canvas.component.ts`): the existing
  bottom-right status-bar attribution pill (ⓘ, replaces MapLibre's control) now joins
  the tile-manifest credit with "© OpenStreetMap contributors" (" · " separator) when
  `hasOdblFeatures` is true.

### Wizard passthrough (web)

- `BuiltFeature` (`web/src/import/svg-import.service.ts`) gains optional
  `source`/`sourceRef`/`license`; SVG imports never set them.
- `web/src/import/geojson-import.service.ts` — new exported
  `provenanceFromProperties()`: maps `properties.source`, and `osm_type` + `osm_id` →
  `sourceRef` (`way/123456`; bare `String(osm_id)` if `osm_type` missing). License:
  explicit `properties.license` wins; otherwise defaults to `'ODbL'` **only** when
  `source === 'osm'` (verified against `pipeline/golfpipe/osm.py`, which emits
  `source`/`osm_type`/`osm_id`/`fetched` per feature and no per-feature `license`).
  `build()` attaches provenance per source feature; `confirmImport()` forwards it on
  every create.

## Verification

- **Server:** `cd server && bun test` — **399 pass, 0 fail** (baseline before my
  changes: 395; +4 provenance tests in `course-features.service.test.ts`: create
  round-trip, null defaults incl. pre-migration rows, geojson properties + attribution
  raw/resolved, no attribution for non-ODbL licenses). `bun run check:server` clean.
- **Web:** `cd web && bun test` — **756 pass, 0 fail** (baseline 751; +3 wizard
  provenance tests, +2 `hasOdblFeatures` tests). `bun run check:client` clean.
- **Live end-to-end** (isolated scratch DB via `seed-e2e.ts`, API on :3210, vite on
  :5474 — dev servers on 3000/5173 untouched, all T49 processes shut down after):
  created an ODbL water feature through the real create API; `features.geojson`
  returned the top-level attribution + per-feature provenance; in the browser the
  command bar showed **DRAFT · ODbL map data**, the publish dialog showed the ODbL
  sentence, and the map status-bar credit read "e2e · © OpenStreetMap contributors".
  Publish was NOT clicked (dialog cancelled).

## schema.ts entanglement (round-stimp session)

`server/db/schema.ts` also carries an unrelated uncommitted hunk (`stimp_ft` in
`RoundsTable`, from the parallel round-stimp session whose migration `010_round_stimp.ts`
is untracked). Committing that hunk without its migration would break fresh checkouts, so
**only the T49 hunk was staged**: my `CourseFeaturesTable` hunk was extracted with
`git diff` and applied via `git apply --cached`; the `stimp_ft` hunk remains unstaged in
the working tree. Verified `git diff --cached -- schema.ts` shows only provenance columns
and `git diff -- schema.ts` still shows the stimp hunk. Every other file in the commit is
wholly T49's. (Generated `shared/api/*.gen.ts`: only `course-features.gen.ts` changed for
T49; the other session's modified `rounds.gen.ts` was already generator-current and was
left unstaged.)

## Gaps / follow-ups

- **iOS attribution display is OUT of scope** (per brief): the iOS app renders course
  bundles from `features.geojson`, which now carries the top-level `attribution`
  member, but nothing in the iOS UI displays it yet, and the on-course map has no
  attribution surface. Follow-up needed before distributing OSM-derived courses to
  devices.
- `update()` deliberately does not accept provenance edits — provenance is set at
  import time; retyping/reshaping an imported feature keeps its origin. Deleting the
  feature is the way to shed it (posture recomputes live).
- The course *list* page shows no ODbL marker (features aren't loaded there); the pill
  appears on the course pages where features load. Acceptable per "smallest correct
  home"; revisit only if a list-level marker is wanted (would need the server flag).
