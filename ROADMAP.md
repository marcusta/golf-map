# Golf Map — Roadmap & Architecture Plan

A ground-up rebuild of the golf course map system as a three-part product:

| Component | Role |
|-----------|------|
| **Server** | Single source of truth: course data, game plans, round data, tile + asset serving |
| **Web app** | Course **building** (advanced, SVG/vector based), game **strategy planning**, **follow-up** analytics |
| **iOS app** | **On-course use** (GPS, distances, plays-like) and light strategy planning. No course building |

---

## 1. What exists today (prior art inventory)

### iOS v1 — `/Users/marcust/dev/golf-course-map/GolfCourseMap`
- SwiftUI + MapKit, MVVM. UserDefaults JSON persistence, no sync.
- **Domain model worth keeping** (proven on 20 courses / 326 holes):
  - Hole: teebox, green (front/center/back), ordered aimpoints with elevations, bunkers, red/yellow water hazards, per-hole saved map region, par derived from aimpoint count.
  - Club: distance + lateral dispersion, computed length dispersion, wind-adjusted min/max.
  - GamePlan: per-course, wind speed/direction, per-hole preferred club + planned bearing + plan locations.
- **Strategy math worth porting**: dispersion ellipse rendering (lateral × length, rotated by shot bearing), wind adjustment rules (head −1%/mph, tail +0.5%/mph, harsher above 18 mph), distance rings.
- Backend (Bun + Hono + Kysely + SQLite) exists but was never wired to the app. Web editor (Leaflet + custom framework) incomplete. Both are reference material, not code to carry forward.
- `py-filer/`: QGIS scripts for Lantmäteriet orthophoto discovery/download (STAC, SWEREF 99 TM) — directly reusable.
- **Data**: `golfcoursemap-export-2026-03-24.json` — 20 courses, 326 holes, 13 clubs, 18 game plans. Import this into the new server in Phase 1.

### golf-map-2 — `/Users/marcust/dev/github/golf-map-2/webapp`
The advanced course-building prototype. This is the conceptual base for the new web app.
- React 19 + Vite + Three.js (R3F); Bun + Hono + oRPC + Drizzle + SQLite.
- **SVG feature pipeline**: trace features (green/fairway/bunker/tee/rough/water/outside) as SVG over orthophoto → `preprocess-svg.mjs` (parse, clip) → `tessellate-greens.mjs` (adaptive tessellation, 0.2 m greens → 25 m outside; Taubin smoothing of LiDAR noise; bunker bowl geometry).
- **Terrain**: 16-bit PNG heightmap from LiDAR DEM via GDAL (RH2000 heights), orthophoto as texture, displacement mapping so all features conform to terrain.
- 2D vector editor with Bezier/B-spline paths; green slope analysis; measurement tool; vegetation biomes.
- **Gaps**: monolithic geometry (no tiles), coordinates in local SVG-mm space (not georeferenced to lat/lon), backend stubbed, no mobile story.

### golf-mapping — empty Vite skeleton. Ignore.

### mackans-client-fw — `/Users/marcust/dev/github/mackans-client-fw`
Marcus's own full-stack framework (`@basics/core`), production-proven in `apps/stable` (horse management), actively maintained. **Adopted as the backend foundation for this project** (see 2.2).
- **Server**: Bun + Hono via `createApp()` (request-id/trace, secure headers, CORS, body limit, timeout, structured JSON logging), Kysely + Bun SQLite (WAL), TypeBox validation, numbered Kysely migrations, cookie-session auth with per-username rate limiting, typed error translation (`VersionConflictError` → 409 etc.), optimistic locking via `version` columns, observability bulkhead DB (traces, events, rollups, client error reports).
- **API descriptors**: each feature exports `create<Feature>Api(svc)` returning `{ method, path, schema, middleware, fn }` maps; `mount()` handles validation, coercion, and error mapping.
- **Codegen** (`core/generate-api.ts`): TS-compiler-driven; emits readable, self-contained typed clients (`src/api/<feature>.gen.ts`) with input types from TypeBox schemas and return types inferred from service signatures. The v1 golf web editor's `*.gen.ts` clients came from this. **TS output only — no Swift emitter yet.**
- **Client framework**: signal-based fine-grained reactivity (Signal/Computed/effect/batch), class-based components with template `wire()` bindings, `$each`/`$swap` directives, DI container, router with typed params, `EntityStore` with per-item signals + version-aware `mutate()`, `request()` loading/error wrapper, UI component library. Mock-free testing culture, 150+ tests. Use for the golf web app is **under debate** (see 2.6).

