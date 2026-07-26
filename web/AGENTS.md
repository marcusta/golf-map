# web — AGENTS

Vite + TS SPA on `@basics/core` client framework, MapLibre for maps. Course building (SVG/vector), strategy planning, follow-up analytics. Run with **cwd = `web/`**.

## Framework

`@basics/core/client` — DI container (`di.get`), signals/`effect` (push-based, eager — see below), `Router`, components. Conventions:
- `*.component.ts` — view components. `*.service.ts` — injectable state/logic (+ `*.tool.service.ts` for editor tools).
- Entry `src/main.ts` → `startApp(AppComponent, '#app')`. `src/api.ts` wires `shared/api/*.gen.ts` typed clients (base `/api`).

⚠️ Signals are eager/push-based; derived-geometry effects can fire on mixed intermediate state. Coalesce side effects with `queueMicrotask`.

⚠️ A component spawned inside a parent's `render()` runs its `onMount` while its host is still inside a **detached template clone** (`ownerDocument` = an inert `about:blank` document). Never hand such a host to a library that binds document-level listeners at construction — MapLibre puts a drag's mousemove/mouseup there, so the map's clicks work while every drag is silently dead. `MapService.init` waits for the host to join the live document; do the same for anything similar.

The package is a versioned tarball in `vendor/` — never edit `node_modules/@basics/core`, never repoint the dep string. See root [AGENTS.md](../AGENTS.md) for `fw:update` / `bun link`. After either, restart the dev server (`rm -rf node_modules/.vite` if you hit `does not provide an export named ...`). `bunfig.toml` preloads the package's own happy-dom adapter (`@basics/core/happy-dom`); there is no local shim.

## Layout (`src/`)

`app/` shell · `auth/` login+guard · `courses/` list · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction) · `geo/` (bezier, bspline, transform) · `furniture/`.

## Commands (cwd `web/`)

```sh
bun run dev          # vite dev server :5173, proxies /api + /tiles → :3000 (server must run)
bun test             # tests (happy-dom); mirrors in tests/
bun run check:client # typecheck
```

Prefer the `preview_*` tools to verify UI changes over asking the user to check.

Testing: integration-first, no mocks, units only for hard algorithms. See root [TESTING.md](../TESTING.md).
