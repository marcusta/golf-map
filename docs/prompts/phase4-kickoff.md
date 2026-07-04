# Phase 4 kickoff prompt

Start Phase 4 of the golf-map project: the **iOS on-course app**.

## Context

Repo: `/Users/marcust/dev/github/golf-map`. Read `ROADMAP.md` first (Phase 4 + sections 2.2b and 2.7), then `README.md`. Phases 0–3 are complete and committed:

- **Server** (`server/`): Bun + `@basics/core` (Marcus's framework at `/Users/marcust/dev/github/mackans-client-fw`), SQLite source of truth, cookie-session auth, descriptor APIs with generated TS clients in `shared/api/`. 254 tests.
- **Tile pipeline** (`pipeline/`): Lantmäteriet STAC lidar + ortho (credentials in gitignored `.env`), Terrain-RGB terrain tiles z12–17 (0.5 m lidar DEM) + ortho z14–20, served at `/tiles/{courseId}/{layer}/{z}/{x}/{y}.{png|jpg}?v=<version>`.
- **Web course builder** (`web/`): full editor. Landeryd Masters (id `26D37361-D79C-41AA-AA49-92F2C2277222`) is completely built — 687 vector features, tees/pins/aim points/green C-F-B points, published at revision 2+. 364 tests.

## Phase 4 goal

ROADMAP exit criterion: **"play a full round at the home course, airplane mode, everything works."**

Scope:
1. `ios/` — new SwiftUI app (Xcode project inside the monorepo).
2. **Swift API client** — implement the ROADMAP 2.2b bridge decision: preferred = emit OpenAPI from the server's TypeBox descriptors (TypeBox IS JSON Schema; input schemas exist on every descriptor, response schemas need deriving or annotating) → Apple's swift-openapi-generator. Fallback: hand-written thin client (the iOS surface is small and read-mostly). Evaluate honestly, pick, document in ROADMAP.
3. **Device auth** — server has cookie sessions (`marcus`/`change-me` exists); ROADMAP mentions a long-lived device-token variant. Decide; small server changes allowed.
4. **Offline course bundle** — download per course keyed by **revision** (the publish counter): vector features (use `GET /features.geojson?courseId=` — server-derived WGS84, do NOT reimplement geometry flattening), furniture (tees/pins/aims/greens incl. stroke index + par), ortho + terrain tiles for the course bbox, tile manifest. Local store: GRDB/SQLite recommended over SwiftData (roadmap open question — decide + document).
5. **Map rendering** — MapLibre Native iOS preferred (same tiles as web); MapKit + MKTileOverlay fallback if MapLibre fights. Prior MapKit experience: the v1 app at `/Users/marcust/dev/golf-course-map/GolfCourseMap` (also the domain reference for distances UX and later wind/club math).
6. **On-course features** (v1 parity, then better): live GPS distances to green Front/Center/Back + active pin + hazards/aim points; plays-like from terrain (decode Terrain-RGB: `height = -10000 + (R*65536 + G*256 + B) * 0.1`); hole navigation; hole info (par, stroke index, per-tee lengths).
7. **Sync** — pull published courses, compare revision, re-download bundle when bumped. Nothing pushes in this phase (round/shot logging is Phase 7).

## Key technical facts

- Run server: `cd server && bun run dev:server` (port 3000, DB `data/app.sqlite`). Endpoints in `server/api/*.api.ts` — flat paths, query params on GET, `requireAuth()` on everything EXCEPT `/tiles/*` (unauthenticated by design).
- Tiles have immutable 1-year cache headers — always include `?v=` from the course's `tile_manifest` asset `metaJson.generatedAt`.
- CORP headers are a browser concern — irrelevant to native iOS.
- Landeryd Classic (`7CE5653E-5900-446A-8324-E527B95CB10F`) shares Masters' tiles via symlink; its DEM/analysis assets point at Masters' data.
- Simulator GPS: `xcrun simctl location <device> set 58.357,15.722` puts you on Landeryd. Check Xcode availability first (`xcodebuild -version`); if no Xcode on this machine, say so and stop rather than improvising.

## Working conventions (established phases 0–3)

- Orchestrate with sub-agents: **Fable for demanding tasks** (architecture, novel/cross-stack), **Opus for well-specified ones**. Parallel agents only with strict per-agent file ownership; review results between batches.
- Every piece gets unit tests AND live verification (simulator screenshots for UI) before being called done. Honest reporting — failed/skipped things are said plainly.
- Commit at reviewed milestones, descriptive messages, never Co-Authored-By.
- Don't modify `mackans-client-fw` unless the task is explicitly about the framework (golf-map consumes it via bun `file:` — after any framework change run `bun install --force` in golf-map).
- Record decisions in ROADMAP.md as they're made.

## Suggested opening move

Recon batch (parallel, read-only): (a) inventory the exact API surface + bundle contents iOS needs (endpoints, shapes, revision mechanics); (b) prototype the OpenAPI emission from descriptors and evaluate swift-openapi-generator output vs a thin hand-written client; (c) assess MapLibre Native iOS today (SPM integration, raster + raster-dem offline support, custom tile servers). Then plan the build batches and go.