---

## 2. Target architecture

```
                      ┌──────────────────────────────┐
 QGIS / GDAL pipeline │  Server (Bun + Hono)         │
 orthophoto, LiDAR ──▶│  - REST API (OpenAPI)        │
 DEM → COG → tiles    │  - SQLite + Drizzle          │
                      │  - static tile serving       │
                      │    /tiles/{course}/{layer}/  │
                      │       {z}/{x}/{y}            │
                      └──────┬──────────────┬────────┘
                             │              │
                    ┌────────▼───────┐ ┌────▼─────────────┐
                    │ Web app        │ │ iOS app          │
                    │ course builder │ │ on-course GPS    │
                    │ strategy       │ │ strategy (view/  │
                    │ follow-up      │ │  light edit)     │
                    │ MapLibre + 3JS │ │ offline bundles  │
                    └────────────────┘ └──────────────────┘
```

### 2.1 Repo layout (this repo, monorepo)

```
golf-map/
  server/        Bun + Hono + Kysely + SQLite, on @basics/core (mackans-client-fw)
  web/           Vite + TS; MapLibre GL JS (2D), Three.js (3D); app framework TBD (2.6)
  ios/           SwiftUI app (Xcode project)
  pipeline/      GDAL/QGIS scripts: orthophoto + DEM → COG → tiles
  shared/        generated clients (TS + Swift/OpenAPI), shared strategy math, JSON schemas
  data/          v1 export, sample assets (gitignored where large)
```

`@basics/core` is consumed from the mackans-client-fw repo (workspace/file dependency or published package — settle in Phase 0).

### 2.2 Server — built on `@basics/core` (mackans-client-fw)

- **Foundation**: `createApp()` from `@basics/core` — Bun + Hono, request-id/tracing, structured logging, timeouts, body limits, CORS, observability DB. Battle-tested in `apps/stable`; don't rebuild any of it.
- **DB**: Bun SQLite + **Kysely** (framework standard; v1 golf backend used it too), WAL mode, numbered forward-only migrations, in-memory DB for tests via `createTestDb()` + seed functions. Nightly file backup (or Litestream later).
- **Structure**: framework's mechanical pattern per feature — `db/schema.ts` (Kysely `Database` interface), `services/<feature>.service.ts` (Kysely queries, optimistic locking via `version`), `api/<feature>.api.ts` (descriptor: `{ method, path, schema: TypeBox, middleware, fn }`), `services/<feature>.service.test.ts`.
- **API style**: framework **descriptor pattern**, not hand-rolled OpenAPI. `mount()` gives validation, coercion, and error translation for free; `bun run generate` gives the typed web client.
- **Auth**: framework cookie-session auth (`SessionStore`, `createAuthApi`, `requireAuth()`) for the web app. iOS uses the same session endpoints or a long-lived device token variant — decide in Phase 4; the middleware hook point exists either way.
- **Assets & tiles**: course asset upload (GeoTIFF/COG, SVG sources) + pre-generated tile pyramids served as static files with cache headers: `/tiles/{courseId}/ortho/{z}/{x}/{y}.jpg` and `/tiles/{courseId}/terrain/{z}/{x}/{y}.png`. Tile serving bypasses JSON descriptors (plain Hono static routes).

### 2.2b Client generation strategy

