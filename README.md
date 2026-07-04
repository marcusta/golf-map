# golf-map

A ground-up rebuild of the golf course map system: server (course data, game plans, round data,
tile + asset serving), web app (course building, strategy planning, follow-up analytics), and an
iOS app (on-course GPS + light strategy planning).

See [ROADMAP.md](./ROADMAP.md) for the full architecture plan, prior-art inventory, and phased
build-out.

## Status

**Phase 0 (Foundation) and Phase 1 (Server core) are complete.**

- Server scaffolded on `@basics/core` (mackans-client-fw): Bun + Hono + Kysely + SQLite, cookie-session
  auth, structured logging, request tracing.
- 16-table Kysely schema covering courses, holes, tees, greens, pins, aim points, course features,
  clubs, game plans, rounds, assets, and framework tables (users, sessions, observability).
- 12 feature APIs (`server/api/*.api.ts`) mounted under `/api`, each with a matching Kysely-backed
  service and test suite.
- Codegen'd, fully-typed TS clients in `shared/api/` (one `.gen.ts` per feature), produced by
  `bun run generate` from the API descriptors — no hand-written client code.
- The v1 iOS export has been imported into the real database: **20 courses, 326 holes, 13 clubs,
  18 game plans**. A user `marcus` exists for local development.
- 223 tests green (`bun test`), both server and test tsconfigs typecheck clean.

Not yet built: tile pipeline (Phase 2), web app (Phase 3), iOS app (Phase 4+). `web/` is currently a
placeholder.

## Repo layout

```
server/   Bun + Hono + Kysely + SQLite, built on @basics/core (mackans-client-fw)
web/      Vite + TS web app (placeholder — filled in a later phase)
shared/   Generated API clients (shared/api/*.gen.ts), shared strategy math, JSON schemas
data/     SQLite databases (gitignored) — app.sqlite, sessions.sqlite, obs.sqlite
```

`server/` depends on `@basics/core` via a local `file:` dependency pointing at the sibling
`mackans-client-fw` repo (`../../mackans-client-fw/core`). That repo must be checked out alongside
this one at `/Users/marcust/dev/github/mackans-client-fw`.

All `server/package.json` scripts assume **`server/` as the working directory** (`bun run <script>`
runs with cwd = the package dir). They set `DB_PATH`/`SESSION_DB_PATH`/`OBS_DB_PATH` explicitly so
they resolve to the shared `../data/` directory at the repo root rather than creating a second,
empty `server/data/`.

## Auth model

Cookie-session auth via `@basics/core`'s `SessionStore` / `requireAuth()` middleware. Sessions are
stored in `data/sessions.sqlite` (separate from the app DB), with per-username rate limiting on
login. There is no self-serve signup endpoint — users are provisioned with the `create-user` CLI
(below). `POST /api/auth/login` sets the session cookie; authenticated requests must send it.
Tile routes (`/tiles/...`) are deliberately unauthenticated — map clients fetch tiles directly.

## Where data lives

- `data/app.sqlite` — the application database (courses, holes, game plans, users, etc.), WAL mode.
- `data/sessions.sqlite` — session store.
- `data/obs.sqlite` — observability bulkhead (traces, events).

All three are gitignored (`data/*.sqlite*`). There is nothing to seed from scratch in normal
development — the real DB already has the imported v1 data; `bun run import` refuses to run again
once courses exist (pass `--force` to wipe and re-import).

## Getting started

```bash
bun install
```

```bash
cd server
bun run dev:server      # starts the API on :3000, watches for changes
bun run create-user <username> <password>   # provision a login (only needed once)
bun run import          # imports the v1 JSON export (already done for data/app.sqlite)
bun run generate        # regenerates shared/api/*.gen.ts from the API descriptors
```

`GET /api/health` and `GET /api/meta` should respond once the server is up.

Type-check and test:

```bash
cd server
bun run check:server
bun run check:test
bun test
```

## Phase 2 demo

Exit criteria (see [ROADMAP.md](./ROADMAP.md) Phase 2): *"MapLibre demo page shows ortho + terrain
tiles for one real course."* `web/demo/` is a throwaway, self-contained static page — CDN MapLibre
GL JS only, no build step, no dependencies — showing the Landeryd Masters orthophoto and
Terrain-RGB terrain tiles served by `server/`. It is not the Phase 3 web app.

Run the server and the demo in two terminals:

```bash
cd server && bun run dev:server   # API + tiles on :3000
cd web && bun run demo            # demo page on :5180
```

Open http://localhost:5180. You should see: real orthophoto imagery of the Landeryd golf course
(fairways, greens, bunkers, treelines) rendered in 3D with terrain displacement and pitch/bearing
camera controls, a "Terrain" toggle that flattens/restores the 3D relief, a "Hillshade" toggle that
overlays terrain shading, a mouse-position elevation readout (via `queryTerrainElevation`), and the
"© Lantmäteriet, CC BY 4.0" attribution in the bottom-right corner.

`web/demo/serve.ts` (plain `Bun.serve`, no dependencies) serves the static page and proxies
`/tiles/*` requests to the API server on :3000. This proxy exists because MapLibre loads raster and
raster-dem tiles as WebGL textures, which requires the browser's Cross-Origin-Resource-Policy (CORP)
check to pass — not just CORS. `@basics/core`'s `createApp()` applies Hono's `secureHeaders()`
globally, which sets `Cross-Origin-Resource-Policy: same-origin` on every response (tiles included)
*after* route handlers run, so it can't be overridden per-route from `server/services/tiles.ts`.
Serving the demo and proxying tiles through the same origin (:5180) sidesteps this without touching
shared framework code. (Tile CORS itself, `Access-Control-Allow-Origin`, is already permissive by
default via `CORS_ORIGIN=*` — only CORP was the blocker.)
