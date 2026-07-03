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