- **Web**: framework codegen as-is — descriptors → `src/api/<feature>.gen.ts`, fully typed, readable output.
- **iOS**: the codegen has no Swift emitter. Bridge options, in preference order:
  1. **Emit OpenAPI from the descriptors** — TypeBox schemas *are* JSON Schema, and method/path live in the descriptor, so inputs are nearly free; add explicit TypeBox response schemas on the endpoints iOS consumes (a small, read-mostly subset). Then Apple's `swift-openapi-generator` gives the Swift client. One source of truth, two emitters.
  2. Extend `generate-api.ts` with a Swift emitter directly (the TS-compiler type serialization already exists; Swift templating is the new work).
  3. Fallback: hand-written thin Swift client validated against shared JSON fixtures — viable because the iOS surface is small.
- Decision point: end of Phase 1, when the API surface iOS needs is concrete. Option 1 is the working assumption.
- **DECIDED (2026-07-05, Phase 4):** option 3 — hand-written thin Swift client. Option 1 was prototyped end-to-end (descriptor import → OpenAPI 3.1 emission → swift-openapi-generator → compiled Swift): it works, but **no descriptor has a response schema** (the TS codegen infers response types from service `fn` return types via the TS compiler, not from TypeBox), so typed Swift responses would require hand-authoring response schemas for every iOS endpoint anyway — the same modeling work as writing Swift structs, plus a production emitter (~700–900 lines) and a second source of truth that drifts unless `mount()` validates it. Generated ergonomics were also poor (`Type.Number` → Swift `Double` for ints, GeoJSON as untyped containers, ~350 lines of Swift per endpoint). Hand-written client: ~500 lines, zero dependencies, JSON-fixture decode tests against snapshots of real server responses catch drift at the wire level. Revisit if the surface grows past ~40 endpoints or a second non-TS client appears.

### 2.3 Data model (canonical schema)

Improvements over v1, informed by both prototypes:

- `courses` — name, location, CRS metadata (see 2.4), status (draft/published), version.
- `holes` — course_id, number, par (explicit, not derived), notes.
- `tees` — **hole_id, name/color (black/white/yellow/blue/red/…), position, elevation, measured length**. Many per hole — the multi-teebox requirement.
- `greens` — hole_id, boundary geometry, center/front/back derived from geometry rather than hand-placed points.
- `pins` — **green_id, name ("Back Left"…), position, difficulty, active flag / date ranges**. Many per green.
- `aim_points` — hole_id, order, position, elevation, label, optional per-tee applicability.
- `features` — course_id, hole_id (nullable — course-level features allowed), type (`tee, fairway, green, bunker, semi_rough, rough, deep_rough, water, water_creek, path, outside`), **geometry stored as Bezier/B-spline path in projected course space** (preserves editability), plus a server-materialized flattened GeoJSON (WGS84) for clients.
- `clubs` — per user: name, carry, lateral dispersion; keep v1's computed length-dispersion rules in shared logic.
- `game_plans` / `game_plan_holes` / `plan_shots` — per user + course; wind; per-hole tee selection, per-shot club + aim point + bearing.
- `rounds` / `shots` — **new, for follow-up**: round metadata, per-shot GPS position, club used, result lie. Schema in from day one, UI in a later phase.
- `assets` — per course: orthophoto COG, DEM COG, SVG sources, tile-set manifests (bounds, zoom range, generated_at).

Versioning: published courses get monotonically increasing `revision`; clients cache by revision — cheap sync ("is my copy current?" = one integer compare).

### 2.4 Coordinate systems (the critical design decision)

Three spaces must interoperate:

1. **WGS84 (lat/lon)** — what GPS and map clients speak.
2. **Projected metric CRS per course** (SWEREF 99 TM / EPSG:3006 for Sweden) — what distances, dispersion ellipses, tessellation, and LiDAR data are computed in.
3. **SVG/editor space** — golf-map-2 traced features in local mm-as-meters space.

Rule: **every course stores an explicit CRS + affine georeference**. Feature geometry is authored and stored in the projected CRS; the server derives WGS84 GeoJSON. SVG imports are georeferenced on import (2-point or affine fit against the orthophoto). This fixes golf-map-2's biggest structural gap (un-georeferenced local space) while keeping its editing model.

Use `proj4js` (web/server) and a small Swift proj wrapper or precomputed transforms (iOS mostly consumes WGS84 + meters, so it rarely needs raw projection math).

### 2.5 Tile & terrain pipeline (`pipeline/`)

Input per course: orthophoto GeoTIFF (Lantmäteriet, reuse `py-filer` QGIS scripts) and LiDAR DEM GeoTIFF. Lantmäteriet now exposes STAC APIs — prefer STAC search+download over manual QGIS export:
- Elevation/lidar: `https://api.lantmateriet.se/stac-hojd/v1` (collection `dtm-cog` = Markhöjdmodell as COG, RH2000)
- Orthophotos: `https://api.lantmateriet.se/stac-bild/v1`
- Search is anonymous; asset downloads from `dl1.lantmateriet.se` need HTTP Basic auth (free account) — pipeline reads `LANTMATERIET_USER`/`LANTMATERIET_PASS`.

1. Normalize to COG in EPSG:3857-compatible form (`gdalwarp` + `gdal_translate -of COG`).
2. **Ortho tiles**: `gdal2tiles.py --xyz` → JPEG/WebP pyramid, zoom ~14–20 clipped to course bbox.
3. **Terrain tiles**: DEM → **Terrain-RGB** encoding (`rio rgbify`) → PNG pyramid. One format serves web (MapLibre terrain + 3D displacement) and iOS (decode RGB → meters for plays-like and profiles).
4. Emit tile-set manifest (bounds, min/max zoom, elevation range) → upload to server with course asset record.

Keep golf-map-2's Gaussian blur + Taubin smoothing as an optional DEM pre-step for green-quality surfaces.

### 2.6 Web app

- **App framework: open decision** — React vs `@basics/core` client (mackans-client-fw). The trade-off:
  - *For @basics/core*: consistency with the backend and Marcus's other apps, signal-based fine-grained updates suit an editor (per-feature signals via `EntityStore`), generated clients plug straight in, no framework churn. MapLibre and raw Three.js are imperative libraries that pair naturally with signals + direct DOM — no wrapper needed.
  - *For React*: golf-map-2's 3D code is react-three-fiber; keeping React would let some of it port as code rather than as concepts. Bigger ecosystem for editor UI odds and ends.
  - Lean: **@basics/core**, accepting that the 3D view gets rewritten in plain Three.js (the tessellation/terrain pipeline scripts are framework-agnostic and port either way; it's the R3F component layer that would be redone). Decide before Phase 3 starts.
- Vite + TS. Two map stacks, one data model:
  - **2D geographic editing + planning**: MapLibre GL JS — ortho raster tiles + terrain-RGB + vector features. Editor tools drawn in an SVG/canvas overlay in screen space, geometry in projected CRS.
  - **3D view**: port golf-map-2's Three.js terrain + tessellated features (its strongest asset) as a per-hole/per-course inspection and green-reading view.
- **Course builder** (the "much more advanced" part):
  - Bezier/B-spline polygon tools per feature type (port editor concepts from golf-map-2's `Editor.tsx`).
  - SVG import with georeferencing (trace in Inkscape or in-app).
  - Place all tee boxes, multiple pins per green, aim points with ordering.
  - Elevation sampling from terrain tiles for every placed point (replaces v1's Google Elevation dependency).
  - Later: SAM-assisted segmentation from orthophoto (stub exists in golf-map-2).
- **Strategy planner**: per tee selection, club + dispersion ellipse overlay (port v1 math), wind model, plays-like distances from terrain, shot-by-shot plan per hole.
- **Follow-up**: rounds/shots dashboards — GIR, dispersion-vs-plan, club distance calibration from collected data.

### 2.7 iOS app

- SwiftUI, ground-up rewrite. **Read-mostly client**: browse published courses, download offline bundles, on-course GPS.
- Map rendering: **MapLibre Native iOS** (first choice — same tiles/styles as web, offline tile control). Fallback if it fights us: MapKit + `MKTileOverlay` for ortho tiles (v1 experience applies).
- **Offline bundle** per course: vector features (GeoJSON) + ortho tiles + terrain tiles for course bbox + game plans, keyed by course revision. On-course play must work with zero connectivity.
- On-course features (parity with v1, then better): distances to front/center/back and active pin, distances to hazards/aim points from live GPS, plays-like via terrain tiles, dispersion ellipse preview, club suggestion with wind.
- Light strategy edits (change club/aim for a hole) sync back; no geometry editing.
- **Data collection**: mark shot positions during round (one tap per shot: position + club) → feeds follow-up.
- Persistence: SwiftData or GRDB/SQLite (not UserDefaults). Sync = pull by revision, push plans/rounds.

---

## 3. Phased roadmap

### Phase 0 — Foundation (repo, schema, contracts)
- Monorepo scaffolding: `server/`, `web/`, `shared/`, `pipeline/`; Bun workspaces; CI lint/test. Wire in `@basics/core` (decide: file dependency on mackans-client-fw vs published package).
- Server skeleton on the framework pattern: `createApp()`, Kysely `Database` interface for the full data model (2.3), migration 001, `createTestDb()` + seeds.
- First API descriptor (`courses.api.ts`) + `bun run generate` producing a typed TS client — proves the codegen loop end-to-end.
- **Importer for the v1 export JSON** — 20 real courses in the DB from day one; single-tee holes map to one default tee, hand-placed green points become provisional green centers.
- Exit criteria: `bun run import` populates DB; `GET /courses` returns them; generated TS client compiles.

### Phase 1 — Server core
- CRUD for courses/holes/tees/greens/pins/aim points/features/clubs/game plans; device auth; validation.
- Geometry handling: projected-CRS storage, WGS84 GeoJSON materialization, elevation sampling endpoint backed by terrain tiles (with cache).
- Asset upload + static tile serving with cache headers.
- Course publish/revision mechanics.
- Exit criteria: full API green in integration tests against imported data.

### Phase 2 — Tile pipeline
- Scripts: GeoTIFF → COG → ortho XYZ tiles; DEM → terrain-RGB tiles; manifest + upload CLI.
- Reuse/port `py-filer` QGIS scripts for Lantmäteriet orthophoto acquisition; document the QGIS → pipeline workflow.
- Run for the home course (assets already exist in golf-map-2: `orto_21_inner.jpg` source data + LiDAR DEM).
- Exit criteria: MapLibre demo page shows ortho + terrain tiles for one real course.

### Phase 3 — Web app: course builder MVP
- Measurement tools in the editor canvas: point-to-point / multi-segment distance with **height difference and plays-like** (heights decoded from Terrain-RGB tiles client-side), per-segment readouts.
- **Green height & slope maps**: per-green analysis overlay — sample the DEM over the green polygon, compute gradient → slope magnitude (%) and aspect (fall direction), render as heat map + fall-line arrows (port concepts from golf-map-2's green analysis / slope vertex coloring).
- **Green surrounds analysis**: same height/slope overlay extended to a configurable buffer around the green (10–30 m) for aim-point strategy ("flat right side, hollow left side"). Green boundary must remain unmistakable: bold outline, full-strength overlay inside vs desaturated/hatched outside. Include a height-relative-to-green ramp (and/or curvature shading) so hollows/run-off bowls ("gropar") read as shapes, not just steep edges.
- App shell, auth, course list; MapLibre editor canvas with ortho tiles.
- Feature drawing: polygon/Bezier tools for all feature types; snapping; per-hole assignment.
- Tees (all sets), pins (multiple, named), aim points with ordering; elevation auto-sampled.
- SVG import with georeferencing (unlocks migrating golf-map-2's traced home course).
- Exit criteria: build a complete 18-hole course end-to-end in the web app; publish it.

### Phase 4 — iOS app MVP (on-course)
- SwiftUI app: course list, offline bundle download, MapLibre Native rendering of ortho + features.
- Live GPS distances (front/center/back/pin/hazards/aim points), plays-like from terrain tiles.
- Swift OpenAPI client; revision-based sync.
- Exit criteria: play a full round at the home course, airplane mode, everything works.
- **STATUS (2026-07-05): built and simulator-verified.** All batches landed (scaffold → API/Geo/Store → Map/Screens/sync → on-course screen); 174 tests green. Live-verified on simulator: real 405 MB Landeryd bundle download, offline relaunch fully functional (unreachable-server launch renders map + GPS distances from local bundle), distances match independent computation to the meter across GPS moves and holes. **Remaining for exit criterion: a real round on a physical device** (needs Xcode device provisioning + walking the course). Data gaps found (course data, not app): all `strokeIndex` NULL, only one pin exists (inactive), aim-point labels empty, non-default tees on few holes — fill in the web builder before/while playing the verification round.

### Phase 5 — Strategy planning (web + phone)
- Port v1 club/wind/dispersion math into `shared/` (one implementation, tested).
- Web: full plan editor (per tee, per hole, shot sequence, dispersion overlays, wind scenarios).
- iOS: plan viewing on course + light edits; plan-vs-reality display.
- Exit criteria: plan built on web is the on-course guidance on the phone.

### Phase 6 — 3D & advanced building
- Port golf-map-2's Three.js terrain + adaptive tessellation into the web app (per-course 3D view, green slope analysis).
- Green reading view (slope arrows/heat), bunker bowl rendering.
- Optional: SAM-assisted feature segmentation from orthophoto.

### Phase 7 — Follow-up & data collection
- iOS: in-round shot logging (tap position + club).
- Web: rounds dashboard — club distance distributions (recalibrate club carries from data), dispersion actuals vs planned, strokes-gained-style hole analysis.
- Feedback loop: measured club data updates dispersion ellipses.

---

## 4. Key decisions (made) & open questions

**Decided**
- Server built on `@basics/core` (mackans-client-fw): Bun + Hono + Kysely + SQLite + TypeBox, descriptor APIs, framework codegen for the web client.
- iOS client generation bridged from the same descriptors — working assumption: emit OpenAPI (TypeBox is JSON Schema) → swift-openapi-generator; finalize end of Phase 1.
- Projected-CRS canonical geometry + per-course georeference; WGS84 derived.
- Terrain-RGB tiles as the single elevation format for web + iOS.
- MapLibre on both web and iOS; Three.js only for the web 3D view.
- Bezier/B-spline native feature geometry (from golf-map-2), flattened GeoJSON for consumption.
- Rounds/shots schema included from Phase 0 even though UI lands in Phase 7.

**Decided (2026-07-04)**
- Web app framework: **@basics/core client** (React rejected — consistency + signals suit the editor; golf-map-2's R3F 3D view will be rewritten in plain Three.js in Phase 6).

**Decided (2026-07-05, Phase 4 kickoff)**
- iOS Swift client: **hand-written thin client** (see 2.2b — OpenAPI emission prototyped and rejected).
- iOS persistence: **GRDB** for furniture + bundle metadata (plain SQLite mirrors the server model, ready for Phase 7 shot logging). Tiles and features.geojson stored as **plain files** in the per-course bundle directory — MapLibre `file://` tile URL templates read them directly.
- iOS device auth: **cookie session as-is** + credentials in Keychain + automatic re-login on 401. No server/framework changes; on-course play is fully offline, auth only matters during sync. Long-lived device token deferred to Phase 7 (first phase that pushes data).
- iOS map: **MapLibre Native iOS** (SPM `maplibre-gl-native-distribution` 6.27.x) with a thin `UIViewRepresentable`; per-course raster sources use `file://` tile templates into the app-managed bundle store (no MLNOfflineStorage packs/ambient cache — opaque store, wrong keying). Course features rendered as runtime style layers from one `MLNShapeSource` with data-driven per-type colors; dynamic elements (distance lines, GPS) in separate shape sources. Known traps: never create `MLNMapView` with a zero frame (Metal crash); pause rendering when backgrounded.
- iOS project generation: **XcodeGen** (`ios/project.yml` committed, generated `.xcodeproj` gitignored).

**Open (decide when reached)**
- Tile pre-generation only vs on-demand (titiler-style) — start pre-generated static, revisit if courses multiply.
- Non-Swedish courses: DEM/ortho sources per country (Phase 2 keeps pipeline input generic GeoTIFF, so this is acquisition, not architecture).
- Multi-user/sharing — schema allows users; auth stays device-key until needed.
